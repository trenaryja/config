import js from '@eslint/js'
import next from '@next/eslint-plugin-next'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import deMorgan from 'eslint-plugin-de-morgan'
import { flatConfigs as importX } from 'eslint-plugin-import-x'
import a11y from 'eslint-plugin-jsx-a11y-x'
import reactHooks from 'eslint-plugin-react-hooks'
import regexp from 'eslint-plugin-regexp'
import unicorn from 'eslint-plugin-unicorn'
import { includeIgnoreFile } from 'eslint/config'
import globals from 'globals'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import tseslint from 'typescript-eslint'

/** @import { RuleOptions } from './eslint-rules.gen.js' */
/** @import { Override } from './eslint.d.ts' */
/** @template {string} Prefix @typedef {keyof RuleOptions extends infer Id ? Id extends `${Prefix}${infer Name}` ? Name : never : never} Unprefixed */
/** @template {string} Prefix @typedef {readonly (readonly Unprefixed<Prefix>[])[]} RuleLines */

/** JS too: base tsconfig sets allowJs and checkJs, so the project service types it and every typed rule runs */
const SOURCE = ['**/*.?([cm])[jt]s?(x)']

/**
 * a monorepo member linting itself reads its repo's .gitignore, not a missing `./.gitignore`
 * @param {string} directory
 * @returns {string | undefined}
 */
const gitignoreFrom = (directory) => {
	if (existsSync(join(directory, '.gitignore'))) return join(directory, '.gitignore')
	return existsSync(join(directory, '.git')) || directory === dirname(directory)
		? undefined
		: gitignoreFrom(dirname(directory))
}

/** classic runtime (`jsx: react`) reads `React`; under react-jsx an `import React` is unused, yet by default any JSX counts as using it */
const jsxPragma = () => {
	const path = ts.findConfigFile(process.cwd(), (file) => ts.sys.fileExists(file))
	if (!path) return null
	const options = ts.parseJsonConfigFileContent(
		ts.readConfigFile(path, (file) => ts.sys.readFile(file)).config,
		ts.sys,
		dirname(path),
	).options
	return options.jsx === ts.JsxEmit.React ? 'React' : null
}

/**
 * @template {string} Level
 * @template {string} Id
 * @template {string} Prefix
 * @param {Level} level
 * @param {readonly Id[]} ids
 * @param {Prefix} prefix
 */
const severity = (level, ids, prefix) => {
	/** @type {{ [Rule in `${Prefix}${Id}`]?: Level }} */
	const entries = {}
	for (const id of ids) entries[`${prefix}${id}`] = level
	return entries
}

/** @type {readonly Unprefixed<'@typescript-eslint/'>[]} on top of strict-type-checked and stylistic-type-checked */
const typeScript = ['switch-exhaustiveness-check', 'no-shadow', 'default-param-last', 'no-import-type-side-effects']

/** @type {RuleLines<''>} */
const core = [
	['no-param-reassign', 'no-lonely-if', 'no-unneeded-ternary', 'prefer-template', 'func-names'],
	['array-callback-return', 'no-unmodified-loop-condition', 'no-unreachable-loop', 'no-loop-func'],
	['no-promise-executor-return', 'no-self-compare', 'no-constructor-return'],
	['no-implicit-globals', 'guard-for-in', 'radix', 'no-sequences', 'no-return-assign'],
	['no-useless-call', 'no-useless-computed-key', 'no-useless-rename', 'no-useless-return'],
]

/** @type {readonly Unprefixed<'import-x/'>[]} */
const imports = [
	'no-cycle',
	'no-extraneous-dependencies',
	'no-mutable-exports',
	'no-self-import',
	'no-useless-path-segments',
	'no-absolute-path',
	'no-relative-packages',
]

/** @type {readonly Unprefixed<'import-x/'>[]} tsc already reports these, and they re-parse every imported module */
const coveredByTsc = ['no-unresolved', 'namespace', 'default', 'export']

/** @type {readonly Unprefixed<'jsx-a11y-x/'>[]} */
const a11yBeyondStrict = ['lang', 'no-aria-hidden-on-focusable', 'prefer-tag-over-role']

/** @type {readonly Unprefixed<'unicorn/'>[]} the formatter owns layout; prettier strips the parens no-nested-ternary demands, lowercases the hex number-literal-case uppercases, and indents embedded gql/html/css its own way */
const unicornLayout = [
	'empty-brace-spaces',
	'number-literal-case',
	'template-indent',
	'no-leading-empty-lines',
	'no-nested-ternary',
]

