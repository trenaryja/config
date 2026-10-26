import { basename, dirname, join } from 'node:path'
import * as R from 'remeda'
import { z } from 'zod'
import { installed, readManifest, unusedDeps } from './deps.ts'
import { findConsumers, repositoryRoot, trackedFiles } from './discover.ts'

/** a hold is a dep kept behind latest because a peer range demands it: it reports, but passes */
type Finding = { path: string; message: string; hold?: true }

const latestSchema = z.object({ version: z.string(), peerDependencies: z.record(z.string(), z.string()).default({}) })
const registry = new Map<string, Promise<z.infer<typeof latestSchema> | undefined>>()
const latest = async (name: string) => {
	const cached = registry.get(name)
	if (cached) return cached
	const pending = fetch(`https://registry.npmjs.org/${name}/latest`)
		.then(async (response) => (response.ok ? latestSchema.parse(await response.json()) : undefined))
		.catch(() => undefined)
	registry.set(name, pending)
	return pending
}

const renovateSchema = z.object({
	packageRules: z
		.array(
			z.object({
				matchDepNames: z.array(z.string()).default([]),
				matchPackageNames: z.array(z.string()).default([]),
				allowedVersions: z.string().optional(),
			}),
		)
		.default([]),
})
/** the shared preset's rules plus the repo's own: an `allowedVersions` hold lives only while a peer range or engines backs it */
const renovateRules = async (root: string) =>
	(
		await Promise.all(
			[join(import.meta.dir, '../default.json'), join(root, 'renovate.json')].map(async (path) =>
				renovateSchema.parse(
					await Bun.file(path)
						.json()
						.catch(() => ({})),
				),
			),
		)
	).flatMap((config) => config.packageRules)
type Rule = Awaited<ReturnType<typeof renovateRules>>[number]

const CHK = ['bun check', 'bun fmt --check', 'eslint ', '--max-warnings=0']
const DISABLE = /eslint-disable|@ts-(?:ignore|expect-error|nocheck)/
const GENERATED = /\bgenerated\b|do not edit/i
const CODE = /\.[cm]?[jt]sx?$/

const read = async (root: string, path: string) =>
	Bun.file(join(root, path))
		.text()
		.catch(() => '')

/** a config file plus the relative modules it imports, one level: ui's vite config pulls its compiler from build-shared.ts */
const configText = async (root: string, files: readonly string[], directory: string, pattern: RegExp) => {
	const path = files.find((file) => dirname(file) === directory && pattern.test(file))
	if (!path) return ''
	const text = await read(root, path)
	const imports = text
		.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)
		.map(([, specifier = '']) => join(directory, specifier))
		.toArray()
	return [text, ...(await Promise.all(imports.map(async (file) => read(root, file))))].join('\n')
}

