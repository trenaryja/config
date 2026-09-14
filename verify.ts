// Consumers install from npm -> fake the install: swap working eslint.js into each consumer's node_modules, lint, revert
import { readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const GIT = dirname(import.meta.dir)
const SELF = basename(import.meta.dir)
const SOURCE = `${import.meta.dir}/eslint.js`
const CACHE = '/tmp/eslint-verify.json'
const CONCURRENCY = 4
const BACKUP = 'eslint.js.verify-bak@'

type Message = { ruleId: string | null; line: number; column: number; message: string; severity: number }

type LintResult = { filePath: string; messages: Message[] }

type Hit = { repo: string; file: string; line: number; rule: string; message: string }

const run = async (cwd: string, cmd: string[]) => {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
	return { stdout: await new Response(proc.stdout).text(), code: await proc.exited }
}

const findConsumers = async () => {
	const entries = await readdir(GIT, { withFileTypes: true })
	const roots = entries.filter((entry) => entry.isDirectory() && entry.name !== SELF).map((entry) => entry.name)
	const found = await Promise.all(
		roots.map(async (name) => {
			const { stdout } = await run(`${GIT}/${name}`, [
				'find',
				'.',
				'-maxdepth',
				'3',
				'-name',
				'package.json',
				'-not',
				'-path',
				'*/node_modules/*',
			])
			const manifests = stdout.split('\n').filter(Boolean)
			const uses = await Promise.all(
				manifests.map(async (path) => (await Bun.file(`${GIT}/${name}/${path}`).text()).includes('@trenaryja/config')),
			)
			return uses.some(Boolean) ? name : null
		}),
	)
	return found.filter((name) => name !== null)
}

// Monorepos hoist unpredictably -> patch every installed copy
const installedConfigs = async (repo: string) => {
	const { stdout } = await run(`${GIT}/${repo}`, [
		'find',
		'.',
		'-path',
		'*/node_modules/@trenaryja/config/package.json',
		'-not',
		'-path',
		'*/node_modules/*/node_modules/*',
	])
	return stdout
		.split('\n')
		.filter(Boolean)
		.map((path) => dirname(`${GIT}/${repo}/${path.slice(2)}`))
}

const installedVersion = async (dir: string): Promise<string> => (await Bun.file(`${dir}/package.json`).json()).version

// Rename, not an in-memory copy -> a killed scan leaves the original on disk for the next revert
const patch = async (dir: string) => {
	await rename(`${dir}/eslint.js`, `${dir}/${BACKUP}${await installedVersion(dir)}`)
	await Bun.write(`${dir}/eslint.js`, Bun.file(SOURCE))
}

// Backup from another version -> a reinstall already replaced eslint.js, so the backup is stale
const revert = async (dir: string) => {
	const version = await installedVersion(dir)
	const backups = (await readdir(dir)).filter((name) => name.startsWith(BACKUP))
	await Promise.all(
		backups.map((name) =>
			name === `${BACKUP}${version}` ? rename(`${dir}/${name}`, `${dir}/eslint.js`) : rm(`${dir}/${name}`),
		),
	)
}

const lint = async (repo: string, ...flags: string[]): Promise<LintResult[]> => {
	const { stdout } = await run(`${GIT}/${repo}`, [
		'bunx',
		'eslint',
		'.',
		'--format',
		'json',
		'--no-warn-ignored',
		'--report-unused-disable-directives',
		...flags,
	])
	const json = stdout.slice(stdout.indexOf('['))

	try {
		return JSON.parse(json)
	} catch {
		return []
	}
}

const toHits = (repo: string, results: LintResult[]): Hit[] =>
	results.flatMap((result) =>
		result.messages.map((message) => ({
			repo,
			file: result.filePath.replace(`${GIT}/${repo}/`, ''),
			line: message.line,
			rule: message.ruleId ?? '<directive>',
			message: message.message,
		})),
	)

const scanRepo = async (repo: string) => {
	const configs = await installedConfigs(repo)
	await Promise.all(configs.map(revert))

	try {
		// Most consumers not green today -> raw counts are noise; only the diff vs this pass means anything
		const baseline = toHits(repo, await lint(repo))

		await Promise.all(configs.map(patch))
		const withDirectives = toHits(repo, await lint(repo))

		// Suppression count says nothing about a rule's worth -> lint with every inline disable ignored
		const naked = toHits(repo, await lint(repo, '--no-inline-config'))

		return { repo, baseline, withDirectives, naked }
	} finally {
		await Promise.all(configs.map(revert))
	}
}

const scan = async () => {
	const consumers = await findConsumers()
	console.log(`Scanning ${consumers.length} consumers: ${consumers.join(', ')}`)
	console.log('Killed mid-scan -> `bun run verify restore`, or the next scan reverts first\n')
	const out: Awaited<ReturnType<typeof scanRepo>>[] = []

	for (let start = 0; start < consumers.length; start += CONCURRENCY) {
		const done = await Promise.all(
			consumers.slice(start, start + CONCURRENCY).map(async (repo) => {
				const result = await scanRepo(repo)
				console.log(`  ${repo}: ${result.withDirectives.length} live, ${result.naked.length} unsuppressed`)
				return result
			}),
		)
		out.push(...done)
	}

	await Bun.write(CACHE, JSON.stringify(out, null, 2))
	console.log(`\nCached to ${CACHE}`)
	return out
}

const load = async (): Promise<Awaited<ReturnType<typeof scanRepo>>[]> => JSON.parse(await Bun.file(CACHE).text())

const key = (hit: Hit) => `${hit.repo}/${hit.file}:${hit.line}:${hit.rule}`

const report = async () => {
	const data = await load()
	const before = new Set(data.flatMap((x) => x.baseline).map(key))
	const after = data.flatMap((x) => x.withDirectives)
	const afterKeys = new Set(after.map(key))
	const added = after.filter((hit) => hit.rule !== '<directive>' && !before.has(key(hit)))
	const removed = data
		.flatMap((x) => x.baseline)
		.filter((hit) => hit.rule !== '<directive>' && !afterKeys.has(key(hit)))
	const unused = after.filter((hit) => hit.message.includes('Unused eslint-disable'))
	const naked = data.flatMap((x) => x.naked).filter((hit) => hit.rule !== '<directive>')

	console.log(`## New errors the working config introduces — ${added.length}\n`)
	for (const hit of added) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.rule}\n      ${hit.message}`)

	console.log(`\n## Errors the working config silences — ${removed.length}\n`)
	for (const hit of removed) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.rule}`)

	console.log(`\n## Now-redundant disables — ${unused.length}\n`)
	for (const hit of unused) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.message}`)

	console.log(`\n## What disables are hiding, by rule — ${naked.length} total\n`)
	const byRule = new Map<string, Hit[]>()
	for (const hit of naked) byRule.set(hit.rule, [...(byRule.get(hit.rule) ?? []), hit])
	const ranked = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)

	for (const [rule, hits] of ranked) {
		const repos = [...new Set(hits.map((hit) => hit.repo))]
		console.log(`  ${String(hits.length).padStart(3)}  ${rule}  (${repos.join(', ')})`)
	}
}

const rule = async (ruleId: string) => {
	const data = await load()
	const hits = data.flatMap((x) => x.naked).filter((hit) => hit.rule === ruleId)
	console.log(`## ${ruleId} — ${hits.length} violations with every inline disable ignored\n`)
	for (const hit of hits) console.log(`  ${hit.repo}/${hit.file}:${hit.line}\n      ${hit.message}`)
}

const restore = async () => {
	for (const repo of await findConsumers()) await Promise.all((await installedConfigs(repo)).map(revert))
	console.log('Installed configs reverted')
}

const [command, argument] = process.argv.slice(2)
if (command === 'scan') await scan()
else if (command === 'report') await report()
else if (command === 'rule' && argument) await rule(argument)
else if (command === 'restore') await restore()
else console.log('usage: bun run verify scan | report | rule <ruleId> | restore')
