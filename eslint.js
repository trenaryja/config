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

import { GENERATED } from './lib/generated-globs.js'
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

/** `jsx: react` needs `React` in scope; under react-jsx, JSX alone mustn't mark `import React` used */
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
const typeScriptOn = ['switch-exhaustiveness-check', 'no-shadow', 'default-param-last', 'no-import-type-side-effects']

/** @type {RuleLines<''>} */
const coreOn = [
	['no-param-reassign', 'no-lonely-if', 'no-unneeded-ternary', 'prefer-template', 'func-names'],
	['array-callback-return', 'no-unmodified-loop-condition', 'no-unreachable-loop', 'no-loop-func'],
	['no-promise-executor-return', 'no-self-compare', 'no-constructor-return'],
	['no-implicit-globals', 'guard-for-in', 'radix', 'no-sequences', 'no-return-assign'],
	['no-useless-call', 'no-useless-computed-key', 'no-useless-rename', 'no-useless-return'],
]

/** @type {readonly Unprefixed<'import-x/'>[]} */
const importsOn = [
	'no-cycle',
	'no-extraneous-dependencies',
	'no-mutable-exports',
	'no-self-import',
	'no-useless-path-segments',
	'no-absolute-path',
	'no-relative-packages',
]

/** @type {readonly Unprefixed<'import-x/'>[]} tsc already reports these, and they re-parse every imported module */
const importCoveredByTsc = ['no-unresolved', 'namespace', 'default', 'export']

/** @type {readonly Unprefixed<'jsx-a11y-x/'>[]} not prefer-tag-over-role: daisyUI's radial-progress is a `role=progressbar` div, an avatar `role=img` holds children */
const a11yBeyondStrict = ['lang', 'no-aria-hidden-on-focusable']

/** @type {readonly Unprefixed<'unicorn/'>[]} the formatter owns layout */
const unicornLayout = [
	'empty-brace-spaces',
	'number-literal-case', // prettier lowercases the hex it uppercases
	'template-indent', // prettier indents embedded gql/html/css its own way
	'no-leading-empty-lines',
	'no-nested-ternary', // prettier strips the parens it demands
]

/** @type {readonly Unprefixed<'unicorn/'>[]} tsc reports these */
const unicornCoveredByTsc = [
	'no-undeclared-class-members', // TS2339
	'no-optional-chaining-on-undeclared-variable', // TS2304
	'no-this-outside-of-class', // TS2683
	'no-collection-bracket-access', // TS7052
	'no-invalid-argument-count', // TS2554
	'no-chained-comparison', // TS2365
	'require-proxy-trap-boolean-return', // TS2322
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
	['prefer-string-trim-start-end', 'prefer-keyboard-event-key', 'no-new-buffer'], // @typescript-eslint/no-deprecated reports these
]

/** @type {readonly Unprefixed<'@typescript-eslint/'>[]} no-non-null-assertion and `assertionStyle: 'never'` already report every case */
const subsumedByBans = [
	'no-non-null-asserted-optional-chain',
	'no-extra-non-null-assertion',
	'no-confusing-non-null-assertion',
	'no-non-null-asserted-nullish-coalescing',
	'prefer-reduce-type-parameter',
]

/** @type {readonly Unprefixed<'@typescript-eslint/'>[]} tsc reports these */
const typeScriptCoveredByTsc = [
	'prefer-namespace-keyword', // TS1540
	'no-namespace', // TS1294
]

