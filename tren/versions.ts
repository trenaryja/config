import { dirname, join } from 'node:path'
import * as R from 'remeda'
import { z } from 'zod'
import { installedDeps } from './deps.ts'
import type { Found } from './doctor.ts'
import { depsOf, messageOf, readJson, readManifest, strings } from './repo.ts'

const latestSchema = z.object({ version: z.string(), peerDependencies: strings.default({}) })
type Latest = z.infer<typeof latestSchema>
const registry = new Map<string, Promise<Latest | undefined>>()
/** undefined for a package the registry doesn't know (private, git); rejects when the registry can't answer */
const latest = (name: string) => {
	const cached =
		registry.get(name) ??
		fetch(`https://registry.npmjs.org/${name}/latest`).then(async (response) => {
			if (response.status === 404) return
			if (!response.ok) throw new Error(`registry answered ${response.status}`)
			return latestSchema.parse(await response.json())
		})
	registry.set(name, cached)
	return cached
}

/** the package a spec installs: `npm:real@^1` under an alias name */
const registryName = (spec: string, dep: string) => /^npm:(.+?)(?:@[^@/]*)?$/.exec(spec)?.[1] ?? dep

const renovateSchema = z.object({
	packageRules: z
		.array(
			z.object({
				matchDepNames: z.array(z.string()).default([]),
				matchPackageNames: z.array(z.string()).default([]),
				allowedVersions: z.string().optional(),
				description: z.string().optional(),
			}),
		)
		.default([]),
})

/** an `allowedVersions` hold lives while a peer range or engines backs it, or its `description` says why */
const renovateRules = async (root: string) =>
	[
		renovateSchema.parse(await readJson(join(import.meta.dir, '../renovate/base.json'))),
		renovateSchema.parse(await readJson(join(root, 'renovate.json'))),
	].flatMap((config) => config.packageRules)
/** each declared dep once: its spec, installed version, and the installed packages that peer on it */
const modelOf = async (root: string, manifest: string) => {
	const pkg = await readManifest(join(root, manifest))
	const specs = R.pickBy(depsOf(pkg), (range) => !range.startsWith('workspace:'))
	const installs = await installedDeps(join(root, dirname(manifest)), R.keys(specs))
	const deps = R.mapValues(specs, (spec, dep) => ({
		spec,
		current: installs[dep]?.version,
		holders: R.entries(installs).flatMap(([holder, install]) => {
			const range = install?.peerDependencies[dep]
			return range === undefined ? [] : { holder, range }
		}),
	}))
	return { pkg, deps }
}

/** installed versions that violate a peer range today */
export const peerFindings = async (root: string, manifests: readonly string[]) =>
	(
		await Promise.all(
			manifests.map(async (manifest) =>
				R.entries((await modelOf(root, manifest)).deps).flatMap(([dep, { current, holders }]) =>
					current === undefined
						? []
						: holders
								.filter(({ range }) => !Bun.semver.satisfies(current, range))
								.map(({ holder, range }) => ({
									path: manifest,
									message: `${dep} ${current} breaks ${holder}'s peer ${range}`,
								})),
				),
			),
		)
	).flat()

