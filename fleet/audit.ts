import { dirname, join } from 'node:path'
import * as R from 'remeda'
import { type Check, diagnose } from '../tren/doctor.ts'
import { ESLINT_FILES, presetOf } from '../tren/presets.ts'
import { readManifest, readText } from '../tren/repo.ts'
import { findPackageRepos, GIT, manifests } from './discover.ts'
import { lintCell, loadScans } from './lint.ts'

export const KINDS = ['tsconfig', 'eslint', 'package', 'deps', 'lint'] as const
export type Kind = (typeof KINDS)[number]

/** which dashboard column shows each doctor check; lint comes from the fleet lint scan instead */
const KIND_OF: Record<Check, Exclude<Kind, 'lint'>> = {
	agents: 'package',
	babel: 'deps',
	comments: 'eslint',
	compiler: 'package',
	'deps-latest': 'deps',
	disables: 'eslint',
	env: 'package',
	'eslint-config': 'eslint',
	package: 'package',
	peers: 'deps',
	renovate: 'deps',
	scripts: 'package',
	tsconfig: 'tsconfig',
	unused: 'deps',
	workflow: 'package',
}

/** `undefined` = file absent and not expected there; `notes` = holds, which still count as clean */
export type Cell = { path: string; residue: string[]; notes: string[]; raw: string } | undefined

export type Row = {
	repo: string
	dir: string
	role: 'single' | 'workspace' | 'member'
	preset: string
	cells: Record<Kind, Cell>
}

/** one row per package.json; a finding belongs to the deepest package directory holding its path */
const repoRows = async (repository: string, lint: Cell): Promise<Row[]> => {
	const root = join(GIT, repository)
	const findings = await diagnose(root)
	const directories = (await manifests(repository)).map((path) => dirname(path)).toSorted()
	const ownerOf = (path: string) =>
		directories.findLast((directory) => directory !== '.' && path.startsWith(`${directory}/`)) ?? '.'
	return Promise.all(
		directories.map(async (directory): Promise<Row> => {
			const at = (name: string) => join(root, directory, name)
			const manifestRaw = await readText(at('package.json'))
			const tsconfigRaw = await readText(at('tsconfig.json'))
			const eslint = (
				await Promise.all(ESLINT_FILES.map(async (name) => ({ name, raw: await readText(at(name)) })))
			).find((x) => x.raw)
			const owned = findings.filter((finding) => ownerOf(finding.path) === directory)
			const cell = (kind: Kind, path: string, raw: string): Cell => {
				const [notes, residue] = R.partition(
					owned.filter((finding) => KIND_OF[finding.check] === kind),
					(finding) => finding.hold === true,
				)
				const line = (finding: (typeof owned)[number]) => `${finding.path}: ${finding.message}`
				return { path, residue: residue.map(line), notes: notes.map(line), raw }
			}
			return {
				repo: repository,
				dir: directory,
				role:
					directory === '.' ? ((await readManifest(at('package.json'))).workspaces ? 'workspace' : 'single') : 'member',
				preset: tsconfigRaw ? presetOf(tsconfigRaw) : 'none',
				cells: {
					tsconfig: tsconfigRaw ? cell('tsconfig', 'tsconfig.json', tsconfigRaw) : undefined,
					eslint:
						eslint?.raw || directory === '.'
							? cell('eslint', eslint?.name ?? 'eslint.config.mjs', eslint?.raw ?? '')
							: undefined,
					package: cell('package', 'package.json', manifestRaw),
					deps: cell('deps', 'package.json', manifestRaw),
					lint: directory === '.' ? lint : undefined,
				},
			}
		}),
	)
}

export const audit = async () => {
	const [repos, scans] = await Promise.all([findPackageRepos(), loadScans()])
	const rows = await Promise.all(
		repos.map(async (repository) => {
			const scan = scans.find((x) => x.repo === repository)
			return repoRows(repository, scan && lintCell(scan))
		}),
	)
	return rows.flat()
}

export const isClean = (cell: Cell) => !cell?.residue.length

export const label = (row: Row) => (row.dir === '.' ? row.repo : `${row.repo}/${row.dir}`)

const tag = (row: Row) => `${row.role} · ${row.preset}`

const mark = (cell: Cell) =>
	cell === undefined ? '·' : isClean(cell) ? `✓${cell.notes.length ? '*' : ''}` : `✗${cell.residue.length}`

export const formatText = (rows: Row[]) => {
	const width = Math.max(...rows.map((row) => label(row).length))
	const tagWidth = Math.max(...rows.map((row) => tag(row).length))
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