const versions = async (root: string, manifest: string, rules: readonly Rule[]) => {
	const directory = join(root, dirname(manifest))
	const pkg = await readManifest(join(root, manifest))
	const declared = R.entries({ ...pkg.dependencies, ...pkg.devDependencies })
		.filter(([, range]) => !range.startsWith('workspace:'))
		.map(([dep]) => dep)
	const installs = R.fromEntries(
		await Promise.all(declared.map(async (dep) => [dep, await installed(directory, dep)] as const)),
	)
	const peerOf = (dep: string) =>
		R.entries(installs)
			.map(([holder, x]) => ({ holder, range: x?.peerDependencies[dep] }))
			.filter((edge): edge is { holder: string; range: string } => edge.range !== undefined)
	const findings = await Promise.all(
		declared.map(async (dep): Promise<Finding[]> => {
			const current = installs[dep]?.version
			if (!current) return []
			const peerBreaks = peerOf(dep)
				.filter(({ range }) => !Bun.semver.satisfies(current, range))
				.map(({ holder, range }) => ({ path: manifest, message: `${dep} ${current} breaks ${holder}'s peer ${range}` }))
			const newest = await latest(dep)
			if (!newest || Bun.semver.order(newest.version, current) <= 0) return peerBreaks
			const engine = pkg.engines[dep.replace(/^@types\//, '')]
			const allowed = rules
				.filter((rule) => [...rule.matchDepNames, ...rule.matchPackageNames].includes(dep))
				.map((rule) => rule.allowedVersions)
				.filter((range) => range !== undefined && !Bun.semver.satisfies(newest.version, range))
			const holders = [
				// vsce refuses @types/vscode newer than engines.vscode's floor
				...(dep.startsWith('@types/') &&
				engine &&
				Bun.semver.order(newest.version, engine.replace(/^[\^~>=\s]+/, '')) > 0
					? [`engines ${engine}`]
					: []),
				...peerOf(dep)
					.filter(({ range }) => !Bun.semver.satisfies(newest.version, range))
					.map(({ holder, range }) => `${holder} peers ${range}`),
				...R.entries(newest.peerDependencies)
					.filter(([peer, range]) => {
						const version = installs[peer]?.version
						return version !== undefined && !Bun.semver.satisfies(version, range)
					})
					.map(([peer, range]) => `${newest.version} peers ${peer} ${range}`),
			]
			const message = `${dep} ${current} is behind ${newest.version}`
			if (allowed.length > 0 && holders.length === 0)
				return [
					...peerBreaks,
					{
						path: manifest,
						message: `${message}: renovate allows ${allowed.join(', ')}, which no peer range or engines backs anymore; drop the rule`,
					},
				]
			return [
				...peerBreaks,
				holders.length > 0
					? { path: manifest, message: `${message}: ${holders.join('; ')}`, hold: true }
					: { path: manifest, message },
			]
		}),
	)
	return findings.flat()
}

const scriptsSchema = z.object({ scripts: z.record(z.string(), z.string()).default({}) })

const runs = (text: string) =>
	text
		.matchAll(/bun run (\S+)/g)
		.map(([, name = '']) => name)
		.toArray()

const scriptFindings = (scripts: Readonly<Record<string, string>>, linted: boolean, isRoot: boolean) => {
	/** bin's chk delegates to `bun run lint`: what a script runs is the standard, not how it's spelled */
	const expand = (text: string, depth = 0): string =>
		depth > 5
			? text
			: text.replaceAll(/bun run (\S+)/g, (call, name: string) => expand(scripts[name] ?? call, depth + 1))
	const chk = scripts.chk && expand(scripts.chk)
	const fix = scripts.fix && expand(scripts.fix)
	return [
		...(linted && (isRoot || chk) && CHK.some((part) => !chk?.includes(part))
			? [`chk ${JSON.stringify(scripts.chk)} lacks one of ${CHK.join(', ')}`]
			: []),
		...(linted && (isRoot || fix) && !/eslint --fix [^;]*; bun fmt/.test(fix ?? '')
			? [`fix ${JSON.stringify(scripts.fix)} isn't eslint --fix then bun fmt`]
			: []),
		...(scripts.check ? ['a check script survives beside chk'] : []),
		...(scripts['vscode:prepublish'] ? ['vscode:prepublish makes vsce run npm'] : []),
	]
}

const compilerFindings = async (
	root: string,
	files: readonly string[],
	directory: string,
	deps: Readonly<Record<string, string>>,
) => {
	if (!deps.react) return []
	if (deps.next) {
		const config = await configText(root, files, directory, /next\.config\.[cm]?[jt]s$/)
		return [
			...(/reactCompiler:\s*true/.test(config) ? [] : ['next without reactCompiler: true']),
			...(/turbopackRustReactCompiler:\s*true/.test(config)
				? []
				: ['next without experimental.turbopackRustReactCompiler']),
			...(/agentRules:\s*false/.test(config) ? [] : ['next without agentRules: false']),
			...(deps['babel-plugin-react-compiler']
				? ["declares babel-plugin-react-compiler, which Next's Rust compiler replaces"]
				: []),
		]
	}
	const bundler = deps.vite ? 'vite' : deps.tsdown ? 'tsdown' : undefined
	// Ink and Raycast build without a compiler hook: Bun.build and ray build
	if (!bundler) return []
	const config = await configText(root, files, directory, new RegExp(String.raw`${bundler}\.config\.[cm]?[jt]s$`))
	return /reactCompiler|react-compiler/.test(config) ? [] : [`${bundler} without the React Compiler`]
}

/** one parse a CI build can skip with SKIP_ENV_VALIDATION */
const envFindings = async (root: string, files: readonly string[], directory: string) => {
	const prefix = directory === '.' ? '' : `${directory}/`
	const reads = await Promise.all(
		files
			.filter((file) => CODE.test(file) && file.startsWith(prefix) && basename(file) !== 'env.ts')
			.map(async (file) =>
				(await read(root, file))
					.split('\n')
					.map((line, index) => ({
						line,
						path: `${file}:${index + 1}`,
						message: 'next app reads process.env outside env.ts',
					}))
					.filter((hit) => hit.line.includes('process.env'))
					.map(({ path, message }) => ({ path, message })),
			),
	)
	return reads.flat()
}

const standards = async (root: string, files: readonly string[], manifest: string) => {
	const { scripts } = scriptsSchema.parse(await Bun.file(join(root, manifest)).json())
	const pkg = await readManifest(join(root, manifest))
	const deps = { ...pkg.dependencies, ...pkg.devDependencies }
	const directory = dirname(manifest)
	const isRoot = manifest === 'package.json'
	// a Rust-only member answers to cargo, not eslint
	const linted = isRoot || files.some((file) => CODE.test(file) && file.startsWith(`${directory}/`))
	return [
		...[
			...scriptFindings(scripts, linted, isRoot),
			...(deps['@babel/core'] ? ["declares @babel/core, which config's react-hooks plugin already installs"] : []),
			...(await compilerFindings(root, files, directory, deps)),
		].map((message) => ({ path: manifest, message })),
		...(deps.next ? await envFindings(root, files, directory) : []),
	]
}

const repoLevel = async (root: string, files: readonly string[]): Promise<Finding[]> => {
	const agents = await Promise.all(
		files
			.filter((file) => /(?:^|\/)AGENTS\.md$/.test(file))
			.map(async (file) => ((await read(root, file)).includes('nextjs-agent-rules') ? [file] : [])),
	)
	const renovate = await read(root, 'renovate.json')
	const workflows = (
		await Promise.all(
			files.filter((file) => file.startsWith('.github/workflows/')).map(async (file) => read(root, file)),
		)
	).join('\n')
	const { scripts } = scriptsSchema.parse(await Bun.file(join(root, 'package.json')).json())
	/** `bun run test` in CI counts when test itself runs chk */
	const reaches = (names: readonly string[], seen: ReadonlySet<string>): boolean =>
		names.some(
			(name) => name === 'chk' || (!seen.has(name) && reaches(runs(scripts[name] ?? ''), new Set([...seen, name]))),
		)
	const code = await Promise.all(
		files
			.filter((file) => CODE.test(file))
			.map(async (file) => ({ file, lines: (await read(root, file)).split('\n') })),
	)
	const [generated, authored] = R.partition(code, ({ lines }) => lines.slice(0, 8).some((line) => GENERATED.test(line)))
	const skipped = new Set(generated.map((x) => x.file))
	const disables = authored.flatMap(({ file, lines }) =>
		lines
			.map((line, index) => ({ path: `${file}:${index + 1}`, message: line.trim() }))
			.filter((hit) => DISABLE.test(hit.message)),
	)
	const audit = z
		.object({ hits: z.array(z.object({ file: z.string(), line: z.number(), rule: z.string(), verdict: z.string() })) })
		.parse(JSON.parse(Bun.spawnSync(['comment-audit', root, '--json']).stdout.toString() || '{"hits":[]}'))
	return [
		...agents.flat().map((path) => ({ path, message: "next dev's AGENTS.md is committed" })),
		...(renovate.includes('github>trenaryja/config')
			? []
			: [{ path: 'renovate.json', message: 'missing or not extending github>trenaryja/config' }]),
		...(reaches(runs(workflows), new Set()) ? [] : [{ path: '.github/workflows', message: 'no workflow runs chk' }]),
		...disables,
		...audit.hits
			.map((hit) => ({ ...hit, file: hit.file.slice(root.length + 1) }))
			.filter((hit) => hit.verdict === 'cut' && !skipped.has(hit.file))
			.map((hit) => ({ path: `${hit.file}:${hit.line}`, message: `comment-audit ${hit.rule}` })),
	]
}

/** every fleet standard a repo misses, holds included, repo-relative */
export const conformance = async (repository: string) => {
	const root = repositoryRoot(repository)
	const files = trackedFiles(root)
	const manifests = files.filter((file) => file === 'package.json' || file.endsWith('/package.json'))
	const rules = await renovateRules(root)
	const [perManifest, repo, unused] = await Promise.all([
		Promise.all(
			manifests.map(async (manifest) => [
				...(await versions(root, manifest, rules)),
				...(await standards(root, files, manifest)),
			]),
		),
		repoLevel(root, files),
		unusedDeps(root),
	])
	const findings: Finding[] = [
		...perManifest.flat(),
		...repo,
		...R.entries(unused).flatMap(([directory, lines]) =>
			lines.map((message) => ({ path: join(directory, 'package.json'), message })),
		),
	]
	return findings
}

/** repos are paths under ~/Git or absolute, default every consumer; a hold prints but passes */
export const conform = async (repositories: readonly string[]) => {
	const targets = repositories.length > 0 ? repositories : await findConsumers()
	const results = await Promise.all(
		targets.map(async (repository) => ({ repository, findings: await conformance(repository) })),
	)
	const lines = results.flatMap(({ repository, findings }) =>
		findings.map((finding) => ({ ...finding, line: `${join(repository, finding.path)}: ${finding.message}` })),
	)
	for (const { line, hold } of lines) console.log(hold ? `hold ${line}` : line)
	if (lines.some((finding) => !finding.hold)) process.exitCode = 1
}
