import { dirname, join } from 'node:path'
import * as R from 'remeda'
import ts from 'typescript'
import { z } from 'zod'
import self from '../package.json' with { type: 'json' }
import { bunIn, type Ctx, editJson, editText, jsonObject, type Manifest, readText } from './repo.ts'

const PRESETS = `${self.name}/tsconfig/`

const tsconfigSchema = z
	.object({ extends: z.unknown().optional(), compilerOptions: jsonObject.default({}) })
	.catchall(z.unknown())

export const presetOf = (raw: string) => {
	const parent = tsconfigSchema.safeParse(ts.parseConfigFileTextToJson('tsconfig.json', raw).config).data?.extends
	return typeof parent === 'string' ? parent.replace(PRESETS, '') : 'none'
}

/** Bun and Turbopack ignore inherited `paths`, so a local `@/*` line is the one tsconfig override a runtime needs */
const isRuntimeAlias = ([key, value]: [string, unknown]) =>
	key === 'paths' &&
	R.isPlainObject(value) &&
	R.isDeepEqual(R.keys(value), ['@/*']) &&
	R.isArray(value['@/*']) &&
	value['@/*'].every((target) => R.isIncludedIn(target, ['./*', './src/*']))

/** eslint's tsconfig resolver looks only in node_modules, so config itself extends its presets by path */
const SELF_PRESET = /^\.\/tsconfig\/(\w+)\.json$/

const isComment = (kind: ts.SyntaxKind) =>
	kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia

/** the comments on their own lines above `node`, inside it, or after it on its last line: the reason a deviation holds instead of failing */
const reasonOf = (source: ts.SourceFile, node: ts.Node) => {
	const { text } = source
	const above = (ts.getLeadingCommentRanges(text, node.pos) ?? [])
		.filter((range) => !text.slice(text.lastIndexOf('\n', range.pos) + 1, range.pos).trim())
		.map((range) => text.slice(range.pos, range.end))
	const start = node.getStart(source)
	const lineEnd = text.indexOf('\n', node.end)
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false)
	scanner.setText(text, start, (lineEnd === -1 ? text.length : lineEnd) - start)
	const within: string[] = []
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
		if (isComment(kind)) within.push(scanner.getTokenText())
	const reason = [...above, ...within].map((comment) => comment.replaceAll(/^\/\/|^\/\*+|\*\/$/g, '').trim()).join(' ')
	return reason || undefined
}

/** a hold carries its reason, so the list of holds is the list to review */
const deviation = (message: string, reason: string | undefined) =>
	reason ? { message: `${message}; reason: ${reason}`, hold: true as const } : { message }

const propertiesOf = (node: ts.Node | undefined) =>
	node && ts.isObjectLiteralExpression(node)
		? node.properties.filter(ts.isPropertyAssignment).map((property) => ({
				key: ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(),
				property,
			}))
		: []

const tsconfigMessages = (raw: string, isNodeHosted: boolean, isSelf: boolean) => {
	const parsed = ts.parseConfigFileTextToJson('tsconfig.json', raw)
	if (parsed.error) return [{ message: ts.flattenDiagnosticMessageText(parsed.error.messageText, ' ') }]
	const { extends: declared, $schema: _schema, compilerOptions, ...rest } = tsconfigSchema.parse(parsed.config)
	const parent =
		isSelf && typeof declared === 'string'
			? declared.replace(SELF_PRESET, (_match, preset: string) => `${PRESETS}${preset}`)
			: declared
	const declaredAs = parent === undefined ? 'has no extends' : `extends ${JSON.stringify(parent)}`
	const source = ts.parseJsonText('tsconfig.json', raw)
	const top = propertiesOf(source.statements[0]?.expression)
	const options = propertiesOf(top.find((x) => x.key === 'compilerOptions')?.property.initializer)
	const override = (properties: typeof top, key: string, label: string, value: unknown) => {
		const property = properties.find((x) => x.key === key)?.property
		return deviation(`${label}: ${JSON.stringify(value)} overrides the preset`, property && reasonOf(source, property))
	}
	return [
		...(typeof parent === 'string' && parent.startsWith(PRESETS)
			? []
			: [{ message: `${declaredAs}, not a ${self.name}/tsconfig preset` }]),
		// `dom` still carries Bun's globals, but a host shipping a webview needs the DOM more than it needs them gone
		...(isNodeHosted && !R.isIncludedIn(String(parent), [`${PRESETS}dom`, `${PRESETS}node`])
			? [{ message: `${declaredAs}; a VS Code or Raycast host wants ${PRESETS}node, or dom with a webview` }]
			: []),
		...R.entries(compilerOptions)
			.filter((option) => !isRuntimeAlias(option))
			.map(([key, value]) => override(options, key, `compilerOptions.${key}`, value)),
		...R.entries(rest).map(([key, value]) => override(top, key, key, value)),
	]
}

