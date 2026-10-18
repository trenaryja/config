import { includeIgnoreFile } from '@eslint/compat'
import js from '@eslint/js'
import next from '@next/eslint-plugin-next'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { flatConfigs as importX } from 'eslint-plugin-import-x'
import a11y from 'eslint-plugin-jsx-a11y-x'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import { getBunBuiltinModules } from 'is-bun-module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import tseslint from 'typescript-eslint'

const TS = ['**/*.?([cm])ts', '**/*.?([cm])tsx']

/**
 * a monorepo member linting itself reads its repo's .gitignore, not a missing `./.gitignore`
 * @param {string} dir
 * @returns {string | undefined}
 */
const gitignoreFrom = (dir) => {
	if (existsSync(join(dir, '.gitignore'))) return join(dir, '.gitignore')
	if (existsSync(join(dir, '.git')) || dir === dirname(dir)) return undefined
	return gitignoreFrom(dirname(dir))
}

/** classic runtime (`jsx: react`) reads `React`; under react-jsx an `import React` is unused, yet by default any JSX counts as using it */
const jsxPragma = () => {
	const path = ts.findConfigFile(process.cwd(), ts.sys.fileExists)
	if (!path) return null
	const options = ts.parseJsonConfigFileContent(
		ts.readConfigFile(path, ts.sys.readFile).config,
		ts.sys,
		dirname(path),
	).options
	return options.jsx === ts.JsxEmit.React ? 'React' : null
}

/** @param {readonly string[]} ids */
const errors = (ids, prefix = '') => Object.fromEntries(ids.map((id) => [`${prefix}${id}`, 'error']))

/** type-aware: misuse of typed values that tsc lets through */
const typeSafety = [
	...['no-unsafe-assignment', 'no-unsafe-member-access', 'no-unsafe-call', 'no-unsafe-argument', 'no-unsafe-return'],
	...['no-floating-promises', 'no-misused-promises', 'await-thenable', 'require-await', 'no-unnecessary-condition'],
	...['no-unnecessary-type-assertion', 'no-base-to-string', 'switch-exhaustiveness-check', 'unbound-method'],
]

const typeScript = [
	...['adjacent-overload-signatures', 'array-type', 'no-array-constructor', 'no-confusing-non-null-assertion'],
	...['no-duplicate-enum-values', 'no-dynamic-delete', 'no-extra-non-null-assertion'],
	...['no-invalid-void-type', 'no-misused-new', 'no-namespace', 'no-non-null-asserted-nullish-coalescing'],
	...['no-non-null-asserted-optional-chain', 'no-require-imports', 'no-this-alias', 'no-useless-constructor'],
	...['no-wrapper-object-types', 'prefer-namespace-keyword', 'triple-slash-reference', 'unified-signatures'],
	...['no-explicit-any', 'no-non-null-assertion', 'no-shadow', 'default-param-last'],
	...['consistent-indexed-object-style', 'no-import-type-side-effects', 'no-unnecessary-type-constraint'],
	...['no-unsafe-declaration-merging', 'no-useless-empty-export'],
	...['prefer-as-const', 'prefer-for-of', 'prefer-function-type', 'no-empty-function'],
]

const core = [
	...['no-param-reassign', 'no-else-return', 'no-lonely-if', 'no-unneeded-ternary', 'prefer-template', 'func-names'],
	...['array-callback-return', 'no-unmodified-loop-condition', 'no-unreachable-loop', 'no-loop-func'],
	...['no-promise-executor-return', 'no-self-compare', 'no-constructor-return'],
	...['no-implicit-globals', 'guard-for-in', 'radix', 'no-sequences', 'no-return-assign'],
	...['no-useless-call', 'no-useless-computed-key', 'no-useless-rename', 'no-useless-return', 'no-useless-concat'],
]

const imports = ['no-cycle', 'no-extraneous-dependencies', 'no-mutable-exports', 'no-self-import']

/** tsc already reports these, and they re-parse every imported module */
const coveredByTsc = ['no-unresolved', 'named', 'namespace', 'default', 'no-named-as-default-member']

const notUnderscores = { regex: '^_+$', match: false }
const underscoreOk = { filter: notUnderscores, leadingUnderscore: 'allow' }

