import { dirname, join } from 'node:path'
import * as R from 'remeda'
import ts from 'typescript'
import { bunIn, captures, type Ctx, depsOf, editText, type Fix, type Manifest, readText } from './repo.ts'

const propertyNamed = (object: ts.ObjectLiteralExpression, name: string) =>
	object.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === name)

const unwrap = (node: ts.Expression): ts.Expression =>
	ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node)
		? unwrap(node.expression)
		: node

const exportedObject = (source: ts.SourceFile) => {
	const exported = source.statements.find(ts.isExportAssignment)?.expression
	if (!exported) return
	const value = unwrap(exported)
	if (ts.isObjectLiteralExpression(value)) return value
	if (!ts.isIdentifier(value)) return
	const initializer = source.statements
		.filter(ts.isVariableStatement)
		.flatMap((statement) => statement.declarationList.declarations)
		.find((declaration) => declaration.name.getText() === value.text)?.initializer
	const object = initializer && unwrap(initializer)
	return object && ts.isObjectLiteralExpression(object) ? object : undefined
}

const NEXT_SETTINGS = [
	{
		key: 'agentRules',
		value: 'false',
		note: 'next dev otherwise writes AGENTS.md at the root whenever an agent runs it',
	},
	{ key: 'reactCompiler', value: 'true' },
	{ key: 'turbopackRustReactCompiler', value: 'true', parent: 'experimental' },
] as const

const missingNextSettings = (config: string) =>
	NEXT_SETTINGS.filter(({ key, value }) => !new RegExp(String.raw`${key}:\s*${value}`).test(config)).map(
		(setting) => `next without ${'parent' in setting ? `${setting.parent}.` : ''}${setting.key}: ${setting.value}`,
	)

/** the text a fix would leave; unchanged for a config shape it cannot edit, such as `export default wrap({...})` */
const nextConfigEdit = (path: string, text: string) => {
	const config = exportedObject(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
	if (!config) return text
	const experimental = propertyNamed(config, 'experimental')
	const experimentalObject =
		experimental && ts.isPropertyAssignment(experimental) && ts.isObjectLiteralExpression(experimental.initializer)
			? experimental.initializer
			: undefined
	const added: string[] = []
	const edits = NEXT_SETTINGS.flatMap((setting) => {
		const { key, value } = setting
		const parent = 'parent' in setting
		const target = parent ? experimentalObject : config
		const property = target && propertyNamed(target, key)
		if (property)
			return ts.isPropertyAssignment(property) && property.initializer.getText() !== value
				? { at: property.initializer.getStart(), end: property.initializer.getEnd(), insert: value }
				: []
		if (!parent) added.push(...('note' in setting ? [`// ${setting.note}`] : []), `${key}: ${value},`)
		else if (experimentalObject) {
			const at = experimentalObject.getStart() + 1
			return { at, end: at, insert: ` ${key}: ${value},` }
		} else if (!experimental) added.push(`${setting.parent}: { ${key}: ${value} },`)
		return []
	})
	const start = config.getStart() + 1
	const topLevel = `${added.map((line) => `\n\t${line}`).join('')}${config.properties.length === 0 && added.length > 0 ? '\n' : ''}`
	return R.sortBy([...edits, { at: start, end: start, insert: topLevel }], [(edit) => edit.at, 'desc']).reduce(
		(result, { at, end, insert }) => `${result.slice(0, at)}${insert}${result.slice(end)}`,
		text,
	)
}

/** ui's vite config pulls its compiler from build-shared.ts */
const configText = async (root: string, path: string | undefined) => {
	if (!path) return ''
	const read = (file: string) => readText(join(root, file))
	const text = await read(path)
	const imports = captures(text, /from\s+['"](\.{1,2}\/[^'"]+)['"]/g).map((specifier) => join(dirname(path), specifier))
	return [text, ...(await Promise.all(imports.map(read)))].join('\n')
}

export const compilerFindings = async ({ root, files }: Ctx, manifest: string, pkg: Manifest) => {
	const deps = depsOf(pkg)
	if (!deps.react) return []
	const directory = dirname(manifest)
	const finding = (message: string, fix?: Fix, path = manifest) => ({ path, message, fix })
	const configIn = (pattern: RegExp) => files.find((file) => dirname(file) === directory && pattern.test(file))
	if (deps.next) {
		const path = configIn(/next\.config\.[cm]?[jt]s$/)
		const text = path ? await readText(join(root, path)) : ''
		const fix =
			path && nextConfigEdit(path, text) !== text
				? editText(root, path, (current) => nextConfigEdit(path, current))
				: undefined
		return [
			...missingNextSettings(await configText(root, path)).map((message) => finding(message, fix, path)),
			...(deps['babel-plugin-react-compiler']
				? [
						finding(
							"declares babel-plugin-react-compiler, which Next's Rust compiler replaces",
							bunIn(root, manifest, 'remove', 'babel-plugin-react-compiler'),
						),
					]
				: []),
		]
	}
	const bundler = deps.vite ? 'vite' : deps.tsdown ? 'tsdown' : undefined
	// Ink and Raycast build without a compiler hook: Bun.build and ray build
	if (!bundler) return []
	const config = await configText(root, configIn(new RegExp(String.raw`${bundler}\.config\.[cm]?[jt]s$`)))
	return /reactCompiler|react-compiler/.test(config) ? [] : [finding(`${bundler} without the React Compiler`)]
}
