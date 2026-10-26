import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as R from 'remeda'
import self from '../package.json' with { type: 'json' }
import {
	captures,
	type Ctx,
	depsOf,
	findUp,
	jsonObject,
	type Manifest,
	readJson,
	readManifest,
	readText,
	within,
} from './repo.ts'

const SHIPPED = new Set<string>(R.keys(self.dependencies))

/** code and config only: kindle's epubs alone took 3.5s and name no package; a package.json naming one isn't usage */
const SOURCE =
	/(?:\.(?:[cm]?[jt]sx?|jsonc?|css|scss|html|vue|svelte|astro|ya?ml|toml|sh|mdx)|(?:^|\/)(?:Dockerfile|Makefile))$/

const quoted = (name: string) => new RegExp(String.raw`(['"])${RegExp.escape(name)}(?:/[^'"]*)?\1`)
const word = (name: string, flags = '') => new RegExp(String.raw`(?<![\w@/-])${RegExp.escape(name)}(?![\w-])`, flags)

const installed = async (from: string, dep: string) => {
	const path = findUp(from, `node_modules/${dep}/package.json`)
	return path ? { ...(await readManifest(path)), directory: dirname(path) } : undefined
}
type Installed = NonNullable<Awaited<ReturnType<typeof installed>>>

export const installedDeps = async (directory: string, names: readonly string[]) =>
	R.fromEntries(await Promise.all(names.map(async (name) => [name, await installed(directory, name)] as const)))

const ownTypes = (pkg: Manifest) =>
	Boolean(pkg.types ?? pkg.typings) || JSON.stringify(pkg.exports ?? {}).includes('"types"')

const bins = (dep: string, pkg: Installed) =>
	R.entries(typeof pkg.bin === 'string' ? { [dep.split('/').at(-1) ?? dep]: pkg.bin } : (pkg.bin ?? {})).map(
		([name, path]) => ({ name, path: join(pkg.directory, path) }),
	)

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

/** a lazy `import()` isn't followed */
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

const resolved = (specifier: string, from: string) => {
	try {
		return [Bun.resolveSync(specifier, from)]
	} catch {
		return []
	}
}

const importedModules = (directory: string, haystack: string, dependent: string) =>
	R.unique(captures(haystack, new RegExp(`['"](${RegExp.escape(dependent)}(?:/[^'"]*)?)['"]`, 'g'))).flatMap(
		(specifier) => resolved(specifier, directory),
	)

/** a package preset named by `extends` (release-it, tsconfig) loads plugins the repo itself never names */
const extendedPresets = async (directory: string, text: string) =>
	Promise.all(
		R.unique(captures(text, /"extends":\s*"([^".][^"]*)"/g))
			.flatMap((specifier) => resolved(specifier, directory))
			.map((path) => readText(path)),
	)

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
		.map((path) => Bun.file(path).text())

const checkManifest = async (root: string, manifest: string, files: readonly { path: string; text: string }[]) => {
	const directory = dirname(manifest)
	const packageDirectory = join(root, directory)
	const raw = jsonObject.parse(await readJson(join(root, manifest)))
	const pkg = await readManifest(join(root, manifest))
	const versions = depsOf(pkg)
	/** turbo orders builds by workspace deps, imported or not; config's own dependencies are what it ships */
	const declared = R.keys(versions).filter(
		(dep) =>
			!versions[dep]?.startsWith('workspace:') && (pkg.name !== self.name || !Object.hasOwn(pkg.dependencies, dep)),
	)
	const installs = await installedDeps(packageDirectory, declared)
	const peerEdges = R.entries(installs).flatMap(([dependent, install]) =>
		install
			? R.keys(install.peerDependencies).map((peer) => ({
					dependent,
					peer,
					optional: Boolean(install.peerDependenciesMeta[peer]?.optional),
				}))
			: [],
	)
	const own = files.filter((file) => within(directory, file.path))
	const repoText = [
		...own.map((file) => file.text),
		// config kept in package.json (postcss, prettier) names packages too
		JSON.stringify(R.omit(raw, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])),
		// JSX compiles to an import nobody writes
		own.some((file) => /\.[jt]sx$/.test(file.path)) ? "'react/jsx-runtime'" : '',
		// the React Compiler targeting 17 or 18 compiles to imports of its runtime polyfill
		own.some((file) => /react-?compiler/i.test(file.text) && /target:\s*['"]1[78]['"]/.test(file.text))
			? "'react-compiler-runtime'"
			: '',
		...(await Promise.all(await buildOutput(packageDirectory, pkg.files))),
	].join('\n')
	const haystack = [repoText, ...(await extendedPresets(packageDirectory, repoText))].join('\n')
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
		runBins: R.entries(installs).flatMap(([dep, install]) =>
			install
				? bins(dep, install)
						.filter((bin) => word(bin.name).test(haystack))
						.map((bin) => bin.path)
				: [],
		),
	}
	const findings = await Promise.all(
		declared.map(async (dep) => {
			const why = await reason(dep, context)
			return why ? { check: 'unused', path: manifest, message: `${dep} ${why}` } : undefined
		}),
	)
	return findings.filter((finding) => finding !== undefined)
}

export const unusedDeps = async ({ root, files: tracked, manifests }: Ctx) => {
	const files = await Promise.all(
		tracked
			.filter((path) => SOURCE.test(path) && basename(path) !== 'package.json')
			.map(async (path) => ({
				path,
				text: await readText(join(root, path)),
			})),
	)
	return (await Promise.all(manifests.map(async (manifest) => checkManifest(root, manifest, files)))).flat()
}
