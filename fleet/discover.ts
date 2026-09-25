import { statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

const ROOT = dirname(import.meta.dir)
export const GIT = dirname(ROOT)
export const SELF = basename(ROOT)

/** depth 3 reaches `packages/*` without descending into test fixtures; the glob skips dot-dirs */
const DEPTHS = ['package.json', '*/package.json', '*/*/package.json']

/** repo-relative package.json paths */
export const manifests = async (repo: string) =>
	(await Promise.all(DEPTHS.map(async (pattern) => Array.fromAsync(new Bun.Glob(pattern).scan(`${GIT}/${repo}`)))))
		.flat()
		.filter((path) => !path.includes('node_modules'))

/** a linked worktree's `.git` is a file: it repeats its repo's findings on a branch, and the git tab lists it under that repo */
export const findRepos = async () =>
	(await readdir(GIT, { withFileTypes: true }))
		.filter(
			(entry) => entry.isDirectory() && statSync(`${GIT}/${entry.name}/.git`, { throwIfNoEntry: false })?.isDirectory(),
		)
		.map((entry) => entry.name)
		.sort()

export const findConsumers = async () => {
	const found = await Promise.all(
		(await findRepos())
			.filter((name) => name !== SELF)
			.map(async (name) => {
				const uses = await Promise.all(
					(await manifests(name)).map(async (path) =>
						(await Bun.file(`${GIT}/${name}/${path}`).text()).includes('@trenaryja/config'),
					),
				)
				return uses.some(Boolean) ? name : null
			}),
	)
	return found.filter((name) => name !== null)
}
