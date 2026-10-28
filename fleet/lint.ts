import { statSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import * as R from 'remeda'
import { z } from 'zod'
import { type Finding, location } from '../tren/doctor.ts'
import { ESLINT_FILES } from '../tren/presets.ts'
import { CODE, findUp, git, messageOf, trackedFiles } from '../tren/repo.ts'
import { type Command, dispatch, MISUSE } from '../tren/run.ts'
import type { Cell } from './audit.ts'
import { envNumber, findConsumers, GIT } from './discover.ts'
import { redundant } from './redundant.ts'

const CACHE = Bun.env.FLEET_LINT_CACHE ?? '/tmp/eslint-fleet-lint.json'
const DIRECTIVE = '<directive>'
const LINT_PATH = 'eslint.js (working copy)'

/** type-aware lint holds the whole program (measured 2026-10-18: one trivial ui file ~1.3 GB, one googleapis file ~3.2 GB); four repos in parallel took the machine past 10 GB */
const CAP_KB = {
	get chunk() {
		return envNumber('LINT_CHUNK_KB', 2_000_000)
	},
	get file() {
		return envNumber('LINT_FILE_KB', 4_000_000)
	},
}

const lintResults = z.array(
	z.object({
		filePath: z.string(),
		// a fatal parse error carries no position
		messages: z.array(
			z.object({
				ruleId: z.string().nullable(),
				line: z.number().optional(),
				column: z.number().optional(),
				message: z.string(),
			}),
		),
	}),
)

const hitSchema = z.object({
	check: z.string(),
	path: z.string(),
	line: z.number().optional(),
	column: z.number().optional(),
	message: z.string(),
})

const scanSchema = z.object({
	repo: z.string(),
	baseline: z.array(hitSchema),
	working: z.array(hitSchema),
})
type Scan = z.infer<typeof scanSchema>

const treeRss = (root: number) => {
	const rows = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss='])
		.stdout.toString()
		.trim()
		.split('\n')
		.map((line) => {
			const [pid = 0, ppid = 0, rss = 0] = line.trim().split(/\s+/).map(Number)
			return { pid, ppid, rss }
		})
	const family = (pid: number): number[] => [
		pid,
		...rows.filter((row) => row.ppid === pid).flatMap((row) => family(row.pid)),
	]
	const pids = family(root)
	return {
		kb: R.sumBy(
			rows.filter((row) => pids.includes(row.pid)),
			(row) => row.rss,
		),
		pids,
	}
}

type Batch = { cwd: string; files: readonly string[]; working: boolean; flags: readonly string[] }

/** `undefined` = killed at the cap */
const runEslint = async ({ cwd, files, working, flags }: Batch, capKb: number) => {
	const eslintPath = findUp(cwd, 'node_modules/.bin/eslint')
	if (!eslintPath) throw new Error(`${cwd}: no node_modules/.bin/eslint at or above it; run bun install there`)
	/** consumers install from npm -> `working` swaps in this repo's eslint.js; node, as consumers' eslint shebang runs: bun peaks 2.8GB where node peaks 1.6GB (health/apps/web) */
	const swap = working ? ['--import', `${import.meta.dir}/swap-eslint.ts`] : []
	const proc = Bun.spawn(['node', ...swap, eslintPath, '--format', 'json', '--no-warn-ignored', ...flags, ...files], {
		cwd,
		stderr: 'ignore',
	})
	const watch = { killed: false }
	const watchdog = setInterval(() => {
		const { kb, pids } = treeRss(proc.pid)
		if (kb <= capKb) return
		watch.killed = true
		for (const pid of pids)
			try {
				process.kill(pid, 'SIGKILL')
			} catch {
				// ESRCH: the process exited between ps and kill
			}
	}, 200)
	const stdout = await proc.stdout.text()
	clearInterval(watchdog)
	return watch.killed ? undefined : lintResults.parse(JSON.parse(stdout.slice(stdout.indexOf('['))))
}

const lintSplit = async (batch: Batch): Promise<{ results: z.infer<typeof lintResults>; unlinted: string[] }> => {
	const single = batch.files.length === 1
	const results = await runEslint(batch, single ? CAP_KB.file : CAP_KB.chunk)
	if (results) return { results, unlinted: [] }
	if (single) return { results: [], unlinted: [...batch.files] }
	const [head, tail] = R.splitAt(batch.files, Math.ceil(batch.files.length / 2))
	const [left, right] = [await lintSplit({ ...batch, files: head }), await lintSplit({ ...batch, files: tail })]
	return { results: [...left.results, ...right.results], unlinted: [...left.unlinted, ...right.unlinted] }
}

/** each eslint config lints from its own dir: the config reads tsconfig, .gitignore and package.json from cwd */
const lintRepository = async (repository: string, working: boolean, ...flags: readonly string[]) => {
	const root = `${GIT}/${repository}`
	const tracked = trackedFiles(root)
	const configDirectories = R.sortBy(
		tracked.filter((file) => ESLINT_FILES.includes(basename(file))).map((file) => dirname(file)),
		[(directory) => directory.length, 'desc'],
	)
	const owner = (file: string) =>
		configDirectories.find((directory) => directory === '.' || file.startsWith(`${directory}/`))
	const hits: Finding[] = []
	for (const directory of configDirectories) {
		const cwd = join(root, directory)
		const files = tracked
			.filter((file) => CODE.test(file) && owner(file) === directory)
			.map((file) => relative(directory, file))
		const { results, unlinted } = files.length
			? await lintSplit({ cwd, files, working, flags })
			: { results: [], unlinted: [] }
		hits.push(
			...results.flatMap((result) =>
				result.messages.map((message) => ({
					check: message.ruleId ?? DIRECTIVE,
					path: relative(root, result.filePath),
					line: message.line,
					column: message.column,
					message: message.message,
				})),
			),
			...unlinted.map((file) => ({
				check: '<unlinted>',
				path: join(directory, file),
				message: `over ${CAP_KB.file} KB RSS`,
			})),
		)
	}
	return hits
}

export const scan = async (onProgress?: (done: number, total: number) => void) => {
	const consumers = await findConsumers()
	console.error(
		`Scanning ${consumers.length} consumers (RSS caps ${CAP_KB.chunk} KB per chunk, ${CAP_KB.file} KB per file): ${consumers.join(', ')}\n`,
	)
	const out: Scan[] = []
	onProgress?.(0, consumers.length)

	for (const repository of consumers) {
		/** most consumers aren't green today: raw counts are noise, only the diff vs the installed config means anything */
		const result = {
			repo: repository,
			baseline: await lintRepository(repository, false, '--report-unused-disable-directives'),
			working: await lintRepository(repository, true, '--no-inline-config'),
		}
		console.log(`  ${repository}: ${result.working.length} live`)
		out.push(result)
		onProgress?.(out.length, consumers.length)
	}

	const temp = `${CACHE}.${process.pid}.tmp`
	await Bun.write(temp, JSON.stringify(out, null, 2))
	await rename(temp, CACHE)
	console.log(`\nCached to ${CACHE}`)
	return 0
}

/** a fresh handle each time: a handle made at import would keep serving the mtime it first read */
const cache = () => Bun.file(CACHE)

/** `size` is 0 for a missing file and an empty one alike (mktemp makes one): neither was ever scanned */
const loadScans = async () => {
	if (!cache().size) throw new Error(`never linted: no ${CACHE}; run bun fleet lint scan`)
	const parsed = z.array(scanSchema).safeParse(
		await cache()
			.json()
			.catch(() => null),
	)
	if (!parsed.success) throw new Error(`stale: ${CACHE} is not in the current format; run bun fleet lint scan`)
	return parsed.data
}

export const scannedAt = () => (cache().size ? new Date(cache().lastModified) : undefined)

/** a rule switched on since the scan reads as 0 hits, not as unscanned */
const freshScans = async () => {
	const scans = await loadScans()
	if (Bun.file(`${import.meta.dir}/../eslint.js`).lastModified > cache().lastModified)
		throw new Error(`stale: ${CACHE} predates eslint.js; run bun fleet lint scan`)
	return scans
}

const key = (hit: Finding & { repo?: string }) =>
	`${hit.repo ?? ''}/${hit.path}:${hit.line}:${hit.column}:${hit.check}:${hit.message}`

const lintCell = (residue: Finding[], notes: Finding[] = []): Cell => ({ path: LINT_PATH, residue, notes, raw: '' })

const scanCell = (result: Scan) => {
	const [before, after] = [new Set(result.baseline.map(key)), new Set(result.working.map(key))]
	return lintCell(
		result.working.map((hit) => ({
			...hit,
			message: `${hit.check}: ${hit.message}${before.has(key(hit)) ? '' : ' (new)'}`,
		})),
		result.baseline
			.filter((hit) => !after.has(key(hit)))
			.map((hit) => ({ ...hit, message: `silenced: ${hit.check}`, hold: true as const })),
	)
}

const unlint = (message: string) => lintCell([{ check: 'lint', path: LINT_PATH, message }])

/** a consumer's lint cell, or the reason it has none: a cache that is missing, stale or old-format never reads as clean */
export const lintCells = async (consumers: readonly string[]) => {
	const scans = await freshScans().catch(messageOf)
	return (repository: string) => {
		if (!consumers.includes(repository)) return
		if (typeof scans === 'string') return unlint(scans)
		const cached = scans.find((found) => found.repo === repository)
		if (!cached) return unlint(`never linted: ${repository} is not in ${CACHE}; run bun fleet lint scan`)
		const root = `${GIT}/${repository}`
		const changed = Number(git(root, 'log', '-1', '--format=%ct')) * 1000
		// the index moves on every add and checkout, which a commit date alone misses
		const staged =
			statSync(resolve(root, git(root, 'rev-parse', '--git-path', 'index')), { throwIfNoEntry: false })?.mtimeMs ?? 0
		return Math.max(changed, staged) > cache().lastModified
			? unlint(`stale: ${repository} changed after the last scan; run bun fleet lint scan`)
			: scanCell(cached)
	}
}

const tagged = (data: readonly Scan[], side: 'baseline' | 'working') =>
	data.flatMap(({ repo, ...scans }) => scans[side].map((hit) => ({ ...hit, repo })))

const report = async () => {
	const data = await freshScans()
	const baseline = tagged(data, 'baseline')
	const after = tagged(data, 'working')
	const [beforeKeys, afterKeys] = [new Set(baseline.map(key)), new Set(after.map(key))]
	const added = after.filter((hit) => hit.check !== DIRECTIVE && !beforeKeys.has(key(hit)))
	const removed = baseline.filter((hit) => hit.check !== DIRECTIVE && !afterKeys.has(key(hit)))
	const unused = baseline.filter((hit) => hit.message.includes('Unused eslint-disable'))
	const live = after.filter((hit) => hit.check !== DIRECTIVE)

	console.log(`## New errors the working config introduces — ${added.length}\n`)
	for (const hit of added) console.log(`  ${hit.repo}/${location(hit)}  ${hit.check}\n      ${hit.message}`)

	console.log(`\n## Errors the working config silences — ${removed.length}\n`)
	for (const hit of removed) console.log(`  ${hit.repo}/${location(hit)}  ${hit.check}`)

	console.log(`\n## Now-redundant disables — ${unused.length}\n`)
	for (const hit of unused) console.log(`  ${hit.repo}/${location(hit)}  ${hit.message}`)

	console.log(`\n## Working-config hits by rule, disables ignored — ${live.length} total\n`)
	const byRule = R.pipe(
		live,
		R.groupBy((hit) => hit.check),
		R.entries(),
		R.sortBy([([, hits]) => hits.length, 'desc']),
	)
	for (const [rule, hits] of byRule)
		console.log(`  ${String(hits.length).padStart(3)}  ${rule}  (${R.unique(hits.map((hit) => hit.repo)).join(', ')})`)
	return 0
}

const rule = async ([ruleId]: readonly string[]) => {
	if (!ruleId) {
		console.error('bun fleet lint rule: needs a <ruleId>')
		return MISUSE
	}
	const hits = tagged(await freshScans(), 'working').filter((hit) => hit.check === ruleId)
	console.log(`## ${ruleId} — ${hits.length} violations with every inline disable ignored\n`)
	for (const hit of hits) console.log(`  ${hit.repo}/${location(hit)}\n      ${hit.message}`)
	return 0
}

const LINT = {
	scan: {
		about: 'lint every consumer with the installed and the working config, and cache the hits',
		run: () => scan(),
	},
	report: { about: 'what the working config adds, silences and leaves, from the cache', run: report },
	rule: { about: 'every hit of one rule with inline disables ignored, from the cache', args: '<ruleId>', run: rule },
	redundant: { about: 'config entries that resolve the same without them', run: redundant },
} satisfies Record<string, Command>

export const lint = (args: readonly string[]) => dispatch('bun fleet lint', LINT, args)
