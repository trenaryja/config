import { dirname, join } from 'node:path'
import { styleText } from 'node:util'
import * as R from 'remeda'
import { z } from 'zod'
import { columns } from './columns.ts'
import {
	depsOf,
	editJson,
	formatFiles,
	jsonObject,
	manifestsIn,
	readJson,
	readManifest,
	strings,
	trackedFiles,
} from './repo.ts'
import { defineCommand, jsonFlag, run } from './run.ts'
import { behindFindings } from './versions.ts'

/** the part of a version whose change breaks consumers: 0.x breaks on the minor, as Renovate counts it */
const breakingPart = (version: string) => {
	const [major = '0', minor = '0'] = version.split('.', 2)
	return major === '0' ? `0.${minor}` : major
}

const packumentSchema = z.object({ versions: z.record(z.string(), z.object({ deprecated: z.string().optional() })) })
/** newest stable, non-deprecated version: within `current`'s breaking part unless `anyMajor` */
const newest = async (dep: string, current: string, anyMajor: boolean) => {
	const response = await fetch(`https://registry.npmjs.org/${dep}`, {
		headers: { accept: 'application/vnd.npm.install-v1+json' },
	})
	if (!response.ok) return
	return R.entries(packumentSchema.parse(await response.json()).versions)
		.filter(
			([version, meta]) =>
				!version.includes('-') && !meta.deprecated && (anyMajor || breakingPart(version) === breakingPart(current)),
		)
		.map(([version]) => version)
		.toSorted(Bun.semver.order)
		.at(-1)
}

type Row = { kind: keyof typeof KINDS; path: string; dep: string; from: string; to: string; note?: string }
const rowOf = (
	kind: Row['kind'],
	{ path, dep, versions }: { path: string; dep: string; versions: { current: string; latest: string } },
	note?: string,
): Row => ({ kind, path, dep, from: versions.current, to: versions.latest, note })
const KINDS = {
	updated: { tone: 'green', mark: '✓' },
	major: { tone: 'yellow', mark: '↑' },
	held: { tone: 'cyan', mark: '⏸' },
	skipped: { tone: 'gray', mark: '⊘' },
} as const

/** styleText drops the colour when stdout isn't a terminal */
const report = (rows: readonly Row[], current: readonly string[], dryRun: boolean) => {
	const aligned = R.zip(rows, columns(rows.map((row) => [row.dep, row.from, row.to])))
	const line = ([{ kind, note }, [dep = '', from = '', to = '']]: (typeof aligned)[number]) =>
		`  ${styleText(KINDS[kind].tone, KINDS[kind].mark)} ${dep}  ${styleText('dim', from)} → ${styleText(KINDS[kind].tone, to)}${note ? `  ${styleText('dim', note)}` : ''}`
	const sections = R.entries(R.groupBy(aligned, ([row]) => row.path)).map(
		([path, group]) =>
			`${styleText('bold', path)}\n${R.sortBy(
				group,
				([row]) => R.keys(KINDS).indexOf(row.kind),
				([row]) => row.dep,
			)
				.map(line)
				.join('\n')}`,
	)
	const ofKind = (kind: Row['kind']) => rows.filter((row) => row.kind === kind)
	const majors = ofKind('major').map((row) => row.dep)
	const summary = [
		`${ofKind('updated').length} ${dryRun ? 'to update' : 'updated'}`,
		majors.length > 0 && `${majors.length} major waiting: tren update --latest ${R.unique(majors).join(' ')}`,
		ofKind('held').length > 0 && `${ofKind('held').length} held`,
		ofKind('skipped').length > 0 && `${ofKind('skipped').length} skipped`,
		current.length > 0 && `already latest or not a dependency: ${current.join(', ')}`,
	].filter(Boolean)
	return [...sections, summary.join(styleText('dim', ' · '))].join('\n\n')
}

/** a spec update can rewrite: a version with an optional ^ or ~; `npm:`, ranges, `catalog:`, `github:` are left */
const PLAIN = /^([\^~]?)\d\S*$/

