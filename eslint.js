import { defineConfig as fullstacksjs } from '@fullstacksjs/eslint-config'
import reactHooks from 'eslint-plugin-react-hooks'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Amend upstream's options in place — a restated array goes stale when upstream changes
const patchRule = (configs, ruleId, patch) => {
	for (const config of configs)
		if (Array.isArray(config.rules?.[ruleId])) config.rules[ruleId] = patch(config.rules[ruleId])
}

/** Tailwind v4 has no config file: the CSS importing it is the entry point */
const tailwindEntries = globSync('**/*.css', {
	exclude: ['**/node_modules/**', '**/target/**'], // Cargo output: 25ms of walk in extensions, 2ms without
}).filter((path) => /@import\s+["']tailwindcss/.test(readFileSync(path, 'utf8')))

const packageDir = (path) => {
	const dir = dirname(path)
	return dir === '.' || existsSync(`${dir}/package.json`) ? dir : packageDir(dir)
}

/** an entry lints only its own package, so each app in a monorepo reads its own CSS */
const sourceOf = (entry) => join(packageDir(entry), '**/*.?([cm])[jt]s?(x)')

export const defineConfig = ({ ignores = [], rules = {}, ...options } = {}) => {
	const configs = fullstacksjs({
		// Each key is upstream's on-switch for its module, and its own detection reads false from a monorepo root.
		// `typescript: {}` is not enough — without projectService the type-aware rules below exit 2.
		typescript: { projectService: true },
		react: { compilationMode: 'all' },
		next: true,
		...(tailwindEntries.length > 0 && {
			tailwind: {
				overrides: {
					files: tailwindEntries.map(sourceOf),
					rules: {
						'better-tailwindcss/enforce-consistent-class-order': 'off', // formatting, not a defect
						// collapse rewrote `relative overflow-hidden` into ui's own `has-timeout-bar` @utility
						'better-tailwindcss/enforce-canonical-classes': ['warn', { collapse: false }],
					},
				},
			},
		}),
		files: ['**/*.?([cm])ts', '**/*.?([cm])tsx'], // unscoped, our TS-only plugin names crash ESLint on eslint.config.mjs
		...options,
		ignores: [
			'**/*-env.d.ts', // regenerated on build, so a stale disable inside one is unfixable in source
			'**/target/', // Cargo output; cmake litters it with `compiler_depend.ts` stubs that are not TypeScript
			'**/_generated/', // codegen (Convex) rewritten on every dev run
			...ignores,
		],
		rules: {
			'perfectionist/sort-imports': 'off', // vscode organize-imports owns import order
			'perfectionist/sort-union-types': 'off', // written order carries meaning
			'regexp/sort-character-class-elements': 'off', // same

			// Upstream gates its type-aware block on a tsconfigRootDir it never passes,
			// so naming these is the only thing that turns them on.
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'@typescript-eslint/prefer-nullish-coalescing': 'error',
			'@typescript-eslint/switch-exhaustiveness-check': 'error',

			// Deliberate: bit protocols, counters, serial I/O — not smells
			'no-bitwise': 'off',
			'no-plusplus': 'off',
			'no-await-in-loop': 'off',

			// AST ports of rules the compiler plugin below reports better — one defect, one rule id
			'@eslint-react/rules-of-hooks': 'off',
			'@eslint-react/exhaustive-deps': 'off',
			'@eslint-react/refs': 'off',

			// Not a port: the react-hooks twin misses setState in .ts hook files, and upstream leaves this off
			'@eslint-react/set-state-in-effect': 'error',

			'@typescript-eslint/strict-void-return': 'off', // demands `void` or braces on every `() => fn()` handler whose return nothing reads
			'@eslint-react/no-missing-context-display-name': 'off', // its fixer splices into the next statement, emitting invalid TS
			'@eslint-react/dom-no-missing-button-type': 'off', // blind to prop spreads — zag-js sets type at runtime
			'@eslint-react/dom-no-missing-iframe-sandbox': 'off', // a usable sandbox needs allow-scripts + allow-same-origin, which is the escape
			'react-refresh/only-export-components': 'off', // a codepen pen is one file with zero exports
			'jsx-a11y/alt-text': ['error', { img: ['Image'] }], // also check next/image
			'next/no-location-assign-relative-destination': 'error', // in the plugin, absent from upstream's list

			// jsx-a11y counts onError/onLoad as interactions, so an <img> with a load-failure
			// fallback is flagged with no keyboard equivalent to add. The rest is its default.
			'jsx-a11y/no-noninteractive-element-interactions': [
				'error',
				{ handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp'] },
			],

			...rules,
		},
	})

	// `interface` on a published surface invites consumer declaration merging
	patchRule(configs, '@typescript-eslint/consistent-type-definitions', ([severity]) => [severity, 'type'])

	// A flat dispatch switch (reducer, keybinding table) is not spaghetti: count it as 1
	patchRule(configs, 'complexity', ([severity, max]) => [severity, { max: max?.max ?? max, variant: 'modified' }])

	// Upstream wants a blank line after every `case`, which breaks empty fallthrough cases
	patchRule(configs, '@stylistic/padding-line-between-statements', (entries) => [
		...entries,
		{ blankLine: 'any', prev: ['case', 'default'], next: ['case', 'default'] },
	])

	// CLAUDE.md's `_` prefix — upstream allows it on parameters but not variables
	patchRule(configs, '@typescript-eslint/naming-convention', ([severity, ...entries]) => [
		severity,
		...entries.map((entry) => (entry.selector === 'variable' ? { ...entry, leadingUnderscore: 'allow' } : entry)),
	])

	// Upstream's next config is unscoped, so an entry in `rules` above would only reach .ts/.tsx
	const nextOverrides = {
		// its getRootDirs reads cwd only, so create() warns to raw stderr from every repo whose root has no route dir
		'next/no-html-link-for-pages': ['pages', 'src/pages', 'app', 'src/app'].some((dir) => existsSync(dir))
			? 'error'
			: 'off',
		'next/no-img-element': 'off', // `next: true` is unconditional, and a repo without Next has no next/image to move to
	}
	for (const config of configs)
		for (const [ruleId, severity] of Object.entries(nextOverrides))
			if (config.rules?.[ruleId]) config.rules[ruleId] = severity

	// Upstream takes one entryPoint; settings merge per file, so each package gets its own
	configs.push(
		...tailwindEntries.map((entryPoint) => ({
			files: [sourceOf(entryPoint)],
			settings: { 'better-tailwindcss': { entryPoint } },
		})),
	)

	// Upstream's react block covers JS, where no type info exists: this typed rule crashed the run on the first `&&`
	configs.push({ files: ['**/*.?([cm])js?(x)'], rules: { '@eslint-react/no-leaked-conditional-rendering': 'off' } })

	// React Compiler diagnostics: fullstacksjs registers none, and disable comments name them
	configs.push(reactHooks.configs.flat['recommended-latest'])

	return configs
}