const isCanonicalImport = (node: ts.Statement) =>
	ts.isImportDeclaration(node) &&
	ts.isStringLiteral(node.moduleSpecifier) &&
	node.moduleSpecifier.text === `${self.name}/eslint` &&
	node.importClause?.getText() === '{ defineConfig }'

const eslintMessages = (raw: string) => {
	const source = ts.createSourceFile('eslint.config.ts', raw, ts.ScriptTarget.Latest, true)
	return source.statements.flatMap((node) => {
		if (isCanonicalImport(node)) return []
		const call = ts.isExportAssignment(node) && ts.isCallExpression(node.expression) ? node.expression : undefined
		return (
			call?.expression.getText() === 'defineConfig'
				? call.arguments.map((argument) => ({ node: argument, code: `defineConfig(${argument.getText()})` }))
				: [{ node, code: node.getText() }]
		).map((override) =>
			deviation(
				`overrides the shared config: ${override.code.replaceAll(/\s+/g, ' ')}`,
				reasonOf(source, override.node),
			),
		)
	})
}

/** where the `[install]` table's body sits: after its header (a trailing comment allowed) up to the next table header */
const installBody = (text: string) => {
	const header = /^[ \t]*\[install\][ \t]*(?:#[^\r\n]*)?/m.exec(text)
	if (!header) return
	const start = header.index + header[0].length
	const next = text.slice(start).search(/^[ \t]*\[/m)
	return { start, end: next < 0 ? text.length : start + next }
}

const LINKER = /^[ \t]*linker[ \t]*=[^\r\n]*/m
const isHoisted = (text: string) => {
	const body = installBody(text)
	return body !== undefined && /^[ \t]*linker[ \t]*=[ \t]*["']hoisted["']/m.test(text.slice(body.start, body.end))
}

/** only `[install]`'s own `linker` is touched */
const hoistLinker = (root: string) =>
	editText(root, 'bunfig.toml', (text) => {
		const body = installBody(text)
		if (!body) return `${text.trimEnd()}${text ? '\n\n' : ''}[install]\nlinker = "hoisted"\n`
		const own = text.slice(body.start, body.end)
		const edited = LINKER.test(own) ? own.replace(LINKER, 'linker = "hoisted"') : `\nlinker = "hoisted"${own}`
		return `${text.slice(0, body.start)}${edited}${text.slice(body.end)}`
	})

export const ESLINT_FILES = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.ts']

const placeOf = (manifestPath: string) => {
	const directory = dirname(manifestPath)
	return { isRoot: directory === '.', at: (name: string) => join(directory, name) }
}

export const tsconfigFindings = async ({ root, files }: Ctx, manifestPath: string, manifest: Manifest) => {
	const path = placeOf(manifestPath).at('tsconfig.json')
	if (!files.includes(path)) return []
	const isNodeHosted = Boolean(manifest.engines.vscode ?? manifest.dependencies['@raycast/api'])
	return tsconfigMessages(await readText(join(root, path)), isNodeHosted, manifest.name === self.name).map(
		(finding) => ({ ...finding, path }),
	)
}

export const eslintConfigFindings = async ({ root, files }: Ctx, manifestPath: string) => {
	const { at, isRoot } = placeOf(manifestPath)
	const eslintPath = ESLINT_FILES.map(at).find((path) => files.includes(path))
	const eslint = eslintPath && (await readText(join(root, eslintPath)))
	if (eslint) return eslintMessages(eslint).map((finding) => ({ ...finding, path: eslintPath }))
	return isRoot ? [{ path: at('eslint.config.mjs'), message: 'missing' }] : []
}

export const packageFindings = async ({ root }: Ctx, manifestPath: string, manifest: Manifest) => {
	if (!placeOf(manifestPath).isRoot) return []
	const findings = [
		...(manifest.name === self.name || Object.hasOwn(manifest.devDependencies, self.name)
			? []
			: [{ message: `devDependencies lacks ${self.name}`, fix: bunIn(root, manifestPath, 'add', '--dev', self.name) }]),
		...(manifest.workspaces && !isHoisted(await readText(join(root, 'bunfig.toml')))
			? [
					{
						message:
							'bunfig.toml lacks `linker = "hoisted"`: the isolated linker leaves typescript out of members, and next looks for it there',
						fix: hoistLinker(root),
					},
				]
			: []),
		...(manifest.prettier === `${self.name}/prettier`
			? []
			: [
					{
						message: `prettier is ${JSON.stringify(manifest.prettier)}, not "${self.name}/prettier"`,
						fix: editJson(root, manifestPath, (json) => (json.prettier = `${self.name}/prettier`)),
					},
				]),
	]
	return findings.map((finding) => ({ path: manifestPath, ...finding }))
}
