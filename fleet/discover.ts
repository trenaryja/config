import { readFileSync, realpathSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import * as R from 'remeda'
import self from '../package.json' with { type: 'json' }
import { manifestsIn, readText, trackedFiles } from '../tren/repo.ts'

const ROOT = dirname(import.meta.dir)
/** FLEET_DIR points fleet at another directory of repos, for trying it on scratch ones */
export const GIT = Bun.env.FLEET_DIR ?? dirname(ROOT)
const SELF = basename(ROOT)

/** a positive number from the environment; a typo refuses rather than becoming NaN */
export const envNumber = (name: string, fallback: number) => {
	const raw = Bun.env[name]
	if (raw === undefined) return fallback
	const value = Number(raw)
	if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name}=${raw} is not a positive number`)
	return value
}

/** each repo runs about six git processes, and an audit parses a whole repo; eight at a time keeps the machine responsive over ~40 repos */
const CONCURRENCY = 8

export const eachRepo = async <T, U>(items: readonly T[], fn: (item: T) => Promise<U>) => {
	const results: U[] = []
	const queue = items.entries()
	await Promise.all(
		R.range(0, CONCURRENCY).map(async () => {
			for (const [index, item] of queue) results[index] = await fn(item)
		}),
	)
	return results
}

/** repo-relative package.json paths; depth 3 reaches `packages/*` without descending into test fixtures */
export const manifests = (repository: string) =>
	manifestsIn(trackedFiles(`${GIT}/${repository}`)).filter((path) => path.split('/').length <= 3)

/** a linked worktree's `.git` is a file `gitdir: <main>/.git/worktrees/<name>`; returns <main>, or undefined for a main checkout */
const mainOf = (path: string) => {
	const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(path, 'utf8'))?.[1]
	return gitdir && resolve(path, '..', gitdir, '../../..')
}

/** a linked worktree whose main repo is also listed gets no row: it nests under that repo */
export const findRepos = async () => {
	const names = (await readdir(GIT, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && statSync(`${GIT}/${entry.name}/.git`, { throwIfNoEntry: false }))
		.map((entry) => entry.name)
		.toSorted()
	return names.filter((name) => {
		const git = `${GIT}/${name}/.git`
		const main = statSync(git).isFile() ? mainOf(git) : undefined
		return !main || dirname(main) !== realpathSync(GIT) || !names.includes(basename(main))
	})
}

/** every repo with a root package.json must consume this package; a repo with only nested manifests is exempt; a tracked one deleted from disk still counts, so it shows as a finding instead of vanishing */
export const findPackageRepos = async () =>
	(await findRepos()).filter(
		(name) =>
			name !== SELF &&
			(Boolean(statSync(`${GIT}/${name}/package.json`, { throwIfNoEntry: false })) ||
				trackedFiles(`${GIT}/${name}`).includes('package.json')),
	)

export const findConsumers = async () => {
	const found = await eachRepo(
		(await findRepos()).filter((name) => name !== SELF),
		async (name) => {
			const root = `${GIT}/${name}`
			const uses = await Promise.all(
				manifests(name).map(async (path) => (await readText(`${root}/${path}`)).includes(self.name)),
			)
			return uses.some(Boolean) ? name : null
		},
	)
	return found.filter((name) => name !== null)
}
