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

export const findConsumers = async () => {
	const entries = await readdir(GIT, { withFileTypes: true })
	const roots = entries.filter((entry) => entry.isDirectory() && entry.name !== SELF).map((entry) => entry.name)
	const found = await Promise.all(
		roots.map(async (name) => {
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