/** @type {readonly Unprefixed<'unicorn/'>[]} tsc reports these: TS2339, TS2304, TS2683, TS7052, TS2554, TS2365, TS2322 */
const unicornCoveredByTsc = [
	'no-undeclared-class-members',
	'no-optional-chaining-on-undeclared-variable',
	'no-this-outside-of-class',
	'no-collection-bracket-access',
	'no-invalid-argument-count',
	'no-chained-comparison',
	'require-proxy-trap-boolean-return',
]

/** @type {RuleLines<''>} tsc or a type-aware @typescript-eslint twin reports these */
const coreTypedTwins = [
	['no-fallthrough', 'valid-typeof', 'use-isnan', 'no-delete-var', 'no-unsafe-optional-chaining'],
	['no-constant-condition', 'no-constant-binary-expression', 'no-async-promise-executor'],
]

/** @type {RuleLines<'unicorn/'>} a type-aware @typescript-eslint twin reports these with the type in hand */
const unicornTypedTwins = [
	['no-unnecessary-boolean-comparison', 'no-useless-coercion', 'no-unnecessary-await', 'no-this-assignment'],
	['no-static-only-class', 'prefer-string-starts-ends-with', 'no-nonstandard-builtin-properties'],
	['prefer-string-trim-start-end', 'prefer-keyboard-event-key', 'no-new-buffer'], // no-deprecated
]

/** @type {readonly Unprefixed<'@typescript-eslint/'>[]} no-non-null-assertion and `assertionStyle: 'never'` already report every case */
const subsumedByBans = [
	'no-non-null-asserted-optional-chain',
	'no-extra-non-null-assertion',
	'no-confusing-non-null-assertion',
	'no-non-null-asserted-nullish-coalescing',
	'prefer-reduce-type-parameter',
]

/** @type {readonly Unprefixed<'@typescript-eslint/'>[]} tsc reports these: TS1540, TS1294 */
const typeScriptCoveredByTsc = [
	'prefer-namespace-keyword',
	'no-namespace',
]

/** @type {readonly Unprefixed<'unicorn/'>[]} one-line and bulleted JSDoc; implied `.length`; named `node:path` imports; `showTitle`-style booleans */
const unicornAgainstHouseStyle = [
	'single-line-block-comment-style',
	'no-asterisk-prefix-in-documentation-comments',
	'explicit-length-check',
	'import-style',
	'consistent-boolean-name',
	'no-await-expression-member',
	'max-nested-calls',
]

const unicornRules = /** @satisfies {RuleOptions} */ ({
	...severity('off', [...unicornLayout, ...unicornCoveredByTsc, ...unicornTypedTwins.flat()], 'unicorn/'),
	'unicorn/logical-assignment-operators': 'off', // its `??=` is a React Compiler bail-out
	'unicorn/no-null': 'off', // React renders and JSON carries null
	'unicorn/filename-case': 'off', // components are PascalCase.tsx beside kebab-case modules
	'unicorn/no-array-callback-reference': 'off', // point-free `.map(R.prop('id'))` is the house style
	'unicorn/switch-case-braces': ['error', 'avoid'],
	...severity('off', unicornAgainstHouseStyle, 'unicorn/'),
	'unicorn/require-array-sort-compare': 'off', // @typescript-eslint's twin reads the element type, so string arrays pass
	'unicorn/name-replacements': 'off', // a dictionary flags `idx` as hard as `res`; whether a short name has one reading depends on context
	'unicorn/prefer-await': 'off', // a `.then().catch()` arrow beats a try block, and try/finally is a React Compiler bail-out
	'unicorn/no-top-level-side-effects': 'off', // fires on every `export default defineConfig()`
	'unicorn/no-top-level-assignment-in-function': 'off', // its fix is `state.x =`, the same module state behind an object
	'unicorn/no-non-function-verb-prefix': 'off', // commands are values named for their action (`getApproval = defineCommand(…)`), and `EditForm` is a component
	'unicorn/no-exports-in-scripts': 'off', // blind to the `if (import.meta.main)` guard Bun scripts export behind
	'unicorn/no-incorrect-template-string-interpolation': 'off', // cli-progress `{bar}` tokens and JSX code samples are literal braces
	'unicorn/no-process-exit': 'off', // CLI kits and `bun scripts/x.ts` exit outside a shebang file
	'unicorn/prefer-switch': 'off', // a `break` per case outgrows the else-if chain it replaces
	'unicorn/prefer-simple-condition-first': 'off', // reordering skips side effects and narrowing, so each hit is a hand audit
	'unicorn/no-break-in-nested-loop': 'off', // flags a `switch` case's `break` inside a loop, the usual argv parser
	'unicorn/no-abusive-eslint-disable': 'off', // noInlineConfig already ignores and reports every disable comment
})

const notUnderscores = { regex: '^_+$', match: false }
const underscoreOk = /** @type {const} */ ({ filter: notUnderscores, leadingUnderscore: 'allow' })

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === 'object' && value !== null