/** which deps can move to their newest, and what holds the rest */
const behindIn = async (root: string, manifest: string, rules: Awaited<ReturnType<typeof renovateRules>>) => {
	type Candidate = { current: string; newest: Latest }
	type Behind = Found & { dep: string; versions: { current: string; latest: string } }
	const { pkg, deps } = await modelOf(root, manifest)
	const checks = await Promise.all(
		R.entries(deps).map(async ([dep, { spec, current }]) => {
			if (!current) return { dep, problem: 'is not installed: run bun install' }
			try {
				const newest = await latest(registryName(spec, dep))
				return newest && Bun.semver.order(newest.version, current) > 0
					? { dep, candidate: { current, newest } }
					: { dep }
			} catch (error) {
				return { dep, problem: `registry unreachable: ${messageOf(error)}` }
			}
		}),
	)
	/** a dep whose state can't be judged: reads as failing, never as up to date */
	const unknown = checks.flatMap(({ dep, problem }) =>
		problem ? { dep, path: manifest, message: `${dep} ${problem}` } : [],
	)
	const candidates = new Map(checks.flatMap(({ dep, candidate }) => (candidate ? [[dep, candidate] as const] : [])))
	const engineOf = (dep: string, version: string) => {
		const engine = pkg.engines[dep.replace(/^@types\//, '')]
		// vsce refuses @types/vscode newer than engines.vscode's floor
		return dep.startsWith('@types/') && engine && Bun.semver.order(version, engine.replace(/^[\^~>=\s]+/, '')) > 0
			? `engines ${engine}`
			: undefined
	}
	const blockedBy = (dep: string, version: string) =>
		rules.filter(
			(rule) =>
				[...rule.matchDepNames, ...rule.matchPackageNames].includes(dep) &&
				rule.allowedVersions !== undefined &&
				!Bun.semver.satisfies(version, rule.allowedVersions),
		)
	/** peer ranges that stop `dep` at its newest, judging deps in `moving` at their newest too */
	const peerHolds = (dep: string, { newest }: Candidate, moving: ReadonlySet<string>) => [
		...(deps[dep]?.holders ?? []).flatMap(({ holder, range }) => {
			const effective = moving.has(holder) ? candidates.get(holder)?.newest.peerDependencies[dep] : range
			return effective === undefined || Bun.semver.satisfies(newest.version, effective)
				? []
				: `${holder} peers ${effective}`
		}),
		...R.entries(newest.peerDependencies).flatMap(([peer, range]) => {
			const version = moving.has(peer) ? candidates.get(peer)?.newest.version : deps[peer]?.current
			return version === undefined || Bun.semver.satisfies(version, range)
				? []
				: `${newest.version} peers ${peer} ${range}`
		}),
	]
	/** lockstep peers (pglite + pglite-socket) each hold the other at its installed version, so what clears together moves together: the largest set none of whose peers break */
	const settle = (moving: ReadonlySet<string>): ReadonlySet<string> => {
		const next = new Set(
			candidates
				.entries()
				.filter(([dep, candidate]) => moving.has(dep) && peerHolds(dep, candidate, moving).length === 0)
				.map(([dep]) => dep),
		)
		return next.size === moving.size ? next : settle(next)
	}
	const moving = settle(
		new Set(
			candidates
				.entries()
				.filter(([dep, { newest }]) => !engineOf(dep, newest.version) && blockedBy(dep, newest.version).length === 0)
				.map(([dep]) => dep),
		),
	)
	const behind = [...candidates].map(([dep, candidate]): Behind => {
		const { current, newest } = candidate
		const message = `${dep} ${current} is behind ${newest.version}`
		const found = { dep, path: manifest, versions: { current, latest: newest.version } }
		if (moving.has(dep)) return { ...found, message }
		const engine = engineOf(dep, newest.version)
		const holders = [...(engine ? [engine] : []), ...peerHolds(dep, candidate, moving)]
		const blocking = blockedBy(dep, newest.version)
		const reasons = [
			...holders,
			...blocking.filter((rule) => rule.description).map((rule) => `renovate: ${rule.description}`),
		]
		const undescribed = blocking.filter((rule) => !rule.description).map((rule) => rule.allowedVersions)
		if (undescribed.length > 0 && holders.length === 0)
			return {
				...found,
				message: `${message}: renovate allows ${undescribed.join(', ')} with no peer range or engines behind it; give the rule a description saying why, or drop it`,
			}
		return reasons.length > 0
			? { ...found, message: `${message}: ${reasons.join('; ')}`, reason: reasons.join('; '), hold: true }
			: { ...found, message }
	})
	return { behind, unknown }
}

/** `unknown` = deps the check cannot judge (not installed, registry down); callers fail on them */
export const behindFindings = async (root: string, manifests: readonly string[]) => {
	const rules = await renovateRules(root)
	const found = await Promise.all(manifests.map((manifest) => behindIn(root, manifest, rules)))
	return { behind: found.flatMap((result) => result.behind), unknown: found.flatMap((result) => result.unknown) }
}
