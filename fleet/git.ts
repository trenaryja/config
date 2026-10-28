import { realpathSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import * as R from 'remeda'
import { messageOf } from '../tren/repo.ts'
import { eachRepo, envNumber, findRepos, GIT } from './discover.ts'
import { block, type Column, detailsOf, formatTable, type Table, type View } from './table.ts'

/** git's whole verdict: a failure squeezed into '' once passed for a clean repo; GIT_CEILING_DIRECTORIES stops an empty `.git` borrowing a parent's repo */
const run = async (directory: string, ...args: readonly string[]) => {
	const proc = Bun.spawn(['git', '-C', directory, ...args], {
		stderr: 'pipe',
		env: { ...Bun.env, GIT_CEILING_DIRECTORIES: GIT },
	})
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
	return { out: out.trim(), err: err.trim(), code }
}

const lines = (text: string) => (text ? text.split('\n') : [])

/**
 * Tracking and a remote copy are independent, and collapsing them hides the state that bites:
 * - `unlinked` — both copies exist and neither knows about the other, so ahead/behind reads 0
 * - `local` — deliberate for a proposal, and for orchestrate's `wip/*`, whose brief says never push
 *
 * Reachability, not the branch name, decides: extensions' `feat/markdown-live-v1` is byte-identical
 * to `origin/archive/markdown-live-v1`, and a name match would have called those 117 commits lost.
 */
const stateOf = (upstream: string, upstreamExists: boolean, mirrored: boolean) =>
	upstream ? (upstreamExists ? 'linked' : 'orphaned') : mirrored ? 'unlinked' : 'local'

const checkoutsOf = (porcelain: string) =>
	porcelain.split('\n\n').flatMap((record) => {
		const path = /^worktree (.+)$/m.exec(record)?.[1]
		return path ? { path, branch: /^branch refs\/heads\/(.+)$/m.exec(record)?.[1] } : []
	})

const readRepository = async (repository: string) => {
	const directory = `${GIT}/${repository}`
	const errors: string[] = []
	const ok = async (...args: readonly string[]) => {
		const { out, err, code } = await run(directory, ...args)
		if (code) errors.push(`git ${args.join(' ')} exited ${code}: ${err}`)
		return out
	}
	const [porcelain, refs, remotes, stash, worktreeList, fetchHead, originHead, current] = await Promise.all([
		ok('status', '--porcelain'),
		ok('for-each-ref', '--format=%(refname:short)\t%(upstream:short)\t%(committerdate:unix)', 'refs/heads'),
		ok('for-each-ref', '--format=%(refname:short)', 'refs/remotes'),
		ok('stash', 'list'),
		ok('worktree', 'list', '--porcelain'),
		ok('rev-parse', '--git-path', 'FETCH_HEAD'),
		run(directory, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'),
		run(directory, 'symbolic-ref', '-q', '--short', 'HEAD'),
	])
	const remoteNames = lines(remotes)
	const heads = await Promise.all(
		lines(refs).map(async (line) => {
			const [name = '', upstream = '', at = '0'] = line.split('\t', 3)
			const gone = upstream !== '' && !remoteNames.includes(upstream)
			const [ahead = 0, behind = 0] =
				upstream && !gone
					? (await ok('rev-list', '--left-right', '--count', `${name}...${upstream}`)).split('\t').map(Number)
					: []
			return { name, upstream, at: Number(at) * 1000, ahead, behind, gone }
		}),
	)
	const trunk = [originHead.out.replace(/^origin\//, ''), 'main', 'master', current.out]
		.flatMap((name) => heads.filter((head) => head.name === name))
		.at(0) ??
		heads[0] ?? { name: 'HEAD', upstream: '', at: 0, ahead: 0, behind: 0, gone: false }
	const branches = await Promise.all(
		heads
			.filter((head) => head.name !== trunk.name)
			.map(async (head) => {
				const [unique, mirrors] = await Promise.all([
					ok('rev-list', '--count', `${trunk.name}..${head.name}`),
					ok('for-each-ref', '--contains', head.name, '--format=%(refname:short)', 'refs/remotes'),
				])
				const mirror = lines(mirrors)[0]
				return {
					name: head.name,
					at: head.at,
					ahead: head.ahead,
					state: stateOf(head.upstream, !head.gone, Boolean(mirror)),
					mirror,
					worktree: checkoutsOf(worktreeList).find((checkout) => checkout.branch === head.name)?.path,
					unique: Number(unique),
				}
			}),
	)
	// the first record is the main checkout; a linked worktree's own row lists neither it nor itself
	const [, ...linked] = checkoutsOf(worktreeList)
	const worktrees = await Promise.all(
		linked
			.filter((checkout) => checkout.path !== realpathSync(directory))
			.map(async (checkout) => {
				const { out, err, code } = await run(checkout.path, 'status', '--porcelain')
				if (code) errors.push(`worktree ${checkout.path}: git status exited ${code}: ${err}`)
				return {
					path: checkout.path,
					branch: checkout.branch ?? 'detached',
					files: lines(out).length,
					ahead: heads.find((head) => head.name === checkout.branch)?.ahead ?? 0,
				}
			}),
	)
	return {
		repo: repository,
		files: lines(porcelain).length,
		ahead: R.sumBy(heads, (head) => head.ahead),
		behind: trunk.behind,
		tracked: Boolean(trunk.upstream),
		gone: trunk.gone,
		detached: current.code === 1,
		empty: heads.length === 0,
		branches,
		worktrees,
		renovate: remoteNames.filter((name) => name.includes('/renovate/')).length,
		stash: lines(stash).length,
		committed: heads.length ? Number(await ok('log', '-1', '--format=%ct')) * 1000 : 0,
		// git writes FETCH_HEAD on every fetch, so its mtime dates the ahead/behind counts above
		fetched: statSync(resolve(directory, fetchHead), { throwIfNoEntry: false })?.mtimeMs ?? 0,
		errors,
	}
}

export type RepositoryGit = Awaited<ReturnType<typeof readRepository>>

const failed = (repo: string, error: unknown): RepositoryGit => ({
	repo,
	files: 0,
	ahead: 0,
	behind: 0,
	tracked: false,
	gone: false,
	detached: false,
	empty: false,
	branches: [],
	worktrees: [],
	renovate: 0,
	stash: 0,
	committed: 0,
	fetched: 0,
	errors: [messageOf(error)],
})

/** every repo under ~/Git, not just config's consumers: `config` and `nas` carry commits too */
export const gitAudit = async () =>
	eachRepo(await findRepos(), (repository) =>
		readRepository(repository).catch((error: unknown) => failed(repository, error)),
	)

const dirtyOf = (row: RepositoryGit) => row.files + R.sumBy(row.worktrees, (worktree) => worktree.files)

/** a week: Renovate and the owner's pushes land most weeks, so ahead/behind older than that no longer describes origin; FLEET_STALE_DAYS overrides */
const isStale = (row: RepositoryGit) => Date.now() - row.fetched > envNumber('FLEET_STALE_DAYS', 7) * 864e5

/** first match wins and the list order is the sort order: failures lead, `clean` is the fallthrough and sorts last */
const RULES = [
	['error', (row) => row.errors.length > 0],
	['gone', (row) => row.gone],
	['detached', (row) => row.detached],
	['new', (row) => row.empty],
	['unlinked', (row) => !row.tracked],
	['unpushed', (row) => row.ahead > 0],
	['dirty', (row) => dirtyOf(row) > 0],
	['never-fetched', (row) => row.fetched === 0],
	['stale', isStale],
] as const satisfies readonly (readonly [string, (row: RepositoryGit) => boolean])[]

type Status = (typeof RULES)[number][0] | 'clean'

const STATUSES: readonly Status[] = [...RULES.map(([status]) => status), 'clean']

const statusOf = (row: RepositoryGit): Status => RULES.find(([, hit]) => hit(row))?.[0] ?? 'clean'

const statusRank = (row: RepositoryGit) => STATUSES.indexOf(statusOf(row))

const UNITS = [
	['year', 31_536e6],
	['month', 2592e6],
	['week', 6048e5],
	['day', 864e5],
	['hour', 36e5],
	['minute', 6e4],
] as const

const ago = (at: number) => {
	if (!at) return '·'
	const elapsed = Date.now() - at
	const [unit, size] = UNITS.find(([, span]) => elapsed >= span) ?? (['second', 1e3] as const)
	return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-Math.round(elapsed / size), unit)
}

const digit = (value: number) => (value ? String(value) : '·')

const unpushedOf = (row: RepositoryGit) => {
	if (row.errors.length) return 'error'
	if (row.empty) return 'no commits'
	if (row.gone) return 'upstream gone'
	if (!row.tracked) return 'no upstream'
	return row.behind ? `+${row.ahead} -${row.behind}` : digit(row.ahead)
}

const unlinkedOf = (row: RepositoryGit) =>
	row.branches.filter((branch) => R.isIncludedIn(branch.state, ['orphaned', 'unlinked'])).length

type Worktree = RepositoryGit['worktrees'][number]

/** under ~/Git the relative path names it (`ui-lens`, `ui-worktrees/lint-config`); elsewhere the absolute path */
const worktreeName = (worktree: Worktree) => {
	const path = relative(realpathSync(GIT), worktree.path)
	return path.startsWith('..') ? worktree.path : path
}

/** a child row fills the repo row's columns: status, dirty files and unpushed commits are its own, the rest are the repo's */
const worktreeStatus = (worktree: Worktree): Status =>
	worktree.files ? 'dirty' : worktree.ahead ? 'unpushed' : 'clean'

const TONES: Record<Status, string> = {
	error: 'badge-error',
	gone: 'badge-error',
	detached: 'badge-error',
	new: 'badge-accent',
	unlinked: 'badge-error',
	unpushed: 'badge-warning',
	dirty: 'badge-info',
	'never-fetched': 'badge-warning',
	stale: 'badge-warning',
	clean: 'badge-success',
}

const statusView = (status: Status): View => ({ text: status, tone: TONES[status], badge: true })

/** the lines behind a column's count, for the dialog and the text report */
const detail = (row: RepositoryGit, texts: readonly string[], button?: string): View['detail'] =>
	texts.length ? { title: row.repo, lines: texts.map((text) => ({ text, tone: 'bg-base-200' })), button } : undefined

/** `child` fills a linked worktree's row; a column without one is the repo's alone */
type GitColumn = Column<RepositoryGit> & { child?: (worktree: Worktree) => View }

const COLUMNS: readonly GitColumn[] = [
	{
		key: 'status',
		view: (row) => ({ ...statusView(statusOf(row)), detail: detail(row, row.errors, 'btn-error') }),
		sort: statusRank,
		child: (worktree) => statusView(worktreeStatus(worktree)),
	},
	{
		key: 'files',
		view: (row) => ({ text: digit(row.files) }),
		sort: (row) => row.files,
		child: (worktree) => ({ text: digit(worktree.files) }),
	},
	{
		key: 'worktrees',
		view: (row) => ({
			text: digit(dirtyOf(row) - row.files),
			detail: detail(
				row,
				row.worktrees.map((worktree) => `${worktree.path}  ${worktree.branch}  ${worktree.files} dirty`),
			),
		}),
		sort: (row) => dirtyOf(row) - row.files,
	},
	{
		key: 'unpushed',
		view: (row) => ({ text: unpushedOf(row) }),
		sort: (row) => row.ahead,
		child: (worktree) => ({ text: digit(worktree.ahead) }),
	},
	{
		key: 'branches',
		view: (row) => ({
			text: digit(row.branches.length),
			detail: detail(
				row,
				row.branches.map((branch) =>
					[
						branch.name,
						`+${branch.unique} unique`,
						ago(branch.at),
						branch.ahead ? `${branch.ahead} unpushed` : '',
						branch.state,
						branch.mirror ? `on ${branch.mirror}` : '',
						branch.worktree ? `worktree ${branch.worktree}` : '',
					]
						.filter(Boolean)
						.join('  '),
				),
			),
		}),
		sort: (row) => row.branches.length,
	},
	{ key: 'unlinked', view: (row) => ({ text: digit(unlinkedOf(row)) }), sort: unlinkedOf },
	{ key: 'renovate', view: (row) => ({ text: digit(row.renovate) }), sort: (row) => row.renovate },
	{ key: 'stash', view: (row) => ({ text: digit(row.stash) }), sort: (row) => row.stash },
	{ key: 'committed', view: (row) => ({ text: ago(row.committed) }), sort: (row) => row.committed },
	{ key: 'fetched', view: (row) => ({ text: row.fetched ? ago(row.fetched) : 'never' }), sort: (row) => row.fetched },
]

export const GIT_TABLE: Table<RepositoryGit> = {
	id: 'git',
	columns: COLUMNS,
	name: (row) => row.repo,
	children: (row) =>
		row.worktrees.map((worktree) => ({
			name: worktreeName(worktree),
			branch: worktree.branch,
			views: COLUMNS.map((column) => column.child?.(worktree) ?? { text: '·' }),
		})),
}

export const totals = (rows: readonly RepositoryGit[]) => ({
	unpushed: R.sumBy(rows, (row) => row.ahead),
	unlinked: R.sumBy(rows, unlinkedOf),
	clean: rows.filter((row) => statusOf(row) === 'clean').length,
})

export const byStatus = (rows: readonly RepositoryGit[]) => R.sortBy(rows, statusRank, (row) => row.repo)

export const formatGit = (rows: readonly RepositoryGit[]) => {
	const { unpushed, unlinked, clean } = totals(rows)
	return [
		...formatTable(GIT_TABLE, byStatus(rows)),
		`\n${unpushed} commits unpushed · ${unlinked} branches need linking · ${clean}/${rows.length} clean`,
		...rows.flatMap((row) =>
			block(
				row.repo,
				detailsOf(GIT_TABLE, row).flatMap((d) => d.lines),
			),
		),
	].join('\n')
}