/** one diagnose-and-apply round; `done` holds `path:dep@version` moves already made, so a version bun won't install can't loop */
const updatePass = async (
	root: string,
	positionals: readonly string[],
	{ latest, dryRun, install }: { latest: boolean; dryRun: boolean; install: readonly string[] },
	done: Set<string>,
) => {
	const named = (finding: { dep: string }) => positionals.length === 0 || positionals.includes(finding.dep)
	const manifests = manifestsIn(trackedFiles(root))
	const { behind: all, unknown } = await behindFindings(root, manifests)
	if (unknown.some(named))
		throw new Error(
			`cannot tell what is outdated:\n${unknown
				.filter(named)
				.map(({ path, message }) => `  ${path}: ${message}`)
				.join('\n')}`,
		)
	const findings = all.filter(named)
	const specs = Object.fromEntries(
		await Promise.all(manifests.map(async (path) => [path, depsOf(await readManifest(join(root, path)))] as const)),
	)
	const [held, unheld] = R.partition(findings, (finding) => Boolean(finding.hold))
	const [behind, unrewritable] = R.partition(unheld, ({ path, dep }) => PLAIN.test(specs[path]?.[dep] ?? ''))
	const skipped = unrewritable.map((finding) =>
		rowOf('skipped', finding, `spec "${specs[finding.path]?.[finding.dep]}" can't be rewritten`),
	)
	const plans = await Promise.all(
		behind.map(async ({ dep, path, versions }) => {
			const major = breakingPart(versions.latest) !== breakingPart(versions.current)
			const to = latest || major ? await newest(dep, versions.current, latest) : versions.latest
			return { dep, path, versions, skipsMajor: major && !latest, to }
		}),
	)
	const applied: Row[] = []
	const moves = plans.filter(
		(plan) =>
			plan.to !== undefined &&
			Bun.semver.order(plan.to, plan.versions.current) > 0 &&
			!done.has(`${plan.path}:${plan.dep}@${plan.to}`),
	)
	for (const [manifest, changes] of R.entries(R.groupBy(moves, (plan) => plan.path))) {
		const apply = (json: Record<string, unknown>) => {
			for (const field of ['dependencies', 'devDependencies']) {
				const fieldSpecs = strings.safeParse(json[field]).data
				if (!fieldSpecs) continue
				for (const { dep, versions, to = versions.current } of changes) {
					const prefix = fieldSpecs[dep]?.match(PLAIN)?.[1]
					if (prefix === undefined) continue
					fieldSpecs[dep] = `${prefix}${to}`
					done.add(`${manifest}:${dep}@${to}`)
					applied.push({ kind: 'updated', path: manifest, dep, from: versions.current, to })
				}
				json[field] = fieldSpecs
			}
		}
		if (dryRun) {
			apply(jsonObject.parse(await readJson(join(root, manifest))))
			continue
		}
		await editJson(root, manifest, apply).run()
		const code = await run(['bun', 'install', ...install], join(root, dirname(manifest)), 2)
		if (code) return { code, findings, held, plans, applied, skipped }
	}
	return { code: 0, findings, held, plans, applied, skipped }
}

export default defineCommand({
	scope: 'repo',
	passThrough: 'bun install',
	positionals: '[<dep>...]',
	options: {
		latest: { type: 'boolean', about: 'take majors too' },
		'dry-run': { type: 'boolean', about: 'print the first round of moves without writing or installing' },
		json: jsonFlag('[{ kind, path, dep, from, to, note }], one row per move, major waiting or hold'),
	},
	details: `Minors and patches by default; a major is listed until --latest takes it. Naming deps narrows either mode to them.
Skips every dep doctor holds back — a peer range, engines or a described Renovate allowedVersions keeps it — and prints why.
Repeats until a round moves nothing, so a hold that the round's own updates clear (react before react-dom) doesn't need a second run.
Any other flag goes to each bun install; give a valued one as --flag=value, or its value reads as a dep.`,
	run: async ({ args, values, positionals, root }) => {
		const done = new Set<string>()
		const mode = {
			latest: Boolean(values.latest),
			dryRun: Boolean(values['dry-run']),
			install: args.filter((arg) => arg.startsWith('-')),
		}
		const first = await updatePass(root, positionals, mode, done)
		if (first.code) return first.code
		let last = first
		const moved = [...first.applied]
		while (!mode.dryRun && last.applied.length > 0) {
			last = await updatePass(root, positionals, mode, done)
			if (last.code) return last.code
			moved.push(...last.applied)
		}
		const applied = R.values(R.groupBy(moved, (row) => `${row.path}:${row.dep}`)).map((moves) => ({
			...R.last(moves),
			from: R.first(moves).from,
		}))
		if (!mode.dryRun) await formatFiles(root, R.unique(applied.map((row) => row.path)))
		const rows: Row[] = [
			...applied,
			...last.plans.filter((plan) => plan.skipsMajor).map((plan) => rowOf('major', plan)),
			...last.skipped,
			...last.held.map((finding) => rowOf('held', finding, finding.reason)),
		]
		console.log(
			values.json
				? JSON.stringify(rows, null, '\t')
				: report(
						rows,
						positionals.filter((dep) => first.findings.every((finding) => finding.dep !== dep)),
						mode.dryRun,
					),
		)
		return 0
	},
})
