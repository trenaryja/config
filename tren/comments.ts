import { statSync } from 'node:fs'
import { join } from 'node:path'
import * as R from 'remeda'
import { GENERATED_GLOBS } from '../lib/generated-globs.js'
import { columnLines } from './columns.ts'
import { gitRoot, readText, trackedFiles } from './repo.ts'
import { defineCommand, jsonFlag, MISUSE } from './run.ts'

const SLASH_EXTS = new Set('c cjs cpp cts go h java js json5 jsonc jsx kt less mjs mts rs scss swift ts tsx'.split(' '))
const HASH_EXTS = new Set(['bash', 'conf', 'py', 'rb', 'sh', 'tf', 'tfvars', 'toml', 'yaml', 'yml', 'zsh'])
const BLOCK_EXTS = new Set([...SLASH_EXTS, 'css'])
const SCANNED = new Set([...SLASH_EXTS, ...HASH_EXTS, 'css'])

const DIVIDER = /^(?:[\s|>*]*[\s|>])?(?:[-=*_~#]{3,}|\**[─━═╌┄┈–—]{2,}\**)(?:[\s|>][\s|>*]*)?$/
const WRAPPED = /^(?:(?![-=*_─━═]{2})[^\w\s])*\s*[-=*_─━═]{2}.*[-=*_─━═]{2}\s*(?:[^\w\s](?<![-=*_─━═]{2}))*$/
const HOW_TO_RUN = /^(?:example|how to run|invoke|run|usage)\s*:/i
const TODO = /\b(?:FIXME|HACK|TODO|WIP|XXX)\b/
const ANCHOR =
	/->|=>|@?[\w.-]+\/[\w./-]+|\.(?:js|py|sh|tf|ts|tsx|yml)\b|#\d+|\b(?:after|before|blocked|drop when|migrate to|move to|once|pending|replace with|switch to|until|when)\b/i
const CODEISH =
	/^(?:(?:async|await|class|const|else|export|for|function|if|import|interface|let|return|type|var|while)\b|console\.|\}|\)|<\/?[A-Za-z]+[\s/>])/
