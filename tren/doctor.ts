import { basename, dirname, join } from 'node:path'
import * as R from 'remeda'
import ts from 'typescript'
import { z } from 'zod'
import { formatRules, isGenerated, scan } from './comments.ts'
import { compilerFindings } from './compiler.ts'
import { unusedDeps } from './deps.ts'
import { eslintConfigFindings, packageFindings, tsconfigFindings } from './presets.ts'
import {
	CODE,
	type Ctx,
	depsOf,
	editJson,
	editText,
	type Fix,
	formatFiles,
	type Manifest,
	manifestsIn,
	messageOf,
	readJson,
	readManifest,
	readText,
	trackedFiles,
	within,
} from './repo.ts'
import { defineCommand, jsonFlag, MISUSE } from './run.ts'
import { scriptFindings } from './scripts.ts'
import { vercelFindings } from './vercel.ts'
import { behindFindings, peerFindings } from './versions.ts'

/** `check` is a doctor check id or, for a fleet lint hit, the rule */
export type Finding<Id extends string = string> = {
	check: Id
	path: string
	line?: number
	column?: number
	message: string
	/** reports but passes: a dep a peer range keeps behind latest, a comment to read */
	hold?: true
	fix?: Fix
	reason?: string
}

export type Found = Omit<Finding, 'check'>

export const DOCTOR_KINDS = ['tsconfig', 'eslint', 'package', 'deps'] as const

/** `registry` = npm, `vercel` = a hosting account's CLI: only `none` runs offline, only `vercel` waits for `--remote` */
type Needs = 'none' | 'registry' | 'vercel'
const entry = <const Id extends string>(
	id: Id,
	needs: Needs,
	kind: (typeof DOCTOR_KINDS)[number],
	run: (ctx: Ctx) => Promise<readonly Found[]>,
) => ({ id, needs, kind, run })

const RENOVATE_PRESET = 'github>trenaryja/config//renovate/base'

/** eslint and tsc honour a directive only as a comment's first word, so prose and strings that mention one stay quiet */
const DISABLE = /^(?:\/\/|\/\*)\s*(?:eslint-disable|@ts-(?:ignore|expect-error|nocheck))/
/** eslint's description syntax, also accepted after a @ts- directive */
const REASON = /\s--\s+\S/
const pushSchema = z.object({ on: z.object({ push: z.object({ branches: z.array(z.string()) }) }) })
/** the push trigger only: a `pull_request` block's `branches: [main]` is a different filter */
const PUSH_MAIN = /(push:[ \t]*\n[ \t]*branches: \[main)\]/
const skipsRenovate = (text: string) => {
	const branches = pushSchema.safeParse(Bun.YAML.parse(text)).data?.on.push.branches
	return branches !== undefined && !branches.includes('renovate/**')
}
const addRenovateBranch = (text: string) => text.replace(PUSH_MAIN, "$1, 'renovate/**']")
const CI_USES = 'uses: trenaryja/config/.github/workflows/ci.yml@'
const CI_RUN = 'run: bun run ci'
const runsCi = (text: string) => text.includes(CI_USES) || text.includes(CI_RUN)

const read = (root: string, path: string) => readText(join(root, path))

const eachManifest =
	(find: (ctx: Ctx, manifest: string, pkg: Manifest) => Promise<readonly Found[]> | readonly Found[]) =>
	async (ctx: Ctx) =>
		(
			await Promise.all(
				ctx.manifests.map(async (manifest) => find(ctx, manifest, await readManifest(join(ctx.root, manifest)))),
			)
		).flat()

/** a manifest that won't parse is a finding, not an abort: fixtures and templates carry deliberately broken ones */
const unreadable = async (root: string, manifests: readonly string[]) => {
	const results = await Promise.all(
		manifests.map((manifest) =>
			readManifest(join(root, manifest))
				.then(() => undefined)
				.catch((error: unknown) => ({
					path: manifest,
					message: messageOf(error).replace(`${join(root, manifest)}: `, ''),
				})),
		),
	)
	return {
		readable: manifests.filter((_manifest, index) => results[index] === undefined),
		broken: results.filter(R.isDefined),
	}
}

const sources = (ctx: Ctx, test: (file: string) => boolean) =>
	Promise.all(ctx.files.filter(test).map(async (file) => ({ file, text: await read(ctx.root, file) })))