const unicornRules = /** @satisfies {RuleOptions} */ ({
	...severity('off', [...unicornLayout, ...unicornCoveredByTsc, ...unicornTypedTwins.flat()], 'unicorn/'),
	'unicorn/logical-assignment-operators': 'off', // its `??=` is a React Compiler bail-out
	'unicorn/no-null': 'off', // React renders and JSON carries null
	'unicorn/filename-case': 'off', // components are PascalCase.tsx beside kebab-case modules
	'unicorn/no-array-callback-reference': 'off', // point-free `.map(R.prop('id'))` is the house style
	'unicorn/switch-case-braces': ['error', 'avoid'],
	'unicorn/single-line-block-comment-style': 'off', // one-line JSDoc
	'unicorn/no-asterisk-prefix-in-documentation-comments': 'off', // bulleted JSDoc
	'unicorn/explicit-length-check': 'off', // implied `.length`
	'unicorn/import-style': 'off', // named `node:path` imports
	'unicorn/consistent-boolean-name': 'off', // `showTitle`-style booleans
	'unicorn/no-await-expression-member': 'off', // `(await res.json()).data` over a one-use temp
	'unicorn/max-nested-calls': 'off', // zod nests `z.object({ tags: z.array(z.string()) })` past its max of 3
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
	'unicorn/prefer-includes': 'off', // `.some((x) => x === y)` -> `.includes(y)` fails tsc on a literal-typed array; @typescript-eslint's twin covers `indexOf`
	'unicorn/prefer-array-index-of': 'off', // `findIndex((x) => x === y)` -> `indexOf(y)` fails tsc the same way
	'unicorn/no-array-reduce': 'off', // its fix unrolls a seedless reduce into `let x;`, an implicit any (TS7034)
	'unicorn/no-useless-undefined': ['error', { checkArrowFunctionBody: false }], // `.catch(() => undefined)` -> `() => {}` widens the promise to `T | void`
	'unicorn/prefer-global-this': 'off', // under @types/bun, `globalThis.addEventListener` drops WindowEventMap, so its fix leaves handlers a bare `Event`
	'unicorn/prefer-ternary': 'off', // folds early-return guards into ternaries, nesting them
	'unicorn/prefer-combined-guards': 'off', // merges guards into one condition, side-effecting awaits included
	'unicorn/prefer-includes-over-repeated-comparisons': 'off', // `x === -1 || x === 0` -> `[-1, 0].includes(x)` drops the narrowing, and `.includes` on a literal-typed array fails tsc
	'unicorn/prefer-number-coercion': 'off', // its fix turns `Number.parseFloat('16px')` (16) into `Number('16px')` (NaN)
	'unicorn/prefer-default-parameters': 'off', // `color || 'currentColor'` also replaces `''`; a default parameter doesn't
	'unicorn/no-unreadable-for-of-expression': 'off', // flags readable ones: `of xs ?? []`, `of new Set(ids)`, `of await files()`
	'unicorn/prefer-toggle-attribute': 'off', // its fix sets `''`, dropping `x` from `setAttribute(name, x)`
	'unicorn/prefer-observer-apis': 'off', // a virtualized grid reads scrollTop on scroll; no observer reports scroll position
	'unicorn/prefer-dom-node-html-methods': 'off', // matches any `.innerHTML(` call by name, MathJax's DOM adaptor included
	'unicorn/no-global-object-property-assignment': 'off', // `globalThis.db ??= connect()` is the one-pool-per-process pattern under a dev server's HMR
	'unicorn/no-document-cookie': 'off', // Cookie Store API is async-only; a sync read needs `document.cookie`
	'unicorn/prefer-query-selector': 'off', // `getElementById` types HTMLElement; its fix `querySelector('#id')` types Element (TS2339 on `.style`)
	'unicorn/require-css-escape': 'off', // flags constant attribute names and numeric ids alike; its fix on a number fails tsc (TS2345)
	'unicorn/no-break-in-nested-loop': 'off', // flags a `switch` case's `break` inside a loop, the usual argv parser
})

const notUnderscores = { regex: '^_+$', match: false }
const underscoreOk = /** @type {const} */ ({ filter: notUnderscores, leadingUnderscore: 'allow' })

const typeScriptRules = /** @satisfies {RuleOptions} */ ({
	...severity('error', typeScriptOn, '@typescript-eslint/'),
	'@typescript-eslint/ban-ts-comment': [
		'error',
		{ minimumDescriptionLength: 10, 'ts-ignore': 'allow-with-description', 'ts-nocheck': 'allow-with-description' },
	], // escape hatch with a reason; banned, reaching it takes an eslint-disable
	'@typescript-eslint/class-literal-property-style': ['error', 'getters'],
	'@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }], // `as const` and `satisfies` stay allowed
	'@typescript-eslint/no-deprecated': [
		'error',
		{
			allow: [{ from: 'file', name: 'builtinRules', path: 'node_modules/eslint/lib/types/use-at-your-own-risk.d.ts' }],
		},
	], // ESLint 10 deprecates the only list of core rule modules without a replacement
	'@typescript-eslint/consistent-type-definitions': ['error', 'type'], // `interface` on a published surface invites declaration merging
	'@typescript-eslint/method-signature-style': 'error',
	'@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
	'@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
	'@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
	'@typescript-eslint/prefer-string-starts-ends-with': ['error', { allowSingleElementEquality: 'always' }], // `a[0] === b[0]` -> `startsWith(b[0])` passes `string | undefined` under noUncheckedIndexedAccess
	'@typescript-eslint/no-misused-spread': ['error', { allow: [{ from: 'lib', name: 'string' }] }], // unicorn/prefer-spread rewrites `Array.from(str)`, the same code points, into `[...str]`
	'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
	'@typescript-eslint/no-inferrable-types': ['error', { ignoreParameters: true }], // a `replace` callback's params are any, so `(match, noun: string = '')` loses its type to the fix
	// `onClick={() => setOpen(true)}`; without ignoreVoidOperator its fix splits each `return f()` into `f(); return`
	'@typescript-eslint/no-confusing-void-expression': [
		'error',
		{ ignoreArrowShorthand: true, ignoreVoidOperator: true },
	],
	'@typescript-eslint/non-nullable-type-assertion-style': 'off', // its fix is `!`, which no-non-null-assertion forbids
	'@typescript-eslint/require-array-sort-compare': 'error',
	'@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }], // `() => {}` is the no-op
	'@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingAny: true, allowThrowingUnknown: true }], // a `.catch((error: unknown) => …)` rethrows what it caught; `signal.reason` is any
	'@typescript-eslint/no-generated-empty-object-type': 'off', // `Record<never, X>` is the deliberate empty default; no-empty-object-type still bans a written `{}`
	'@typescript-eslint/prefer-regexp-exec': 'off', // its `.exec()` is what unicorn/prefer-regexp-test flags in a condition
	'@typescript-eslint/no-unnecessary-template-expression': 'off', // unicorn/no-useless-template-literals also flags `${n}` and `${any}`
	'@typescript-eslint/no-meaningless-void-operator': 'off', // `void f()` types as undefined where f() is void; its fix dropped a `return void f()` and a switch case fell through
	'@typescript-eslint/prefer-find': 'off', // unicorn/prefer-array-find also flags `const [x] = xs.filter()` and findLast
	'@typescript-eslint/no-require-imports': 'off', // unicorn/prefer-module reports `require`; erasableSyntaxOnly bans `import x = require()`
	...severity('off', [...subsumedByBans, ...typeScriptCoveredByTsc], '@typescript-eslint/'),
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
})