/** @template {string} [Plugin=never] @param {readonly Override<Plugin>[]} overrides */
export const defineConfig = (...overrides) => {
	const gitignore = gitignoreFrom(process.cwd())
	/** @type {unknown} */
	const manifest = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : {}
	return [
		...(gitignore ? [includeIgnoreFile(gitignore)] : []),
		{
			ignores: [
				'**/*.gen.*',
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
		...[...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked].map((config) => ({
			...config,
			files: SOURCE,
		})),
		{
			files: SOURCE,
			languageOptions: { parserOptions: { projectService: true, jsxPragma: jsxPragma() } },
			rules: /** @satisfies {RuleOptions} */ ({
				...severity('error', typeScript, '@typescript-eslint/'),
				'@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': true }],
				'@typescript-eslint/class-literal-property-style': ['error', 'getters'],
				'@typescript-eslint/consistent-generic-constructors': ['error', 'constructor'],
				// `as const` and `satisfies` stay allowed
				'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
				'@typescript-eslint/method-signature-style': ['error', 'property'],
				'@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
				'@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
				'@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
				'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
				'@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }], // `onClick={() => setOpen(true)}`
				'@typescript-eslint/non-nullable-type-assertion-style': 'off', // its fix is `!`, which no-non-null-assertion forbids
				'@typescript-eslint/require-array-sort-compare': ['error', { ignoreStringArrays: true }],
				'@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }], // `() => {}` is the no-op; no-useless-undefined rejects `() => undefined`
				'@typescript-eslint/prefer-regexp-exec': 'off', // its `.exec()` is what unicorn/prefer-regexp-test flags in a condition
				'@typescript-eslint/no-unnecessary-template-expression': 'off', // unicorn/no-useless-template-literals also flags `${n}` and `${any}`
				'@typescript-eslint/prefer-find': 'off', // unicorn/prefer-array-find also flags `const [x] = xs.filter()` and findLast
				'@typescript-eslint/no-require-imports': 'off', // unicorn/prefer-module reports `require`; erasableSyntaxOnly bans `import x = require()`
				...severity('off', [...subsumedByBans, ...typeScriptCoveredByTsc], '@typescript-eslint/'),
			}),
		},
		reactHooks.configs.flat['recommended-latest'],
		a11y.configs.strict,
		regexp.configs.recommended,
		unicorn.configs.recommended,
		deMorgan.configs.recommended,
		importX.recommended,
		importX.typescript,
		...(isRecord(manifest) &&
		[manifest.dependencies, manifest.devDependencies].some((deps) => isRecord(deps) && Object.hasOwn(deps, 'next'))
			? [next.configs['core-web-vitals']]
			: []),
		{
			settings: {
				// eslint's shebang runs Node: without `bun: true`, bare 'bun' resolves to @types/bun and no-extraneous-dependencies flags it
				'import-x/resolver-next': [createTypeScriptImportResolver({ bun: true })],
				// unset, no-cycle walks node_modules: 3x wedding-site's lint
				'import-x/ignore': ['node_modules', String.raw`\.(scss|css|svg|json|mdx)$`],
			},
			rules: /** @satisfies {RuleOptions} */ ({
				...severity('error', core.flat(), ''),
				...severity('error', imports, 'import-x/'),
				...severity('off', coveredByTsc, 'import-x/'),
				...severity('off', coreTypedTwins.flat(), ''),
				'import-x/no-duplicates': 'off', // prettier's organize-imports merges them
				'regexp/no-useless-escape': 'off', // core no-useless-escape covers strings and regexes
				'regexp/no-legacy-features': 'off', // no-deprecated and unicorn/no-nonstandard-builtin-properties report `RegExp.$1`
				'regexp/no-invisible-character': 'off', // unicorn/prefer-escaped-irregular-whitespace reports it in every literal
				'no-misleading-character-class': 'off', // regexp/no-misleading-unicode-character also checks quantifiers and fixes
				'no-irregular-whitespace': ['error', { skipTemplates: true, skipRegExps: true }], // unicorn owns literals, prettier the gaps between tokens
				...severity('error', a11yBeyondStrict, 'jsx-a11y-x/'),
				...unicornRules,
				curly: ['error', 'multi'],
				'arrow-body-style': ['error', 'as-needed'],
				'react-hooks/todo': 'error', // the only rule that reports React Compiler bail-outs (try/finally, for await, import())
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
						caughtErrors: 'none', // unicorn/prefer-optional-catch-binding reports an unused `catch (error)`
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
			}),
		},
		// Next reads `config.matcher` without running the file, so a `String.raw` tag fails the build
		{ files: ['**/{proxy,middleware}.?([cm])[jt]s'], rules: { 'unicorn/prefer-string-raw': 'off' } },
		...overrides,
	]
}