/** the lines where `pick` finds something in real code, one message each; strings and template text never match */
const eachHit = (
	path: string,
	text: string,
	pick: (nodes: readonly ts.Node[], source: ts.SourceFile) => readonly number[],
	message: (line: string) => string,
) => {
	const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest)
	/** every node, punctuation included, so a comment between two tokens isn't lost */
	const nodes: ts.Node[] = []
	const walk = (node: ts.Node) => {
		nodes.push(node)
		for (const child of node.getChildren(source)) walk(child)
	}
	walk(source)
	const lines = text.split('\n')
	return R.unique(pick(nodes, source).map((pos) => source.getLineAndCharacterOfPosition(pos).line + 1)).map((line) => ({
		path,
		line,
		message: message(lines[line - 1] ?? ''),
	}))
}

const commentStarts = (nodes: readonly ts.Node[], source: ts.SourceFile) =>
	R.uniqueBy(
		nodes.flatMap(({ pos, end }) => [
			...(ts.getLeadingCommentRanges(source.text, pos) ?? []),
			...(ts.getTrailingCommentRanges(source.text, end) ?? []),
		]),
		(range) => range.pos,
	)

/** one parse a CI build can skip with SKIP_ENV_VALIDATION */
const envFindings = async (ctx: Ctx, manifest: string, pkg: Manifest) => {
	if (!depsOf(pkg).next) return []
	const directory = dirname(manifest)
	const code = await sources(ctx, (file) => CODE.test(file) && within(directory, file) && basename(file) !== 'env.ts')
	return code.flatMap(({ file, text }) =>
		eachHit(
			file,
			text,
			(nodes, source) =>
				nodes
					.filter(
						(node) =>
							ts.isPropertyAccessExpression(node) &&
							ts.isIdentifier(node.expression) &&
							node.expression.text === 'process' &&
							node.name.text === 'env',
					)
					.map((node) => node.getStart(source)),
			() => 'next app reads process.env outside env.ts',
		),
	)
}

/** `tren doctor <check>…` runs only these, and every list below derives from it */
const REGISTRY = [
	entry('agents', 'none', 'package', async (ctx) =>
		(await sources(ctx, (file) => /(?:^|\/)AGENTS\.md$/.test(file)))
			.filter(({ text }) => text.includes('nextjs-agent-rules'))
			.map(({ file }) => ({ path: file, message: "next dev's AGENTS.md is committed" })),
	),
	entry(
		'babel',
		'none',
		'deps',
		eachManifest((_ctx, manifest, pkg) =>
			depsOf(pkg)['@babel/core']
				? [
						{
							path: manifest,
							message: "declares @babel/core, which config's react-hooks plugin already installs",
						},
					]
				: [],
		),
	),
	entry('comments', 'none', 'eslint', async ({ root }) =>
		(await scan(root)).hits.map((hit) => ({
			path: hit.file,
			line: hit.line,
			message: `${hit.rule}: ${hit.text}`,
			...(hit.verdict === 'review' && { hold: true as const }),
		})),
	),
	entry('compiler', 'none', 'package', eachManifest(compilerFindings)),
	entry('deps-latest', 'registry', 'deps', async ({ root, manifests }) => {
		const { behind, unknown } = await behindFindings(root, manifests)
		return [...behind, ...unknown]
	}),
	entry('disables', 'none', 'eslint', async (ctx) =>
		(await sources(ctx, (file) => CODE.test(file)))
			.filter(({ file, text }) => !isGenerated(file, text))
			.flatMap(({ file, text }) =>
				eachHit(
					file,
					text,
					(nodes, source) =>
						commentStarts(nodes, source)
							.filter(({ pos, end }) => DISABLE.test(source.text.slice(pos, end)))
							.map(({ pos }) => pos),
					(line) => line.trim(),
				).map((finding) => (REASON.test(finding.message) ? { ...finding, hold: true as const } : finding)),
			),
	),
	entry('env', 'none', 'package', eachManifest(envFindings)),
	entry('eslint-config', 'none', 'eslint', eachManifest(eslintConfigFindings)),
	entry('package', 'none', 'package', eachManifest(packageFindings)),
	entry('peers', 'none', 'deps', async ({ root, manifests }) => peerFindings(root, manifests)),
	entry('renovate', 'none', 'deps', async ({ root }) => {
		const path = 'renovate.json'
		if (JSON.stringify(await readJson(join(root, path))).includes(RENOVATE_PRESET)) return []
		return [
			{
				path,
				message: `missing or not extending ${RENOVATE_PRESET}`,
				fix: editJson(root, path, (config) => {
					// an older spelling of the preset (root default.json) gives way to the current one
					config.extends = [
						...z
							.union([z.array(z.string()), z.string().transform((preset) => [preset])])
							.catch([])
							.parse(config.extends)
							.filter((preset) => !preset.startsWith('github>trenaryja/config')),
						RENOVATE_PRESET,
					]
				}),
			},
		]
	}),
	entry('scripts', 'none', 'package', async (ctx) => {
		const turbo = z
			.object({ tasks: z.object({ chk: z.object({ dependsOn: z.array(z.string()).default([]) }).optional() }) })
			.safeParse(await readJson(join(ctx.root, 'turbo.json')))
		return [
			...(await eachManifest(scriptFindings)(ctx)),
			...(turbo.data?.tasks.chk?.dependsOn.some((task) => task.includes('build'))
				? [{ path: 'turbo.json', message: 'chk depends on a build; the build belongs in ci' }]
				: []),
		]
	}),
	entry('tsconfig', 'none', 'tsconfig', eachManifest(tsconfigFindings)),
	entry('unused', 'none', 'deps', unusedDeps),
	entry('vercel-env', 'vercel', 'package', async (ctx) => (await vercelFindings(ctx)).env),
	entry('vercel-node', 'vercel', 'package', async (ctx) => (await vercelFindings(ctx)).node),
	entry('workflow', 'none', 'package', async (ctx) => {
		const workflows = await sources(ctx, (file) => file.startsWith('.github/workflows/'))
		const all = workflows.map(({ text }) => text).join('\n')
		return [
			// config itself runs the reusable workflow on push rather than calling it
			...(all.includes(CI_USES) || (all.includes('workflow_call:') && all.includes(CI_RUN))
				? []
				: [{ path: '.github/workflows', message: "no workflow calls trenaryja/config's ci.yml" }]),
			// Renovate's branch automerge waits for checks, so a CI run on main alone leaves every update unmerged
			...workflows
				.filter(({ text }) => runsCi(text) && skipsRenovate(text))
				.map(({ file, text }) => ({
					path: file,
					message: "CI skips renovate/** branches, so Renovate's automerge never sees a check pass",
					...(addRenovateBranch(text) !== text && { fix: editText(ctx.root, file, addRenovateBranch) }),
				})),
		]
	}),
]

