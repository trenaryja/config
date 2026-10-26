import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as R from 'remeda'
import { z } from 'zod'
import { findConsumers, findUp, repositoryRoot, trackedFiles } from './discover.ts'

const manifestSchema = z.object({
	dependencies: z.record(z.string(), z.string()).default({}),
	devDependencies: z.record(z.string(), z.string()).default({}),
	peerDependencies: z.record(z.string(), z.string()).default({}),
	peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().default(false) })).default({}),
	scripts: z.record(z.string(), z.string()).default({}),
	files: z.array(z.string()).default([]),
	bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
	types: z.unknown().optional(),
	typings: z.unknown().optional(),
	exports: z.unknown().optional(),
	version: z.string().optional(),
	engines: z.record(z.string(), z.string()).default({}),
})
type Manifest = z.infer<typeof manifestSchema>

export const readManifest = async (path: string) => {
	const parsed = manifestSchema.safeParse(await Bun.file(path).json())
	if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`)
	return parsed.data
}

const SHIPPED = new Set(R.keys((await readManifest(`${import.meta.dir}/../package.json`)).dependencies))

/** code and config only: kindle's epubs alone took 3.5s and name no package; a lockfile or package.json naming one isn't usage */
const SOURCE =
	/(?:\.(?:[cm]?[jt]sx?|jsonc?|css|scss|html|vue|svelte|astro|ya?ml|toml|sh|mdx)|(?:^|\/)(?:Dockerfile|Makefile))$/
const NOT_USAGE = /(?:^|\/)(?:package|package-lock)\.json$/

const quoted = (name: string) => new RegExp(String.raw`(['"])${RegExp.escape(name)}(?:/[^'"]*)?\1`)
const word = (name: string, flags = '') => new RegExp(String.raw`(?<![\w@/-])${RegExp.escape(name)}(?![\w-])`, flags)

/** with its install directory, which bin paths are relative to */
export const installed = async (from: string, dep: string) => {
	const path = findUp(from, `node_modules/${dep}/package.json`)
	return path ? { ...(await readManifest(path)), directory: dirname(path) } : undefined
}
type Installed = NonNullable<Awaited<ReturnType<typeof installed>>>

const ownTypes = (pkg: Manifest) =>
	Boolean(pkg.types ?? pkg.typings) || JSON.stringify(pkg.exports ?? {}).includes('"types"')

const bins = (dep: string, pkg: Installed) =>
	R.entries(typeof pkg.bin === 'string' ? { [dep.split('/').at(-1) ?? dep]: pkg.bin } : (pkg.bin ?? {})).map(
		([name, path]) => ({ name, path: join(pkg.directory, path) }),
	)

/** `@types/foo__bar` types `@foo/bar` */
const typedPackage = (dep: string) => {
	const name = dep.slice('@types/'.length)
	return name.includes('__') ? `@${name.replace('__', '/')}` : name
}

const RELATIVE_IMPORT = /(?:\bfrom|^import|\brequire\()\s*['"](\.[^'"]+)['"]/gm
const PACKAGE_ROOT = /^.*\/node_modules\/(?:@[^/]+\/)?[^/]+\//

const resolveFile = (path: string) =>
	[path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, 'index.js')].find((candidate) =>
		statSync(candidate, { throwIfNoEntry: false })?.isFile(),
	)

/** `starts` plus every file they statically import within their own package; a lazy `import()` isn't followed */
const loadedText = (starts: readonly string[]) => {
	const seen = new Set(starts)
	const queue = [...seen]
	const texts: string[] = []
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		const text = readFileSync(file, 'utf8')
		texts.push(text)
		const root = PACKAGE_ROOT.exec(file)?.[0] ?? dirname(file)
		for (const [, specifier = ''] of text.matchAll(RELATIVE_IMPORT)) {
			const resolved = resolveFile(join(dirname(file), specifier))
			if (!resolved?.startsWith(root) || seen.has(resolved)) continue
			seen.add(resolved)
			queue.push(resolved)
		}
	}
	return texts.join('\n')
}

/** the files behind every specifier the repo imports from `dependent` */
const importedModules = (directory: string, haystack: string, dependent: string) =>
	R.unique(
		haystack
			.matchAll(new RegExp(`['"](${RegExp.escape(dependent)}(?:/[^'"]*)?)['"]`, 'g'))
			.map(([, specifier]) => specifier ?? dependent)
			.toArray(),
	).flatMap((specifier) => {
		try {
			return Bun.resolveSync(specifier, directory)
		} catch {
			return []
		}
	})

type Context = {
	directory: string
	haystack: string
	declared: ReadonlySet<string>
	peers: ReadonlySet<string>
	optionalPeerOf: Readonly<Record<string, readonly string[]>>
	installs: Readonly<Record<string, Installed | undefined>>
	/** bins the repo runs: drizzle-kit loads its driver (pg) from its bin, undeclared */
	runBins: readonly string[]
}

const reason = async (dep: string, context: Context) => {
	const imported = quoted(dep).test(context.haystack)
	// config's own bins run from its install, so only an import needs a repo's own declaration
	if (SHIPPED.has(dep)) return imported ? undefined : 'ships with @trenaryja/config and nothing imports it'
	if (imported || context.peers.has(dep)) return
	const pkg = context.installs[dep]
	if (!pkg) return `is not installed; run bun install in ${context.directory}`
	if (dep.startsWith('@types/')) {
		const target = typedPackage(dep)
		const targetPkg = await installed(context.directory, target)
		if (targetPkg && ownTypes(targetPkg)) return `is a stub: ${target} ships its own types`
		// a declared target answers for itself; a global namespace (GeoJSON, NodeJS) shows up as a word, not an import
		if (context.declared.has(target) || word(target, 'i').test(context.haystack)) return
		return `types ${target}, which nothing uses`
	}
	if (bins(dep, pkg).some((bin) => word(bin.name).test(context.haystack))) return
	const dependents = context.optionalPeerOf[dep] ?? []
	const loaders = [
		...dependents.flatMap((dependent) => importedModules(context.directory, context.haystack, dependent)),
		...context.runBins,
	]
	if (loaders.length > 0 && quoted(dep).test(loadedText(loaders))) return
	return dependents.length > 0
		? `is an optional peer of ${dependents.join(', ')}, but nothing the repo imports or runs loads it`
		: 'nothing imports it, runs its bin, or loads it'
}

/** a published package's runtime imports live in its build output, which git ignores */
const buildOutput = async (packageDirectory: string, entries: readonly string[]) =>
	(
		await Promise.all(
			entries.map(async (entry) =>
				Array.fromAsync(new Bun.Glob(`${entry}/**/*.{js,mjs,cjs}`).scan({ cwd: packageDirectory, absolute: true })),
			),
		)
	)
		.flat()
		.map(async (path) => Bun.file(path).text())

const checkManifest = async (root: string, manifest: string, files: readonly { path: string; text: string }[]) => {
	const directory = dirname(manifest)
	const packageDirectory = join(root, directory)
	const raw = z.record(z.string(), z.unknown()).parse(await Bun.file(join(root, manifest)).json())
	const pkg = await readManifest(join(root, manifest))
	const versions = { ...pkg.dependencies, ...pkg.devDependencies }
	// turbo orders builds by workspace deps, imported or not
	const declared = R.keys(versions).filter((dep) => !versions[dep]?.startsWith('workspace:'))
	const installs = R.fromEntries(
		await Promise.all(declared.map(async (dep) => [dep, await installed(packageDirectory, dep)] as const)),
	)
	const peerEdges = R.entries(installs).flatMap(([dependent, x]) =>
		x
			? R.keys(x.peerDependencies).map((peer) => ({
					dependent,
					peer,
					optional: Boolean(x.peerDependenciesMeta[peer]?.optional),
				}))
			: [],
	)
	const own = files.filter((file) => directory === '.' || file.path.startsWith(`${directory}/`))
	const haystack = [
		...own.map((file) => file.text),
		// config kept in package.json (postcss, prettier) names packages too
		JSON.stringify(R.omit(raw, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])),
		// JSX compiles to an import nobody writes
		own.some((file) => /\.[jt]sx$/.test(file.path)) ? "'react/jsx-runtime'" : '',
		...(await Promise.all(await buildOutput(packageDirectory, pkg.files))),
	].join('\n')
	const context = {
		directory: packageDirectory,
		haystack,
		declared: new Set(declared),
		peers: new Set(peerEdges.filter((edge) => !edge.optional).map((edge) => edge.peer)),
		optionalPeerOf: R.mapValues(
			R.groupBy(
				peerEdges.filter((edge) => edge.optional),
				(edge) => edge.peer,
			),
			(edges) => edges.map((edge) => edge.dependent),
		),
		installs,
		runBins: R.entries(installs).flatMap(([dep, x]) =>
			x
				? bins(dep, x)
						.filter((bin) => word(bin.name).test(haystack))
						.map((bin) => bin.path)
				: [],
		),
	}
	const findings = await Promise.all(
		declared.map(async (dep) => {
			const why = await reason(dep, context)
			return why ? `${dep} ${why}` : undefined
		}),
	)
	return findings.filter((finding) => finding !== undefined)
}

/** findings per package directory, repo-relative */
export const unusedDeps = async (repository: string) => {
	const root = repositoryRoot(repository)
	const tracked = trackedFiles(root)
	const files = await Promise.all(
		tracked
			.filter((path) => SOURCE.test(path) && !NOT_USAGE.test(path))
			.map(async (path) => ({
				path,
				text: await Bun.file(join(root, path))
					.text()
					.catch(() => ''),
			})),
	)
	const manifests = tracked.filter((path) => path === 'package.json' || path.endsWith('/package.json'))
	return R.fromEntries(
		await Promise.all(
			manifests.map(async (manifest) => [dirname(manifest), await checkManifest(root, manifest, files)] as const),
		),
	)
}

/** declared packages a repo doesn't use, by import, bin, peer or global types; repos are paths under ~/Git or absolute, default every consumer */
export const deps = async (repositories: readonly string[]) => {
	const targets = repositories.length > 0 ? repositories : await findConsumers()
	const findings = (
		await Promise.all(targets.map(async (repository) => ({ repository, byDirectory: await unusedDeps(repository) })))
	).flatMap(({ repository, byDirectory }) =>
		R.entries(byDirectory).flatMap(([directory, lines]) =>
			lines.map((line) => `${join(repository, directory, 'package.json')}: ${line}`),
		),
	)
	for (const finding of findings) console.log(finding)
	if (findings.length > 0) process.exitCode = 1
}
