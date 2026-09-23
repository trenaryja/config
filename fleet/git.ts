import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import * as R from 'remeda'
import { GIT } from './discover.ts'

const run = async (repo: string, ...args: string[]) => {
	const proc = Bun.spawn(['git', '-C', `${GIT}/${repo}`, ...args], { stdout: 'pipe', stderr: 'ignore' })
	return (await new Response(proc.stdout).text()).trim()
}

const lines = (text: string) => (text ? text.split('\n') : [])

const modified = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : 0)

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

/** a link git can repair on its own, unlike a branch that was never pushed */
const BROKEN = new Set(['orphaned', 'unlinked'])

const BRANCH_FORMAT = '%(refname:short)\t%(upstream:short)\t%(committerdate:unix)'

/** `git worktree list --porcelain` emits a blank-line-separated record per checkout */
const worktreesOf = (porcelain: string) =>
	new Map(
		porcelain.split('\n\n').flatMap((record) => {
			const path = /^worktree (.+)$/m.exec(record)?.[1]
			const branch = /^branch refs\/heads\/(.+)$/m.exec(record)?.[1]
			return path && branch ? [[branch, path] as const] : []
		}),
	)

const readRepo = async (repo: string) => {
	const [porcelain, refs, remotes, stash, committed, worktrees] = await Promise.all([
		run(repo, 'status', '--porcelain'),
		run(repo, 'for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'),
		run(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes'),
		run(repo, 'stash', 'list'),
		run(repo, 'log', '-1', '--format=%ct'),
		run(repo, 'worktree', 'list', '--porcelain'),
	])
	const checkouts = worktreesOf(worktrees)
	const heads = lines(refs).map((line) => {
		const [name = '', upstream = '', at = '0'] = line.split('\t')
		return { name, upstream, at: Number(at) * 1000 }
	})
	// a repo with no commits has no head to compare against, so the placeholder keeps every query below total
	const trunk = heads.find((head) => head.name === 'main') ?? heads[0] ?? { name: 'HEAD', upstream: '', at: 0 }
	const [ahead = 0, behind = 0] = trunk.upstream
		? (await run(repo, 'rev-list', '--left-right', '--count', `${trunk.name}...${trunk.upstream}`))
				.split('\t')
				.map(Number)
		: []
	const remoteNames = lines(remotes)
	const branches = await Promise.all(
		heads
			.filter((head) => head.name !== trunk.name)
			.map(async (head) => {
				const [unique, mirrors] = await Promise.all([
					run(repo, 'rev-list', '--count', `${trunk.name}..${head.name}`),
					run(repo, 'for-each-ref', '--contains', head.name, '--format=%(refname:short)', 'refs/remotes'),
				])
				const mirror = lines(mirrors)[0]
				return {
					name: head.name,
					at: head.at,
					state: stateOf(head.upstream, remoteNames.includes(head.upstream), Boolean(mirror)),
					mirror,
					worktree: checkouts.get(head.name),
					unique: Number(unique),
				}
			}),
	)
	return {
		repo,
		files: lines(porcelain).length,
		ahead,
		behind,
		tracked: Boolean(trunk.upstream),
		empty: heads.length === 0,
		branches,
		renovate: remoteNames.filter((name) => name.includes('/renovate/')).length,
		stash: lines(stash).length,
		committed: Number(committed) * 1000,
		// git writes FETCH_HEAD on every fetch, so its mtime dates the ahead/behind counts above
		fetched: modified(`${GIT}/${repo}/.git/FETCH_HEAD`),
	}
}

export type RepoGit = Awaited<ReturnType<typeof readRepo>>

/** every repo under ~/Git, not just config's consumers: `config` and `nas` carry commits too */
export const gitAudit = async () => {
	const entries = await readdir(GIT, { withFileTypes: true })
	const repos = entries
		.filter((entry) => entry.isDirectory() && existsSync(`${GIT}/${entry.name}/.git`))
		.map((entry) => entry.name)
		.sort()
	return Promise.all(repos.map(readRepo))
}

/**
 * The trunk alone, ordered worst first. Branches stay out of it: a local-only `wip/*` or proposal
 * is deliberate, so letting one colour the whole repo made every status read as a problem.
 */
export const STATUSES = ['new', 'unlinked', 'unpushed', 'dirty', 'clean'] as const

export const statusOf = (row: RepoGit) =>
	row.empty ? 'new' : !row.tracked ? 'unlinked' : row.ahead > 0 ? 'unpushed' : row.files > 0 ? 'dirty' : 'clean'

export type Status = (typeof STATUSES)[number]

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const UNITS = [
	['year', 31536e6],
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
	return RELATIVE.format(-Math.round(elapsed / size), unit)
}

const digit = (value: number) => (value ? String(value) : '·')

const unpushedOf = (row: RepoGit) =>
	row.empty
		? 'no commits'
		: !row.tracked
			? 'no upstream'
			: row.behind
				? `+${row.ahead} -${row.behind}`
				: digit(row.ahead)

export const unlinkedOf = (row: RepoGit) => row.branches.filter((branch) => BROKEN.has(branch.state)).length

export const describe = (branch: RepoGit['branches'][number]) =>
	[
		branch.name,
		`+${branch.unique} unique`,
		ago(branch.at),
		branch.state,
		branch.mirror ? `on ${branch.mirror}` : '',
		branch.worktree ? `worktree ${branch.worktree}` : '',
	]
		.filter(Boolean)
		.join('  ')

export type Column = { key: string; show: (row: RepoGit) => string; sort: (row: RepoGit) => number }

export const COLUMNS: readonly Column[] = [
	{ key: 'status', show: statusOf, sort: (row) => STATUSES.indexOf(statusOf(row)) },
	{ key: 'files', show: (row) => digit(row.files), sort: (row) => row.files },
	{ key: 'unpushed', show: unpushedOf, sort: (row) => row.ahead },
	{ key: 'branches', show: (row) => digit(row.branches.length), sort: (row) => row.branches.length },
	{ key: 'unlinked', show: (row) => digit(unlinkedOf(row)), sort: unlinkedOf },
	{ key: 'renovate', show: (row) => digit(row.renovate), sort: (row) => row.renovate },
	{ key: 'stash', show: (row) => digit(row.stash), sort: (row) => row.stash },
	{ key: 'committed', show: (row) => ago(row.committed), sort: (row) => row.committed },
	{ key: 'fetched', show: (row) => ago(row.fetched), sort: (row) => row.fetched },
]

export const totals = (rows: RepoGit[]) => ({
	unpushed: R.sumBy(rows, (row) => row.ahead),
	unlinked: R.sumBy(rows, unlinkedOf),
	clean: rows.filter((row) => statusOf(row) === 'clean').length,
})

export const byStatus = (rows: RepoGit[]) =>
	[...rows].sort(
		(a, b) => STATUSES.indexOf(statusOf(a)) - STATUSES.indexOf(statusOf(b)) || a.repo.localeCompare(b.repo),
	)

export const formatGit = (rows: RepoGit[]) => {
	const headers = ['', ...COLUMNS.map((column) => column.key)]
	const cells = byStatus(rows).map((row) => [row.repo, ...COLUMNS.map((column) => column.show(row))])
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...cells.map((cell) => (cell[index] ?? '').length)),
	)
	const line = (cell: readonly string[]) => cell.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ')
	const details = rows.flatMap((row) =>
		row.branches.length ? [`\n${row.repo}`, ...row.branches.map((branch) => `  ${describe(branch)}`)] : [],
	)
	const { unpushed, unlinked, clean } = totals(rows)
	return [
		line(headers),
		...cells.map(line),
		`\n${unpushed} commits unpushed · ${unlinked} branches need linking · ${clean}/${rows.length} clean`,
		...details,
	].join('\n')
}