type Check = (typeof REGISTRY)[number]['id']

export const kindOf = (check: string) => REGISTRY.find(({ id }) => id === check)?.kind

const idsWhere = (test: (needs: Needs) => boolean) => REGISTRY.filter(({ needs }) => test(needs)).map(({ id }) => id)
export const CHECKS = idsWhere(() => true)
/** the remote checks wait for `--remote` so `chk` and CI need no login */
export const LOCAL = idsWhere((needs) => needs !== 'vercel')
const OFFLINE = idsWhere((needs) => needs === 'none')
const NETWORK = idsWhere((needs) => needs !== 'none')
export const REMOTE = idsWhere((needs) => needs === 'vercel')

export const diagnose = async (root: string, checks: ReadonlySet<Check> = new Set(LOCAL)) => {
	const files = trackedFiles(root)
	const { readable, broken } = await unreadable(root, manifestsIn(files))
	const ctx = { root, files, manifests: readable }
	const found = await Promise.all(
		REGISTRY.filter(({ id }) => checks.has(id)).map(async ({ id, run }) =>
			(await run(ctx)).map((finding) => ({ check: id, ...finding })),
		),
	)
	const all: Finding<Check>[] = [
		...found.flat(),
		...(checks.has('package') ? broken.map((finding) => ({ check: 'package' as const, ...finding })) : []),
	]
	return R.sortBy(
		all,
		(finding) => finding.path,
		(finding) => finding.line ?? 0,
		(finding) => finding.check,
		(finding) => finding.message,
	)
}

export const location = ({ path, line, column }: Finding) => [path, line, column].filter(R.isDefined).join(':')

export const format = (finding: Finding) =>
	`${finding.hold ? 'hold ' : ''}${location(finding)}: ${finding.message}${finding.fix ? ' (--fix)' : ''}`

export const toJson = ({ fix, ...finding }: Finding) => ({ ...finding, fixable: Boolean(fix) })

/** so two edits to one package.json never race */
const fixesOf = (findings: readonly Finding[], offline: boolean) =>
	R.unique(findings.flatMap(({ fix }) => (fix && (!offline || !fix.install) ? [fix] : [])))

/** `touched`: the files a repair changed; `ran` counts every fix, so one with no local file (vercel) still triggers a re-check */
const apply = async (root: string, fixes: readonly Fix[]) => {
	const files = R.unique(fixes.flatMap((fix) => fix.files))
	const before = await Promise.all(files.map(async (file) => read(root, file)))
	for (const fix of fixes) await fix.run()
	const after = await Promise.all(files.map(async (file) => read(root, file)))
	const touched = files.filter((_file, index) => before[index] !== after[index])
	for (const path of touched) console.error(`fixed ${path}`)
	for (const fix of fixes)
		if (fix.files.length === 0) console.error(`ran ${fix.label ?? 'a repair with no local file'}`)
	return { touched, ran: fixes.length }
}

