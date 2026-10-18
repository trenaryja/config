import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import * as R from 'remeda'
import { z } from 'zod'
import type { Cell } from './audit.ts'
import { findConsumers, GIT } from './discover.ts'

const CACHE = '/tmp/eslint-verify.json'

/**
 * Type-aware lint holds the whole program: one trivial ui file costs ~1.3 GB, one googleapis file ~3.2 GB (measured 2026-10-18)
 * - a chunk over the cap is split in half; a single file gets the higher cap, and past it is reported unlinted, never as clean
 * - repos run one at a time: four in parallel took the machine past 10 GB
 */
const CAP_KB = {
	chunk: Number(Bun.env.VERIFY_CHUNK_KB ?? 2_000_000),
	file: Number(Bun.env.VERIFY_FILE_KB ?? 4_000_000),
}
const LINTED = /\.[cm]?[jt]sx?$/

const lintResults = z.array(
	z.object({
		filePath: z.string(),
		messages: z.array(z.object({ ruleId: z.string().nullable(), line: z.number(), message: z.string() })),
	}),
)

const hitSchema = z.object({
	repo: z.string(),
	file: z.string(),
	line: z.number(),
	rule: z.string(),
	message: z.string(),
})
type Hit = z.infer<typeof hitSchema>

const scanSchema = z.object({
	repo: z.string(),
	baseline: z.array(hitSchema),
	working: z.array(hitSchema),
})
type Scan = z.infer<typeof scanSchema>

const findEslint = (dir: string): string | undefined => {
	const bin = join(dir, 'node_modules/.bin/eslint')
	if (existsSync(bin)) return bin
	return dir === dirname(dir) ? undefined : findEslint(dirname(dir))
}

/** RSS of a process and every descendant */
const treeRss = (root: number) => {
	const rows = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,rss='])
		.stdout.toString()
		.trim()
		.split('\n')
		.map((line) => line.trim().split(/\s+/).map(Number))
	const tree = new Set([root])
	for (let grew = true; grew;) {
		grew = false
		for (const [pid = 0, ppid = 0] of rows)
			if (tree.has(ppid) && !tree.has(pid)) {
				tree.add(pid)
				grew = true
			}
	}
	return {
		kb: R.sumBy(
			rows.filter(([pid = 0]) => tree.has(pid)),
			([, , rss = 0]) => rss,
		),
		pids: [...tree],
	}
}

type Batch = { cwd: string; files: readonly string[]; working: boolean; flags: readonly string[] }

/** `undefined` = killed at the cap */
const runEslint = async ({ cwd, files, working, flags }: Batch, capKb: number) => {
	const bin = findEslint(cwd)
	if (!bin) throw new Error(`${cwd}: no node_modules/.bin/eslint at or above it; run bun install there`)
	// consumers install from npm -> `working` preloads a swap so their eslint loads this repo's eslint.js
	const preload = working ? ['--preload', `${import.meta.dir}/swap-eslint.ts`] : []
	const proc = Bun.spawn(['bun', ...preload, bin, '--format', 'json', '--no-warn-ignored', ...flags, ...files], {
		cwd,
		stdout: 'pipe',
		stderr: 'ignore',
	})
	const watch = { killed: false }
	const watchdog = setInterval(() => {
		const { kb, pids } = treeRss(proc.pid)
		if (kb <= capKb) return
		watch.killed = true
		for (const pid of pids) process.kill(pid, 'SIGKILL')
	}, 200)
	const stdout = await new Response(proc.stdout).text()
	clearInterval(watchdog)
	return watch.killed ? undefined : lintResults.parse(JSON.parse(stdout.slice(stdout.indexOf('['))))
}

const lintSplit = async (batch: Batch): Promise<{ results: z.infer<typeof lintResults>; unlinted: string[] }> => {
	const single = batch.files.length === 1
	const results = await runEslint(batch, single ? CAP_KB.file : CAP_KB.chunk)
	if (results) return { results, unlinted: [] }
	if (single) return { results: [], unlinted: [...batch.files] }
	const [head, tail] = R.splitAt(batch.files, Math.ceil(batch.files.length / 2))
	const [a, b] = [await lintSplit({ ...batch, files: head }), await lintSplit({ ...batch, files: tail })]
	return { results: [...a.results, ...b.results], unlinted: [...a.unlinted, ...b.unlinted] }
}

const UNLINTED = '<unlinted>'

