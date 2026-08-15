import { defineConfig as fullstacksjs } from '@fullstacksjs/eslint-config'
import reactHooks from 'eslint-plugin-react-hooks'
import { isPackageExists } from 'local-pkg'

// Patch a rule's options wherever upstream set them, instead of restating them —
// restated options go stale when upstream changes; patched ones inherit it.
const patchRule = (configs, ruleId, patch) => {
	for (const config of configs)
		if (Array.isArray(config.rules?.[ruleId])) config.rules[ruleId] = patch(config.rules[ruleId])
}

// Anchored to @fullstacksjs/eslint-config v15 (auto-detects next/react/tailwind/tests).
// Everything below is a deviation from it — keep this list short.
export const defineConfig = ({ ignores = [], rules = {}, ...options } = {}) => {
	const hasReact = isPackageExists('react')
	const hasNext = isPackageExists('next')

	const configs = fullstacksjs({
		typescript: { projectService: true }, // unlock typescript-eslint's type-aware tier (no-floating-promises, …)
		files: ['**/*.?([cm])ts', '**/*.?([cm])tsx'], // scope our rules to TS — they reference plugins only loaded there
		...options,
		ignores: ['convex/_generated/**', ...ignores], // committed generated code — .gitignore can't cover it
		rules: {
			'perfectionist/sort-imports': 'off', // vscode organize-imports owns import order
			'@typescript-eslint/consistent-type-definitions': ['error', 'type'],
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'@typescript-eslint/prefer-nullish-coalescing': 'error', // `??` over `||`

			...(hasReact && {
				// fullstacksjs 15.0.1 bug: its strict() helper leaves these two always-off
				'@eslint-react/set-state-in-effect': 'error',
				'@eslint-react/static-components': 'error',

				// AST ports of the hooks rules — superseded by the real compiler rules appended below
				'@eslint-react/rules-of-hooks': 'off',
				'@eslint-react/exhaustive-deps': 'off',

				'@eslint-react/no-missing-context-display-name': 'off', // DevTools nicety, not worth the noise
				'react-refresh/only-export-components': 'off', // helpers/meta colocate with components by convention
				'jsx-a11y/alt-text': ['error', { img: ['Image'] }], // also check next/image
			}),

			...(hasNext && {
				// fullstacksjs runs every next/* rule at warn; restore Vercel's error tier
				'next/inline-script-id': 'error',
				'next/no-assign-module-variable': 'error',
				'next/no-document-import-in-page': 'error',
				'next/no-duplicate-head': 'error',
				'next/no-head-import-in-document': 'error',
				'next/no-html-link-for-pages': 'error',
				'next/no-script-component-in-head': 'error',
				'next/no-sync-scripts': 'error',
				'next/no-location-assign-relative-destination': 'warn', // in the plugin, missing from fullstacksjs's list
			}),

			...rules, // per-repo overrides win last
		},
	})

	// A flat dispatch switch (reducer, keybinding table) is not spaghetti: count the
	// whole switch as 1 (`modified`), inheriting upstream's max unchanged.
	patchRule(configs, 'complexity', ([severity, max]) => [severity, { max: max?.max ?? max, variant: 'modified' }])

	// Upstream demands a blank line after every `case` — even between consecutive cases,
	// which breaks empty fallthrough cases. Last matching entry wins, so append one.
	patchRule(configs, '@stylistic/padding-line-between-statements', (entries) => [
		...entries,
		{ blankLine: 'never', prev: ['case', 'default'], next: ['case', 'default'] },
	])

	// Official React Compiler diagnostics — the one thing fullstacksjs dropped that we keep
	if (hasReact) configs.push(reactHooks.configs.flat['recommended-latest'])

	return configs
}
