import { dirname } from 'node:path'
import * as R from 'remeda'
import ts from 'typescript'
import { findConsumers, GIT, manifests } from './discover.ts'
import self from '../package.json'
import { lintCell, loadScans } from './verify.ts'

export const KINDS = ['tsconfig', 'eslint', 'package', 'lint'] as const
export type Kind = (typeof KINDS)[number]

type Manifest = {
	workspaces?: unknown
	prettier?: unknown
	engines?: Record<string, string>
	scripts?: Record<string, string>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

/** `undefined` = file absent and not expected there; `notes` = deliberate residue that still counts as clean */
export type Cell = { path: string; residue: string[]; notes: string[]; raw: string } | undefined

export type Row = {
	repo: string
	dir: string
	role: 'single' | 'workspace' | 'member'
	preset: string
	cells: Record<Kind, Cell>
}

const read = async (path: string) => {
	const file = Bun.file(path)
	return (await file.exists()) ? file.text() : undefined
}

const show = (value: unknown) => JSON.stringify(value)

const ALIAS_TARGETS = new Set(['./*', './src/*'])

/** Bun and Turbopack ignore inherited `paths`, so a local `@/*` line is the one tsconfig override a runtime needs */
const isRuntimeAlias = ([key, value]: [string, unknown]) =>
	key === 'paths' &&
	R.isPlainObject(value) &&
	R.isDeepEqual(R.keys(value), ['@/*']) &&
	Array.isArray(value['@/*']) &&
	value['@/*'].every((target) => ALIAS_TARGETS.has(target))

const NODE_HOST_PRESETS = new Set([`${self.name}/tsconfig/dom`, `${self.name}/tsconfig/node`])

const auditTsconfig = (raw: string, isNodeHosted: boolean) => {
	const { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', raw)
	if (error) return { residue: [ts.flattenDiagnosticMessageText(error.messageText, ' ')], notes: [] }
	const { extends: parent, $schema: _schema, compilerOptions = {}, ...rest } = config
	const [aliases, options] = R.partition(R.entries(compilerOptions), isRuntimeAlias)
	return {
		residue: [
			...(typeof parent === 'string' && parent.startsWith(`${self.name}/tsconfig/`)
				? []
				: [`extends: ${show(parent)}`]),
			// `dom` still carries Bun's globals, but a host shipping a webview needs the DOM more than it needs them gone
			...(isNodeHosted && !NODE_HOST_PRESETS.has(String(parent))
				? [
						`extends: ${show(parent)} (a VS Code or Raycast host wants ${self.name}/tsconfig/node, or dom with a webview)`,
					]
				: []),
			...options.map(([key, value]) => `compilerOptions.${key}: ${show(value)}`),
			...R.entries(rest).map(([key, value]) => `${key}: ${show(value)}`),
		],
		notes: aliases.map(
			([key, value]) => `compilerOptions.${key}: ${show(value)} (Bun and Turbopack ignore inherited paths)`,
		),
	}
}

const isCanonicalImport = (node: ts.Statement) =>
	ts.isImportDeclaration(node) &&
	ts.isStringLiteral(node.moduleSpecifier) &&
	node.moduleSpecifier.text === `${self.name}/eslint` &&
	node.importClause?.getText() === '{ defineConfig }'

const auditEslint = (raw: string) =>
	ts.createSourceFile('eslint.config.ts', raw, ts.ScriptTarget.Latest, true).statements.flatMap((node) => {
		if (isCanonicalImport(node)) return []
		const call = ts.isExportAssignment(node) && ts.isCallExpression(node.expression) ? node.expression : undefined
		if (call?.expression.getText() !== 'defineConfig') return [node.getText()]
		return call.arguments.map((argument) => `defineConfig(${argument.getText()})`)
	})

/** extra steps (cargo, tests, codegen) are welcome; a missing core step is drift */
const CORE_STEPS = {
	fix: ['prettier -w .', 'eslint --fix .'],
	check: ['tsc', 'prettier -c .', 'eslint . --max-warnings=0'],
} as const

const CANONICAL_SCRIPTS = {
	'get-latest': 'bun update --latest --interactive',
	reinstall: 'rm -rf node_modules bun.lock && bun install',
} as const

/** inlines `bun run <script>` so a step delegated to a sibling script still counts */
const expand = (body: string, scripts: Record<string, string>, seen: ReadonlySet<string> = new Set()): string =>
	body.replace(/\bbun run ([\w:-]+)/g, (call, name: string) => {
		const target = scripts[name]
		return target === undefined || seen.has(name) ? call : expand(target, scripts, new Set([...seen, name]))
	})

const auditScripts = (scripts: Record<string, string> = {}) => [
	...R.entries(CORE_STEPS).flatMap(([name, steps]) => {
		const script = scripts[name]
		if (script === undefined) return [`scripts.${name}: missing`]
		const body = expand(script, scripts)
		return steps
			.filter((step) => !body.includes(step))
			.map((step) => `scripts.${name} lacks \`${step}\`: ${show(script)}`)
	}),
	...R.entries(CANONICAL_SCRIPTS).flatMap(([name, canonical]) => {
		const body = scripts[name]
		return body === undefined || body === canonical
			? []
			: [`scripts.${name}: ${show(body)} (canonical ${show(canonical)})`]
	}),
]

const PROVIDED = R.keys(self.dependencies)

const isNodeHosted = (manifest: Manifest) =>
	Boolean(manifest.engines?.vscode ?? manifest.dependencies?.['@raycast/api'])

const HOISTED = /^\s*linker\s*=\s*"hoisted"/m

const auditPackage = (manifest: Manifest, role: Row['role'], files: { tsconfig?: string; bunfig?: string }) => {
	// devDependencies only: a runtime entry is the code's own import, e.g. an extension bundling prettier
	const redundant = PROVIDED.filter((name) => manifest.devDependencies?.[name])
	return [
		...redundant.map((name) => `redundant dependency: ${name} (provided by ${self.name})`),
		...(role !== 'workspace' || HOISTED.test(files.bunfig ?? '')
			? []
			: ['bunfig.toml lacks `linker = "hoisted"` (the isolated linker hides the toolchain from the root)']),
		...(role === 'member' || manifest.prettier === `${self.name}/prettier`
			? []
			: [`prettier: ${show(manifest.prettier)}`]),
		...(files.tsconfig === undefined ? [] : auditScripts(manifest.scripts)),
	]
}

const ESLINT_FILES = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.ts', 'eslint.config.cjs'] as const

const auditDir = async (repo: string, dir: string, lint: Cell): Promise<Row> => {
	const root = `${GIT}/${repo}/${dir}`
	const manifestRaw = (await read(`${root}/package.json`)) ?? '{}'
	const manifest: Manifest = JSON.parse(manifestRaw)
	const role = dir === '.' ? (manifest.workspaces ? 'workspace' : 'single') : 'member'
	const tsconfigRaw = await read(`${root}/tsconfig.json`)
	const parent = tsconfigRaw && ts.parseConfigFileTextToJson('tsconfig.json', tsconfigRaw).config?.extends
	const preset = typeof parent === 'string' ? parent.replace(`${self.name}/tsconfig/`, '') : 'none'
	const eslint = (
		await Promise.all(ESLINT_FILES.map(async (name) => ({ name, raw: await read(`${root}/${name}`) })))
	).find((x) => x.raw)
	const eslintCell = eslint?.raw
		? { path: eslint.name, residue: auditEslint(eslint.raw), notes: [], raw: eslint.raw }
		: undefined
	return {
		repo,
		dir,
		role,
		preset,
		cells: {
			tsconfig:
				tsconfigRaw === undefined
					? undefined
					: { path: 'tsconfig.json', ...auditTsconfig(tsconfigRaw, isNodeHosted(manifest)), raw: tsconfigRaw },
			eslint:
				role === 'member' || eslintCell
					? eslintCell
					: { path: 'eslint.config.mjs', residue: ['missing'], notes: [], raw: '' },
			package: {
				path: 'package.json',
				residue: auditPackage(manifest, role, { tsconfig: tsconfigRaw, bunfig: await read(`${root}/bunfig.toml`) }),
				notes: [],
				raw: manifestRaw,
			},
			lint,
		},
	}
}

export const audit = async () => {
	const [repos, scans] = await Promise.all([findConsumers(), loadScans()])
	const rows = await Promise.all(
		repos.sort().map(async (repo) => {
			const scan = scans.find((x) => x.repo === repo)
			return Promise.all(
				(await manifests(repo))
					.sort()
					.map((path) => auditDir(repo, dirname(path), dirname(path) === '.' && scan ? lintCell(scan) : undefined)),
			)
		}),
	)
	return rows.flat()
}

export const isClean = (cell: Cell) => !cell?.residue.length

export const label = (row: Row) => (row.dir === '.' ? row.repo : `${row.repo}/${row.dir}`)

const tag = (row: Row) => `${row.role} · ${row.preset}`

export const formatText = (rows: Row[]) => {
	const width = Math.max(...rows.map((row) => label(row).length))
	const tagWidth = Math.max(...rows.map((row) => tag(row).length))
	const mark = (cell: Cell) =>
		cell === undefined ? '·' : isClean(cell) ? `✓${cell.notes.length ? '*' : ''}` : `✗${cell.residue.length}`
	const table = rows.map((row) =>
		[label(row).padEnd(width), tag(row).padEnd(tagWidth), ...KINDS.map((kind) => mark(row.cells[kind]).padEnd(9))].join(
			'  ',
		),
	)
	const details = rows.flatMap((row) =>
		KINDS.flatMap((kind) => {
			const cell = row.cells[kind]
			const lines = [...(cell?.residue ?? []), ...(cell?.notes ?? []).map((note) => `* ${note}`)]
			return lines.length
				? [`\n${label(row)}/${cell?.path}`, ...lines.map((line) => `  ${line.replaceAll('\n', '\n  ')}`)]
				: []
		}),
	)
	const clean = rows.filter((row) => KINDS.every((kind) => isClean(row.cells[kind]))).length
	return [
		[''.padEnd(width), ''.padEnd(tagWidth), ...KINDS.map((kind) => kind.padEnd(9))].join('  '),
		...table,
		`\n${clean}/${rows.length} packages match the canonical pattern (* = allowed override, see notes)`,
		...details,
	].join('\n')
}
