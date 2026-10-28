import { lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as R from 'remeda'
import { diagnose, DOCTOR_KINDS, type Finding, kindOf, location, REMOTE } from '../tren/doctor.ts'
import { ESLINT_FILES, presetOf } from '../tren/presets.ts'
import { messageOf, readManifest, readText } from '../tren/repo.ts'
import { eachRepo, findConsumers, findPackageRepos, GIT, manifests } from './discover.ts'
import { lintCells, scannedAt } from './lint.ts'
import { block, detailsOf, formatTable, type Table, type View } from './table.ts'

/** `undefined` = file absent and not expected there; `notes` = holds: they pass, and each is a goal to remove */
export type Cell = { path: string; residue: Finding[]; notes: Finding[]; raw: string } | undefined

type Probe = { path: string; raw: string; expected: boolean }

/** one directory's files, read once, for every column to compute from */
type Context = {
	directory: string
	lint: Cell
	manifest: string
	tsconfig: string
	eslint: { name: string; raw: string } | undefined
	/** a file that exists or is tracked yet reads as nothing is an error, never an absent cell */
	unreadable: (name: string, raw: string, tracked?: boolean) => Finding[]
	/** a cell exists whenever its file is expected or any finding maps to it, so none is dropped */
	cell: (kind: (typeof DOCTOR_KINDS)[number], probe: Probe, extra?: readonly Finding[]) => Cell
}

const COMPUTE = {
	tsconfig: (x) =>
		x.cell(
			'tsconfig',
			{ path: 'tsconfig.json', raw: x.tsconfig, expected: Boolean(x.tsconfig) },
			x.unreadable('tsconfig.json', x.tsconfig),
		),
	eslint: (x) =>
		x.cell('eslint', {
			path: x.eslint?.name ?? 'eslint.config.mjs',
			raw: x.eslint?.raw ?? '',
			expected: Boolean(x.eslint?.raw) || x.directory === '.',
		}),
	package: (x) =>
		x.cell(
			'package',
			{ path: 'package.json', raw: x.manifest, expected: true },
			x.unreadable('package.json', x.manifest, true),
		),
	deps: (x) => x.cell('deps', { path: 'package.json', raw: x.manifest, expected: true }),
	lint: (x) => (x.directory === '.' ? x.lint : undefined),
} satisfies Record<string, (context: Context) => Cell>

export type Kind = keyof typeof COMPUTE

export const KINDS = R.keys(COMPUTE)

export type Row = {
	repo: string
	dir: string
	role: 'single' | 'workspace' | 'member'
	preset: string
	cells: Partial<Record<Kind, Cell>>
}

const describeFinding = (finding: Finding) => `${location(finding)}: ${finding.message}`

const REMOTE_CHECKS = new Set(REMOTE)

let remoteStamp: number | undefined
const remoteRuns = new Map<string, Promise<Finding[]>>()

/** Vercel answers per project and every call goes through the CLI's login, so it runs once per lint scan, not per page load; a failure is a finding in the package column, never a crash or silence */
const remoteFindings = (repository: string) => {
	const run =
		remoteRuns.get(repository) ??
		diagnose(join(GIT, repository), REMOTE_CHECKS).catch((error: unknown): Finding[] => [
			{
				check: 'vercel-env',
				path: '.vercel',
				message: `vercel failed, kept until the next lint scan: ${messageOf(error)}`,
			},
		])
	remoteRuns.set(repository, run)
	return run
}

const repoRows = async (repository: string, lint: Cell) => {
	const root = join(GIT, repository)
	const [local, remote] = await Promise.all([diagnose(root), remoteFindings(repository)])
	const findings = [...local, ...remote]
	const directories = manifests(repository).map(dirname).toSorted()
	const ownerOf = (path: string) =>
		directories.findLast((directory) => directory !== '.' && path.startsWith(`${directory}/`)) ?? '.'
	return Promise.all(
		directories.map(async (directory): Promise<Row> => {
			const at = (name: string) => join(root, directory, name)
			const manifest = await readText(at('package.json'))
			const tsconfig = await readText(at('tsconfig.json'))
			const eslint = (
				await Promise.all(ESLINT_FILES.map(async (name) => ({ name, raw: await readText(at(name)) })))
			).find((x) => x.raw)
			const owned = findings.filter((finding) => ownerOf(finding.path) === directory)
			const context: Context = {
				directory,
				lint,
				manifest,
				tsconfig,
				eslint,
				unreadable: (name, raw, tracked = false) => {
					const exists = Boolean(lstatSync(at(name), { throwIfNoEntry: false }))
					if (raw || (!exists && !tracked)) return []
					return [
						{
							check: 'audit',
							path: name,
							message: `${name} is ${exists ? 'unreadable or empty' : 'tracked but missing'}`,
						},
					]
				},
				cell: (kind, { path, raw, expected }, extra = []) => {
					const [notes, residue] = R.partition(
						owned.filter((finding) => kindOf(finding.check) === kind),
						(finding) => finding.hold === true,
					)
					return expected || notes.length || residue.length || extra.length
						? { path, residue: [...extra, ...residue], notes, raw }
						: undefined
				},
			}
			return {
				repo: repository,
				dir: directory,
				role:
					directory === '.' ? ((await readManifest(at('package.json'))).workspaces ? 'workspace' : 'single') : 'member',
				preset: tsconfig ? presetOf(tsconfig) : 'none',
				cells: R.fromKeys(KINDS, (kind) => COMPUTE[kind](context)),
			}
		}),
	)
}

/** every column carries the failure, so no one of them can read as clean */
const errorRow = (repo: string, message: string): Row => {
	const cell: Cell = { path: 'package.json', residue: [{ check: 'audit', path: '.', message }], notes: [], raw: '' }
	return { repo, dir: '.', role: 'single', preset: 'none', cells: R.fromKeys(KINDS, () => cell) }
}

export const audit = async () => {
	const [repos, consumers] = await Promise.all([findPackageRepos(), findConsumers()])
	const stamp = scannedAt()
	if (stamp?.getTime() !== remoteStamp) {
		remoteRuns.clear()
		remoteStamp = stamp?.getTime()
	}
	const lintFor = await lintCells(consumers)
	const rows = await eachRepo(repos, (repository) =>
		repoRows(repository, lintFor(repository)).catch((error: unknown) => [errorRow(repository, messageOf(error))]),
	)
	return rows.flat()
}

export const isClean = (cell: Cell) => !cell?.residue.length

export const label = (row: Row) => (row.dir === '.' ? row.repo : `${row.repo}/${row.dir}`)

export const cleanCount = (rows: readonly Row[]) =>
	rows.filter((row) => KINDS.every((kind) => isClean(row.cells[kind]))).length

const view = (row: Row, kind: Kind): View => {
	const cell = row.cells[kind]
	if (!cell) return { text: '·' }
	const holds = isClean(cell)
	if (holds && !cell.notes.length) return { text: '✓', tone: 'text-success' }
	const count = holds ? cell.notes.length : cell.residue.length
	return {
		text: holds ? '✓*' : `✗${count}`,
		detail: {
			title: `${label(row)}/${cell.path}`,
			label: String(count),
			button: holds ? 'btn-info' : 'btn-warning',
			hint: holds ? 'holds: each passes, and each is a goal to remove' : undefined,
			lines: [
				...cell.residue.map((finding) => ({ text: describeFinding(finding), tone: 'bg-warning/10' })),
				...cell.notes.map((finding) => ({ text: describeFinding(finding), tone: 'bg-info/10', prefix: '* ' })),
			],
			raw: cell.raw,
		},
	}
}

export const CANONICAL: Table<Row> = {
	id: 'canonical',
	name: label,
	tags: (row) => [{ text: row.role }, { text: row.preset, tone: 'badge-primary' }],
	columns: KINDS.map((kind) => ({
		key: kind,
		view: (row) => view(row, kind),
		/** the count the cell shows, so holds rank with failures; absent sorts before clean so an unexpected file never hides among the ✓ */
		sort: (row) => {
			const cell = row.cells[kind]
			if (!cell) return -1
			return isClean(cell) ? cell.notes.length : cell.residue.length
		},
	})),
}

export const formatText = (rows: readonly Row[]) =>
	[
		...formatTable(CANONICAL, rows),
		`\n${cleanCount(rows)}/${rows.length} packages match the canonical pattern (* = holds, each a goal to remove)`,
		...rows.flatMap((row) => detailsOf(CANONICAL, row).flatMap((detail) => block(detail.title, detail.lines))),
	].join('\n')
