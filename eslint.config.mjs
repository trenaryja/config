import next from '@next/eslint-plugin-next'
import typegen from 'eslint-typegen'
import { readFileSync, writeFileSync } from 'node:fs'
import { defineConfig } from './eslint.js'

const config = defineConfig()
const typesPath = 'eslint-rules.gen.d.ts'

// this repo has no `next` dependency, so defineConfig() leaves the plugin out; consumers still need its rule types
await typegen([...config, { plugins: { '@next/next': next } }], {
	dtsPath: typesPath,
	includeAugmentation: false, // ESLint 10's RulesRecord rejects the merge: TS2300 duplicate identifier
	includeIgnoreComments: false,
})

/** eslint-typegen emits unicorn/name-replacements' `BooleanObject` twice: a consumer with `skipLibCheck: false` fails TS2374 */
const seen = new Set()
writeFileSync(
	typesPath,
	readFileSync(typesPath, 'utf8').replaceAll(/^interface \w+ \{\n[\s\S]*?^\}\n/gm, (block) =>
		seen.size < seen.add(block).size ? block : '',
	),
)

export default config