/** each eslint config lints from its own dir: the config reads tsconfig, .gitignore and package.json from cwd */
const lint = async (repo: string, working: boolean, ...flags: string[]) => {
	const root = `${GIT}/${repo}`
	const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: root }).stdout.toString().split('\n').filter(Boolean)
	const configDirs = R.sortBy(
		tracked.filter((file) => /(^|\/)eslint\.config\.[cm]?[jt]s$/.test(file)).map((file) => dirname(file)),
		[(dir) => dir.length, 'desc'],
	)
	const owner = (file: string) => configDirs.find((dir) => dir === '.' || file.startsWith(`${dir}/`))
	const hits: Hit[] = []
	for (const dir of configDirs) {
		const cwd = join(root, dir)
		const files = tracked.filter((file) => LINTED.test(file) && owner(file) === dir).map((file) => relative(dir, file))
		const { results, unlinted } = files.length
			? await lintSplit({ cwd, files, working, flags })
			: { results: [], unlinted: [] }
		hits.push(
			...results.flatMap((result) =>
				result.messages.map((message): Hit => ({
					repo,
					file: relative(root, result.filePath),
					line: message.line,
					rule: message.ruleId ?? '<directive>',
					message: message.message,
				})),
			),
			...unlinted.map((file): Hit => ({
				repo,
				file: join(dir, file),
				line: 0,
				rule: UNLINTED,
				message: `over ${CAP_KB.file} KB RSS`,
			})),
		)
	}
	return hits
}

// Most consumers not green today -> raw counts are noise; only the diff vs the installed config means anything
const scanRepo = async (repo: string) => ({
	repo,
	baseline: await lint(repo, false, '--report-unused-disable-directives'),
	// the working config sets noInlineConfig, so this is also every hit a disable was hiding
	working: await lint(repo, true),
})

export const scan = async (onProgress?: (done: number, total: number) => void) => {
	const consumers = await findConsumers()
	console.log(`Scanning ${consumers.length} consumers: ${consumers.join(', ')}\n`)
	const out: Scan[] = []
	onProgress?.(0, consumers.length)

	for (const repo of consumers) {
		const result = await scanRepo(repo)
		console.log(`  ${repo}: ${result.working.length} live`)
		out.push(result)
		onProgress?.(out.length, consumers.length)
	}

	await Bun.write(CACHE, JSON.stringify(out, null, 2))
	console.log(`\nCached to ${CACHE}`)
}

const cache = Bun.file(CACHE)

export const loadScans = async () => ((await cache.exists()) ? z.array(scanSchema).parse(await cache.json()) : [])

export const scannedAt = async () => ((await cache.exists()) ? new Date(cache.lastModified) : undefined)

const key = (hit: Hit) => `${hit.repo}/${hit.file}:${hit.line}:${hit.rule}`

/** live hits under the working config, `(new)` where the installed one was quiet */
export const lintCell = (result: Scan): Cell => {
	const [before, after] = [new Set(result.baseline.map(key)), new Set(result.working.map(key))]
	return {
		path: 'eslint.js (working copy)',
		residue: result.working.map(
			(hit) => `${hit.file}:${hit.line} ${hit.rule}${before.has(key(hit)) ? '' : ' (new)'}\n${hit.message}`,
		),
		notes: result.baseline
			.filter((hit) => !after.has(key(hit)))
			.map((hit) => `silenced: ${hit.file}:${hit.line} ${hit.rule}`),
		raw: '',
	}
}

const report = async () => {
	const data = await loadScans()
	const baseline = data.flatMap((x) => x.baseline)
	const after = data.flatMap((x) => x.working)
	const [beforeKeys, afterKeys] = [new Set(baseline.map(key)), new Set(after.map(key))]
	const added = after.filter((hit) => hit.rule !== '<directive>' && !beforeKeys.has(key(hit)))
	const removed = baseline.filter((hit) => hit.rule !== '<directive>' && !afterKeys.has(key(hit)))
	const unused = baseline.filter((hit) => hit.message.includes('Unused eslint-disable'))
	const live = after.filter((hit) => hit.rule !== '<directive>')

	console.log(`## New errors the working config introduces — ${added.length}\n`)
	for (const hit of added) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.rule}\n      ${hit.message}`)

	console.log(`\n## Errors the working config silences — ${removed.length}\n`)
	for (const hit of removed) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.rule}`)

	console.log(`\n## Now-redundant disables — ${unused.length}\n`)
	for (const hit of unused) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.message}`)

	console.log(`\n## Working-config hits by rule, disables ignored — ${live.length} total\n`)
	const byRule = R.pipe(
		live,
		R.groupBy((hit) => hit.rule),
		R.entries(),
		R.sortBy([([, hits]) => hits.length, 'desc']),
	)
	for (const [rule, hits] of byRule)
		console.log(
			`  ${String(hits.length).padStart(3)}  ${rule}  (${[...new Set(hits.map((hit) => hit.repo))].join(', ')})`,
		)
}

const rule = async (ruleId: string) => {
	const hits = (await loadScans()).flatMap((x) => x.working).filter((hit) => hit.rule === ruleId)
	console.log(`## ${ruleId} — ${hits.length} violations with every inline disable ignored\n`)
	for (const hit of hits) console.log(`  ${hit.repo}/${hit.file}:${hit.line}\n      ${hit.message}`)
}

export const verify = async ([command, argument]: readonly string[]) => {
	if (command === 'scan') await scan()
	else if (command === 'report') await report()
	else if (command === 'rule' && argument) await rule(argument)
	else console.log('usage: bun fleet verify scan | report | rule <ruleId>')
}
