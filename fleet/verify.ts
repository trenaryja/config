import * as R from 'remeda'
import type { Cell } from './audit.ts'
import { findConsumers, GIT } from './discover.ts'

const CACHE = '/tmp/eslint-verify.json'
const CONCURRENCY = 4

type Message = { ruleId: string | null; line: number; message: string }

type LintResult = { filePath: string; messages: Message[] }

type Hit = { repo: string; file: string; line: number; rule: string; message: string }

/** consumers install from npm -> `working` preloads a swap so their eslint loads this repo's eslint.js */
const lint = async (repo: string, working: boolean, ...flags: string[]) => {
	const preload = working ? ['--preload', `${import.meta.dir}/swap-eslint.ts`] : []
	const eslint = ['node_modules/.bin/eslint', '.', '--format', 'json', '--no-warn-ignored']
	const proc = Bun.spawn(['bun', ...preload, ...eslint, '--report-unused-disable-directives', ...flags], {
		cwd: `${GIT}/${repo}`,
		stdout: 'pipe',
		stderr: 'ignore',
	})
	const stdout = await new Response(proc.stdout).text()

	try {
		const results: LintResult[] = JSON.parse(stdout.slice(stdout.indexOf('[')))
		return results.flatMap((result) =>
			result.messages.map((message): Hit => ({
				repo,
				file: result.filePath.replace(`${GIT}/${repo}/`, ''),
				line: message.line,
				rule: message.ruleId ?? '<directive>',
				message: message.message,
			})),
		)
	} catch {
		console.error(`  ${repo}: eslint printed no JSON, so it counts as zero hits`)
		return []
	}
}

// Most consumers not green today -> raw counts are noise; only the diff vs the installed config means anything
const scanRepo = async (repo: string) => ({
	repo,
	baseline: await lint(repo, false),
	withDirectives: await lint(repo, true),
	// Suppression count says nothing about a rule's worth -> lint with every inline disable ignored
	naked: await lint(repo, true, '--no-inline-config'),
})

type Scan = Awaited<ReturnType<typeof scanRepo>>

export const scan = async (onProgress?: (done: number, total: number) => void) => {
	const consumers = await findConsumers()
	console.log(`Scanning ${consumers.length} consumers: ${consumers.join(', ')}\n`)
	const out: Scan[] = []
	onProgress?.(0, consumers.length)

	for (let start = 0; start < consumers.length; start += CONCURRENCY)
		for (const result of await Promise.all(consumers.slice(start, start + CONCURRENCY).map(scanRepo))) {
			console.log(`  ${result.repo}: ${result.withDirectives.length} live, ${result.naked.length} unsuppressed`)
			out.push(result)
			onProgress?.(out.length, consumers.length)
		}

	await Bun.write(CACHE, JSON.stringify(out, null, 2))
	console.log(`\nCached to ${CACHE}`)
}

const cache = Bun.file(CACHE)

export const loadScans = async (): Promise<Scan[]> => ((await cache.exists()) ? cache.json() : [])

export const scannedAt = async () => ((await cache.exists()) ? new Date(cache.lastModified) : undefined)

const key = (hit: Hit) => `${hit.repo}/${hit.file}:${hit.line}:${hit.rule}`

/** live hits under the working config, `(new)` where the installed one was quiet */
export const lintCell = (result: Scan): Cell => {
	const [before, after] = [new Set(result.baseline.map(key)), new Set(result.withDirectives.map(key))]
	return {
		path: 'eslint.js (working copy)',
		residue: result.withDirectives.map(
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
	const after = data.flatMap((x) => x.withDirectives)
	const [beforeKeys, afterKeys] = [new Set(baseline.map(key)), new Set(after.map(key))]
	const added = after.filter((hit) => hit.rule !== '<directive>' && !beforeKeys.has(key(hit)))
	const removed = baseline.filter((hit) => hit.rule !== '<directive>' && !afterKeys.has(key(hit)))
	const unused = after.filter((hit) => hit.message.includes('Unused eslint-disable'))
	const naked = data.flatMap((x) => x.naked).filter((hit) => hit.rule !== '<directive>')

	console.log(`## New errors the working config introduces — ${added.length}\n`)
	for (const hit of added) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.rule}\n      ${hit.message}`)

	console.log(`\n## Errors the working config silences — ${removed.length}\n`)
	for (const hit of removed) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.rule}`)

	console.log(`\n## Now-redundant disables — ${unused.length}\n`)
	for (const hit of unused) console.log(`  ${hit.repo}/${hit.file}:${hit.line}  ${hit.message}`)

	console.log(`\n## What disables are hiding, by rule — ${naked.length} total\n`)
	const byRule = R.pipe(
		naked,
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
	const hits = (await loadScans()).flatMap((x) => x.naked).filter((hit) => hit.rule === ruleId)
	console.log(`## ${ruleId} — ${hits.length} violations with every inline disable ignored\n`)
	for (const hit of hits) console.log(`  ${hit.repo}/${hit.file}:${hit.line}\n      ${hit.message}`)
}

export const verify = async ([command, argument]: readonly string[]) => {
	if (command === 'scan') await scan()
	else if (command === 'report') await report()
	else if (command === 'rule' && argument) await rule(argument)
	else console.log('usage: bun fleet verify scan | report | rule <ruleId>')
}