/** No options: every rule decision lives here, and each consumer's eslint.config.mjs stays two lines */
export const defineConfig = () => {
	const gitignore = gitignoreFrom(process.cwd())
	const manifest = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {}
	return [
		...(gitignore ? [includeIgnoreFile(gitignore)] : []),
		{
			ignores: [
				'**/*.gen.ts',
				'**/_generated/', // codegen (Convex) rewritten on every dev run
				'**/*-env.d.ts', // regenerated on build
				'**/target/', // Cargo output; cmake litters it with `compiler_depend.ts` stubs that are not TypeScript
			],
		},
		// a fix belongs in the code or in this file, never in a comment
		{ linterOptions: { noInlineConfig: true } },
		{ languageOptions: { globals: { ...globals.browser, ...globals.node } } },
		js.configs.recommended,
		tseslint.configs.base,
		{ ...tseslint.configs.eslintRecommended, files: TS },
		{
			files: TS,
			languageOptions: { parserOptions: { projectService: true, jsxPragma: jsxPragma() } },
			rules: {
				...errors([...typeSafety, ...typeScript], '@typescript-eslint/'),
				'@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true }],
				'@typescript-eslint/class-literal-property-style': ['error', 'getters'],
				'@typescript-eslint/consistent-generic-constructors': ['error', 'constructor'],
				// `as const` and `satisfies` stay allowed
				'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
				'@typescript-eslint/method-signature-style': ['error', 'property'],
				'@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
				'@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
				'@typescript-eslint/no-invalid-this': ['error', { capIsConstructor: false }],
				'@typescript-eslint/no-unused-expressions': [
					'error',
					{ allowShortCircuit: false, allowTaggedTemplates: false, allowTernary: false },
				],
				'@typescript-eslint/prefer-literal-enum-member': ['error', { allowBitwiseExpressions: true }],
				'@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
				'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
				'require-await': 'off',
			},
		},
		reactHooks.configs.flat['recommended-latest'],
		a11y.configs.strict,
		importX.recommended,
		importX.typescript,
		...('next' in { ...manifest.dependencies, ...manifest.devDependencies } ? [next.configs['core-web-vitals']] : []),
		{
			settings: {
				'import-x/resolver-next': [createTypeScriptImportResolver({ bun: true })],
				'import-x/core-modules': getBunBuiltinModules(),
				// unset, no-cycle walks node_modules: 3x wedding-site's lint
				'import-x/ignore': ['node_modules', String.raw`\.(scss|css|svg|json|mdx)$`],
			},
			rules: {
				...errors(core),
				...errors(imports, 'import-x/'),
				...Object.fromEntries(coveredByTsc.map((id) => [`import-x/${id}`, 'off'])),
				complexity: ['error', { max: 14, variant: 'modified' }], // a flat dispatch switch counts as 1
				'max-depth': ['error', 4],
				'max-lines': ['error', 2500],
				'max-lines-per-function': ['error', 150],
				'max-nested-callbacks': ['error', 7],
				'max-params': ['error', 4],
				'max-statements': ['error', 40],
				'@typescript-eslint/naming-convention': [
					'error',
					{ selector: 'default', format: ['camelCase'], filter: notUnderscores },
					{ selector: 'import', format: null },
					{ selector: 'function', format: ['camelCase', 'PascalCase'] },
					{ selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'], ...underscoreOk },
					{ selector: 'parameter', format: ['camelCase', 'PascalCase'], ...underscoreOk },
					{ selector: 'memberLike', format: null },
					{
						selector: 'memberLike',
						modifiers: ['static'],
						format: ['camelCase', 'PascalCase'],
						leadingUnderscore: 'allow',
					},
					{ selector: 'memberLike', modifiers: ['private'], format: ['camelCase'], leadingUnderscore: 'allow' },
					{ selector: 'typeLike', format: ['PascalCase'] },
					{ selector: 'enumMember', format: ['PascalCase'] },
					{ selector: 'interface', format: ['PascalCase'], custom: { regex: '^I[A-Z]', match: false } },
				],
				'@typescript-eslint/consistent-type-definitions': ['error', 'type'], // `interface` on a published surface invites declaration merging
				'@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
				'no-unused-vars': 'off',
				'@typescript-eslint/no-unused-vars': [
					'error',
					{
						argsIgnorePattern: '^_',
						varsIgnorePattern: '^_',
						caughtErrorsIgnorePattern: '^_',
						destructuredArrayIgnorePattern: '^_',
						ignoreRestSiblings: true,
					},
				],
				'object-shorthand': ['error', 'properties'],
				eqeqeq: ['error', 'smart'],
				'no-control-regex': 'off', // matching separators and ANSI escapes is deliberate; an invisible pasted one is the rare case
				'no-eval': ['error', { allowIndirect: true }], // `(0, eval)` runs in global scope, out of reach of the caller's locals
				'require-atomic-updates': ['error', { allowProperties: true }],
				'jsx-a11y-x/alt-text': ['error', { img: ['Image'] }], // also check next/image
				'jsx-a11y-x/media-has-caption': 'off', // flags every <video> without a <track>, speech or not; personal sites don't caption
				// jsx-a11y counts onError/onLoad as interactions, so an <img> with a load-failure fallback has no keyboard equivalent to add
				'jsx-a11y-x/no-noninteractive-element-interactions': [
					'error',
					{ handlers: ['onClick', 'onMouseDown', 'onMouseUp', 'onKeyPress', 'onKeyDown', 'onKeyUp'] },
				],
				// ARIA's grid pattern on a native table (recommended allows it, strict doesn't); a click-to-play <pre> keeps its text rendering
				'jsx-a11y-x/no-noninteractive-element-to-interactive-role': [
					'error',
					{ table: ['grid'], td: ['gridcell'], pre: ['button'] },
				],
				'jsx-a11y-x/no-noninteractive-tabindex': ['error', { tags: ['div'] }], // daisyUI's focus collapse is a tabbable <div>; ARIA has no role for "expands on focus"
			},
		},
	]
}
