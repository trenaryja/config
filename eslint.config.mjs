import next from '@next/eslint-plugin-next'
import { flatConfigsToPlugins, pluginsToRulesDTS } from 'eslint-typegen/core'
import { builtinRules } from 'eslint/use-at-your-own-risk'
import { writeFileSync } from 'node:fs'
import { defineConfig } from './eslint.js'

const config = defineConfig({
	files: ['eslint.config.mjs', 'fleet/redundant.ts'],
	rules: {
		// typegen and `verify redundant` need every core rule module, and ESLint 10 deprecates this export without a replacement
		'@typescript-eslint/no-deprecated': [
			'error',
			{
				allow: [
					{ from: 'file', name: 'builtinRules', path: 'node_modules/eslint/lib/types/use-at-your-own-risk.d.ts' },
				],
			},
		],
	},
})

/**
 * eslint-typegen's own `typegen()` is skipped for two of its bugs (2.3.1):
 * - it never awaits its write, so a fresh checkout's `prepare` reads a file that isn't there yet
 * - it emits unicorn/name-replacements' `BooleanObject` twice, so a consumer with `skipLibCheck: false` fails TS2374
 */
const plugins = await flatConfigsToPlugins([
	{ plugins: { '': { rules: Object.fromEntries(builtinRules) } } },
	...config,
	{ plugins: { '@next/next': next } }, // this repo has no `next` dependency, so defineConfig() leaves the plugin out; consumers still need its rule types
])
const types = await pluginsToRulesDTS(plugins, {
	includeAugmentation: false, // ESLint 10's RulesRecord rejects the merge: TS2300 duplicate identifier
	includeIgnoreComments: false,
})
const seen = new Set()
writeFileSync(
	'eslint-rules.gen.d.ts',
	types.replaceAll(/^interface \w+ \{\n[\s\S]*?^\}\n/gm, (block) => (seen.size < seen.add(block).size ? block : '')),
)

export default config
