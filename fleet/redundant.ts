import { ESLint, type Linter } from 'eslint'
import { builtinRules } from 'eslint/use-at-your-own-risk'
import { isDeepStrictEqual } from 'node:util'
import * as R from 'remeda'
import { z } from 'zod'
import { defineConfig } from '../eslint.js'

/** one probe per file kind a block can scope to */
const PROBES = ['src/a.ts', 'src/a.tsx', 'src/a.js', 'proxy.ts']
const SEVERITY: Record<string, number> = { off: 0, warn: 1, error: 2 }

const resolved = z.object({
	rules: z.record(z.string(), z.unknown()).default({}),
	settings: z.record(z.string(), z.unknown()).default({}),
})

const normalize = (entry: unknown) => {
	const [level, ...options] = [entry].flat()
	const severity = typeof level === 'number' ? level : (SEVERITY[String(level)] ?? 0)
	return severity ? [severity, ...options] : [0]
}

const resolve = async (config: Linter.Config[], file: string) =>
	resolved.parse(
		await new ESLint({ cwd: import.meta.dir, overrideConfigFile: true, overrideConfig: config }).calculateConfigForFile(
			file,
		),
	)

/** entries in eslint.js's own blocks that change nothing: already the preset's value, or the rule's default options */
export const redundant = async () => {
	const full = defineConfig()
	// every preset carries a `name` or `plugins`; eslint.js's own rule blocks neither
	const ours = full.filter((block) => block.rules && !block.name && !block.plugins)
	const plugins: Record<string, ESLint.Plugin> = R.mergeAll(full.map((block) => block.plugins ?? {}))
	const defaults = (ruleId: string) => {
		const slash = ruleId.lastIndexOf('/')
		const rule =
			slash === -1 ? builtinRules.get(ruleId) : plugins[ruleId.slice(0, slash)]?.rules?.[ruleId.slice(slash + 1)]
		return rule?.meta?.defaultOptions
	}
	const marked = full.map((block) =>
		ours.includes(block) ? { ...block, settings: { ...block.settings, [`probe${ours.indexOf(block)}`]: true } } : block,
	)
	const findings: string[] = []
	for (const [index, block] of ours.entries()) {
		const stripped = full.map((x) => (x === block ? { ...x, rules: {} } : x))
		const resolutions = await Promise.all(
			PROBES.map(async (file) => ({
				applies: new Set(R.keys((await resolve(marked, file)).settings)).has(`probe${index}`),
				full: await resolve(full, file),
				stripped: await resolve(stripped, file),
			})),
		)
		const probes = resolutions.filter((probe) => probe.applies)
		for (const [ruleId, entry] of R.entries(block.rules ?? {})) {
			const same = (probe: (typeof probes)[number]) =>
				isDeepStrictEqual(normalize(probe.full.rules[ruleId]), normalize(probe.stripped.rules[ruleId]))
			if (probes.every(same)) findings.push(`${ruleId}: resolves the same without this entry`)
			const options = normalize(entry).slice(1)
			if (options.length > 0 && isDeepStrictEqual(options, defaults(ruleId)))
				findings.push(`${ruleId}: options are the rule's defaults`)
		}
	}
	for (const finding of findings) console.log(finding)
	if (findings.length > 0) process.exitCode = 1
}