const coreRules = /** @satisfies {RuleOptions} */ ({
	...severity('error', coreOn.flat(), ''),
	...severity('off', coreTypedTwins.flat(), ''),
	'no-misleading-character-class': 'off', // regexp/no-misleading-unicode-character also checks quantifiers and fixes
	'no-irregular-whitespace': ['error', { skipTemplates: true, skipRegExps: true }], // unicorn owns literals, prettier the gaps between tokens
	'no-control-regex': 'off', // matching separators and ANSI escapes is deliberate; an invisible pasted one is the rare case
	'no-eval': ['error', { allowIndirect: true }], // `(0, eval)` runs in global scope, out of reach of the caller's locals
	'require-atomic-updates': ['error', { allowProperties: true }],
	'object-shorthand': ['error', 'properties'],
	eqeqeq: ['error', 'smart'],
	curly: ['error', 'multi'],
	'arrow-body-style': 'error',
	complexity: ['error', { variant: 'modified' }], // a flat dispatch switch counts as 1
	'max-depth': 'error',
	'max-nested-callbacks': 'error',
	'max-params': ['error', 4], // library callbacks dictate 4: `String#replace` passes the match plus each group
	'max-lines-per-function': ['error', 150],
	'max-lines': ['error', 500],
})

const importRules = /** @satisfies {RuleOptions} */ ({
	...severity('error', importsOn, 'import-x/'),
	...severity('off', importCoveredByTsc, 'import-x/'),
	'import-x/no-duplicates': 'error', // not prefer-inline: its fix writes invalid `import x, type { Y }`
})

const regexpRules = /** @satisfies {RuleOptions} */ ({
	'regexp/no-useless-escape': 'off', // core no-useless-escape covers strings and regexes
	'regexp/no-legacy-features': 'off', // no-deprecated and unicorn/no-nonstandard-builtin-properties report `RegExp.$1`
	'regexp/no-invisible-character': 'off', // unicorn/prefer-escaped-irregular-whitespace reports it in every literal
})

const jsxRules = /** @satisfies {RuleOptions} */ ({
	'react-hooks/todo': 'error', // the only rule that reports React Compiler bail-outs (try/finally, for await, import())
	...severity('error', a11yBeyondStrict, 'jsx-a11y-x/'),
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
})

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
			ignores: GENERATED,
		},
		// a disable is the escape hatch; one that suppresses nothing fails the lint so the count only falls
		{ linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' } },
		{ languageOptions: { globals: { ...globals.browser, ...globals.node } } },
		js.configs.recommended,
		...[...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked].map((config) => ({
			...config,
			files: SOURCE,
		})),
		{
			files: SOURCE,
			languageOptions: { parserOptions: { projectService: true, jsxPragma: jsxPragma() } },
			rules: typeScriptRules,
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
			rules: { ...coreRules, ...importRules, ...regexpRules, ...jsxRules, ...unicornRules },
		},
		// Next reads `config.matcher` without running the file, so a `String.raw` tag fails the build
		{ files: ['**/{proxy,middleware}.?([cm])[jt]s'], rules: { 'unicorn/prefer-string-raw': 'off' } },
		...overrides,
	]
}