export const failing = (findings: readonly Finding[]) => findings.some((finding) => !finding.hold)

export const diagnoseOffline = (root: string) => diagnose(root, new Set(OFFLINE))

export const fixOffline = async (root: string) =>
	(await apply(root, fixesOf(await diagnoseOffline(root), true))).touched

/** the selection both `tren doctor` and `bun fleet doctor` take */
export const SELECT_OPTIONS = {
	skip: { type: 'string', multiple: true, value: 'check', about: 'leave a check out; repeatable' },
	offline: {
		type: 'boolean',
		about: `leave out the checks that need the network (${NETWORK.join(', ')}); with --fix, skip the repairs that run bun add or bun remove`,
	},
	remote: {
		type: 'boolean',
		about: `also run the checks that ask a hosting account (${REMOTE.join(', ')}); needs \`vercel login\`. With --fix, vercel-node also runs \`vercel project update --node-version <newest> --yes\`, changing the Production project's setting`,
	},
	holds: {
		type: 'boolean',
		about: 'print only the holds, each with its reason; the exit code still counts every finding',
	},
} as const

export const DETAILS = `Checks: ${CHECKS.join(', ')}. No check named runs them all, the remote ones only with --remote.

A hold reports but passes. A deviation with a reason holds, one without fails: a disable takes -- why, a tsconfig or eslint.config override a comment above, inside or beside it. Comment rules (cut fails, review holds):
${formatRules()}

Skip a file's comments: comment-audit=off in .gitattributes.`

/** the checks to run, and why the selection is misuse if it is */
export const selectChecks = (
	named: readonly string[],
	values: { skip?: readonly string[]; offline?: boolean; remote?: boolean },
) => {
	const unknown = [...named, ...(values.skip ?? [])].filter((check) => !R.isIncludedIn(check, CHECKS))
	const misuse = [
		[unknown.length > 0, `unknown check ${unknown.join(', ')}; valid: ${CHECKS.join(', ')}`],
		[
			!values.remote && named.some((check) => R.isIncludedIn(check, REMOTE)),
			`${REMOTE.join(' and ')} ask Vercel, so they need --remote`,
		],
		[
			values.offline && (Boolean(values.remote) || named.some((check) => !R.isIncludedIn(check, OFFLINE))),
			'--offline leaves out the checks that need the network, so --remote and naming one contradict it',
		],
	] as const
	const skipped = new Set(values.skip)
	return {
		misuse: misuse.find(([wrong]) => wrong)?.[1],
		checks: new Set(
			(values.remote ? CHECKS : values.offline ? OFFLINE : LOCAL).filter(
				(check) => (named.length === 0 || named.includes(check)) && !skipped.has(check),
			),
		),
	}
}

export const shown = (findings: readonly Finding[], holds = false) =>
	holds ? findings.filter((finding) => finding.hold) : findings

export default defineCommand({
	scope: 'repo',
	positionals: '[<check>...]',
	options: {
		...SELECT_OPTIONS,
		fix: { type: 'boolean', about: 'apply every repair marked (--fix), then report what remains' },
		'dry-run': { type: 'boolean', about: 'with --fix, print what each repair would touch and write nothing; exits 0' },
		json: jsonFlag(
			'{ root, findings }, each finding with its check id and whether --fix repairs it; with --dry-run, { root, fixes }',
		),
	},
	details: DETAILS,
	run: async ({ values, positionals, root }) => {
		const { checks, misuse } = selectChecks(positionals, values)
		const usage =
			misuse ?? (values['dry-run'] && !values.fix ? '--dry-run previews --fix, so it needs --fix' : undefined)
		if (usage) {
			console.error(`tren doctor: ${usage}`)
			return MISUSE
		}
		const offline = Boolean(values.offline)
		const found = await diagnose(root, checks)
		const fixes = fixesOf(found, offline)
		if (values['dry-run']) {
			if (values.json)
				console.log(
					JSON.stringify({ root, fixes: fixes.map(({ files, install = false }) => ({ files, install })) }, null, '\t'),
				)
			else
				for (const { files, install } of fixes)
					console.log(`would touch ${files.join(', ') || 'no local file'}${install ? ' (runs bun)' : ''}`)
			return 0
		}
		const { touched, ran } = values.fix ? await apply(root, fixes) : { touched: [], ran: 0 }
		await formatFiles(root, touched)
		const findings = ran > 0 ? await diagnose(root, checks) : found
		const printed = shown(findings, values.holds)
		if (values.json) console.log(JSON.stringify({ root, findings: printed.map(toJson) }, null, '\t'))
		else for (const finding of printed) console.log(format(finding))
		return failing(findings) ? 1 : 0
	},
})