const CODETAIL = /[;{]$|\)\s*[;{]$|\s=\s|=>/
const HISTORY =
	/\badr[\s-]?\d|\.claude\/plans|\bper the (?:decision|discussion|plan|spec)\b|\bsee (?:the )?(?:decision|discussion|thread|ticket)\b|\bused to be\b|\bwe (?:agreed|changed|decided|moved|renamed)\b/i
const SSOT =
	/\bv?\d+\.\d+\.\d+\b|[€$£¥]\s?\d|\b\d+(?:\.\d+)?\s?(?:eur|gbp|usd)\b|\bline \d+\b|\b(?:per|see) [\w./-]+:\d+/i
const COMMENT_START = /^(?:\/\/|#|\*|\/\*)/

const IDENTIFIER_SPLIT = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/
const words = (text: string) =>
	new Set(
		text
			.toLowerCase()
			.split(IDENTIFIER_SPLIT)
			.filter((word) => word.length > 2),
	)

const restates = (body: string, next: string) => {
	const commentWords = words(body)
	if (commentWords.size < 2 || commentWords.size > 5) return false
	const codeWords = words(next)
	return codeWords.size > 0 && commentWords.isSubsetOf(codeWords)
}

type Verdict = 'cut' | 'review'

type Rule = {
	id: string
	verdict: Verdict
	scope: 'block' | 'line'
	blurb: string
	test: (text: string, next: string, fromBlock: boolean) => boolean
}

const RULES: Rule[] = [
	{
		id: 'banner',
		verdict: 'cut',
		scope: 'line',
		blurb: 'Divider or section header. The attached comment is the header.',
		test: (text) => DIVIDER.test(text) || WRAPPED.test(text),
	},
	{
		id: 'usage',
		verdict: 'cut',
		scope: 'line',
		blurb: 'How-to-run header. The CLI table or README owns this.',
		test: (text) => HOW_TO_RUN.test(text),
	},
	{
		id: 'commented-code',
		verdict: 'cut',
		scope: 'line',
		blurb: 'Commented-out code. Git owns this. Skipped inside /** */ so @example survives.',
		test: (text, _next, fromBlock) => !fromBlock && CODEISH.test(text) && CODETAIL.test(text),
	},
	{
		id: 'history',
		verdict: 'cut',
		scope: 'block',
		blurb: 'Cites a decision, doc, or ticket instead of describing the code.',
		test: (text) => HISTORY.test(text),
	},
	{
		id: 'todo-bare',
		verdict: 'review',
		scope: 'line',
		blurb: 'TODO with no destination or trigger — can never go stale or be done.',
		test: (text) => TODO.test(text) && !ANCHOR.test(text),
	},
	{
		id: 'ssot-risk',
		verdict: 'review',
		scope: 'block',
		blurb: 'Duplicates a fact owned elsewhere — a version, price, or line reference.',
		test: (text) => SSOT.test(text),
	},
	{
		id: 'restatement',
		verdict: 'review',
		scope: 'block',
		blurb: 'Every word already appears in the line below it. Only fires on 2–5 word comments.',
		test: restates,
	},
]

type Comment = {
	line: number
	body: string
	block: string
	blockLine: number
	next: string
	fromBlock: boolean
}

const extensionOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? ''

const stripBlockMarkers = (text: string, opener: RegExp) =>
	text
		.replace(opener, '')
		.replace(/\*\/\s*$/, '')
		.trim()

const markerOf = (trimmed: string, extension: string) => {
	if (SLASH_EXTS.has(extension) && trimmed.startsWith('//')) return '//'
	return HASH_EXTS.has(extension) && trimmed.startsWith('#') ? '#' : ''
}

const trailingBody = (raw: string, extension: string) => {
	const trailing = SLASH_EXTS.has(extension) ? raw.indexOf(' //') : HASH_EXTS.has(extension) ? raw.indexOf(' #') : -1
	if (trailing < 0) return ''
	const before = raw.slice(0, trailing)
	const oddQuotes = (before.split('"').length - 1) % 2 || (before.split("'").length - 1) % 2
	return oddQuotes || before.endsWith(':')
		? ''
		: raw
				.slice(trailing)
				.replace(/^\s*(?:\/\/|#)\s?/, '')
				.trim()
}

const commentsIn = (source: string, extension: string) => {
	const lines = source.split('\n')
	const block = BLOCK_EXTS.has(extension)
	const comments: Comment[] = []
	let run: Comment[] = []
	let inBlock = false

	const nextCode = (from: number) =>
		lines
			.slice(from, from + 4)
			.map((candidate) => candidate.trim())
			.find((candidate) => candidate && !COMMENT_START.test(candidate)) ?? ''

	const flush = () => {
		const [first] = run
		const last = R.last(run)
		if (!first || !last) return
		const text = run
			.filter((comment) => !DIVIDER.test(comment.body))
			.map((comment) => comment.body)
			.join(' ')
		const next = nextCode(last.line)
		comments.push(...run.map((comment) => ({ ...comment, block: text, blockLine: first.line, next })))
		run = []
	}

	const extend = (line: number, body: string, fromBlock = false) => {
		run.push({ line, body, block: body, blockLine: line, next: '', fromBlock })
	}

	for (const [index, raw] of lines.entries()) {
		const trimmed = raw.trim()
		const line = index + 1
		if (index === 0 && trimmed.startsWith('#!')) continue
		if (block && (inBlock || trimmed.startsWith('/*'))) {
			if (!inBlock) flush()
			const body = stripBlockMarkers(trimmed, inBlock ? /^\*+\s?/ : /^\/\*+\s?/)
			if (body) extend(line, body, true)
			inBlock = !trimmed.includes('*/')
			if (!inBlock) flush()
			continue
		}

		const marker = markerOf(trimmed, extension)

		if (marker) {
			const body = trimmed.slice(marker.length).trim()
			if (body) extend(line, body)
			else flush()
			continue
		}

		flush()

		const body = trailingBody(raw, extension)
		if (body) comments.push({ line, body, block: body, blockLine: line, next: '', fromBlock: false })
	}
	flush()

	return comments
}

const generated = GENERATED_GLOBS.map((pattern) => new Bun.Glob(pattern.endsWith('/') ? `${pattern}**` : pattern))

/** minus `.gitattributes` lines like `vendor/** comment-audit=off` */
const auditedIn = (root: string) => {
	const files = trackedFiles(root).filter(
		(file) => SCANNED.has(extensionOf(file)) && generated.every((glob) => !glob.match(file)),
	)
	const attributes = Bun.spawnSync(['git', 'check-attr', '-z', '--stdin', 'comment-audit'], {
		cwd: root,
		stdin: Buffer.from(files.join('\0')),
	})
	if (!attributes.success) return files
	const off = new Set(
		R.chunk(attributes.stdout.toString().split('\0'), 3)
			.filter(([_file, _attribute, value]) => value === 'off')
			.map(([file]) => file),
	)
	return files.filter((file) => !off.has(file))
}

const hitsIn = (file: string, comments: readonly Comment[]) =>
	R.uniqueBy(
		comments.flatMap((comment) => {
			const rule = RULES.find((candidate) =>
				candidate.test(candidate.scope === 'block' ? comment.block : comment.body, comment.next, comment.fromBlock),
			)
			if (!rule) return []
			const [text, line] = rule.scope === 'block' ? [comment.block, comment.blockLine] : [comment.body, comment.line]
			return { file, line, rule: rule.id, verdict: rule.verdict, text: text.slice(0, 120) }
		}),
		(hit) => `${hit.rule}:${hit.line}`,
	)

/** a generated glob, or `@generated` / `DO NOT EDIT` in the first 8 lines */
export const isGenerated = (path: string, source: string) =>
	generated.some((glob) => glob.match(path)) ||
	source.split('\n', 8).some((line) => /@generated\b|DO NOT EDIT/.test(line))

export const scan = async (root: string) => {
	const hits: { file: string; line: number; rule: string; verdict: Verdict; text: string }[] = []
	let files = 0
	let commentLines = 0
	for (const file of auditedIn(root)) {
		const source = await readText(join(root, file))
		if (!source || isGenerated(file, source)) continue
		files++
		const comments = commentsIn(source, extensionOf(file))
		commentLines += comments.length
		hits.push(...hitsIn(file, comments))
	}
	return { files, commentLines, hits }
}

/** review = read it, measured results legitimately carry numbers */
export const formatRules = () =>
	columnLines(
		RULES.map((rule) => [rule.id, rule.verdict, rule.blurb]),
		'  ',
	).join('\n')

type Scan = Awaited<ReturnType<typeof scan>>

const report = ({ hits, files, commentLines }: Scan, root: string) => {
	const counts = R.countBy(hits, (hit) => hit.rule)
	const cut = hits.filter((hit) => hit.verdict === 'cut').length
	const worst = R.pipe(
		R.countBy(hits, (hit) => hit.file),
		R.entries(),
		R.sortBy([([, count]) => count, 'desc']),
		R.take(10),
	)
	const table = columnLines([
		['RULE', 'VERDICT', 'COUNT', 'WHAT IT MEANS'],
		...RULES.filter((rule) => counts[rule.id]).map((rule) => [
			rule.id,
			rule.verdict,
			String(counts[rule.id]).padStart(5),
			rule.blurb,
		]),
	])
	return [
		`\nScanned ${files} files under ${root} — ${commentLines} comment lines.\n`,
		...table,
		`\n${cut} to cut, ${hits.length - cut} to review — ${((hits.length / (commentLines || 1)) * 100).toFixed(1)}% of all comment lines.`,
		...(worst.length > 0
			? ['\nWorst files:', ...worst.map(([file, count]) => `  ${String(count).padStart(4)}  ${file}`)]
			: []),
		'\nEvery hit for one rule: --list <rule>. Machine-readable: --json.\n',
	].join('\n')
}

const list = ({ hits }: Scan, rule: string) => {
	const matching = hits.filter((hit) => hit.rule === rule)
	return matching.length > 0
		? [...matching.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`), `\n${matching.length} hits.`].join('\n')
		: `No hits for "${rule}". Rules: ${RULES.map((candidate) => candidate.id).join(', ')}`
}

export default defineCommand({
	scope: 'repo',
	positionals: '[<path>]',
	options: {
		list: { type: 'string', value: 'rule', about: 'every hit for one rule, as file:line' },
		json: jsonFlag('{ files, commentLines, hits }'),
	},
	details: `Scores every comment in the git-tracked files under <path> (default: the repo root) against the mechanical comment rules in ~/CLAUDE.md. Never edits, and exits 0 whatever it finds; \`tren doctor comments\` is the gate.
An unflagged comment is not thereby a good one: whether deleting it would mislead the next agent stays a reader's call.

Rules (cut = the rule alone is grounds; review = read it, measured results legitimately carry numbers):
${formatRules()}

Skip a file: comment-audit=off in .gitattributes.`,
	run: async ({ values, positionals, root }) => {
		const target = positionals[0] ?? root
		if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
			console.error(`tren comments: ${target} is not a directory; pass a directory inside the repository`)
			return MISUSE
		}
		if (gitRoot(target) !== root) {
			console.error(`tren comments: ${target} is not inside this repository`)
			return MISUSE
		}
		const result = await scan(target)
		console.log(
			values.json
				? JSON.stringify(result, null, '\t')
				: values.list === undefined
					? report(result, target)
					: list(result, values.list),
		)
		return 0
	},
})
