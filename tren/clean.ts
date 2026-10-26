import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { git } from './repo.ts'
import { defineCommand, jsonFlag, MISUSE } from './run.ts'

/** what the fleet's .gitignore files ignore that a build regenerates; they also ignore private/, .env and local databases, so the list names outputs rather than taking everything ignored */
const OUTPUTS = ['.next', '.turbo', 'coverage', 'dist', 'target', 'next-env.d.ts', '*.tsbuildinfo', '*.bun-build']

/**
 * ignored entries under `cwd` whose name matches OUTPUTS or `names`
 * - git lists an ignored directory as one entry, so nothing inside `private/` is matched on its own
 * - `git clean -X` with `**` pathspecs deleted a whole ignored `private/` and `node_modules/` (git 2.54): never use it here
 */
export const cleanable = (cwd: string, names: readonly string[]) => {
	const globs = [...OUTPUTS, ...names].map((name) => new Bun.Glob(name))
	return git(cwd, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory')
		.split('\0')
		.filter((entry) => globs.some((glob) => glob.match(basename(entry))))
}

export const clean = async (cwd: string, names: readonly string[]) => {
	const entries = cleanable(cwd, names)
	await Promise.all(entries.map((entry) => rm(join(cwd, entry), { recursive: true, force: true })))
	return entries
}

export default defineCommand({
	scope: 'repo',
	positionals: '[<name>...]',
	options: {
		'dry-run': { type: 'boolean', about: 'list what would go without deleting it' },
		json: jsonFlag('the removed paths as an array'),
	},
	details: `Deletes git-ignored build output under the current directory: ${OUTPUTS.join(', ')}.
Each <name> (a file or directory name, globs allowed: node_modules, '*.log') adds to that list.
Never touches a tracked file, an untracked file git doesn't ignore, or anything inside an ignored directory the list doesn't name (private/, .env, a local database).`,
	run: async ({ positionals, values }) => {
		const path = positionals.find((name) => name.includes('/'))
		if (path) {
			console.error(`tren clean: ${path} is a path; give its name and run from the directory above it`)
			return MISUSE
		}
		const cwd = process.cwd()
		const entries = values['dry-run'] ? cleanable(cwd, positionals) : await clean(cwd, positionals)
		console.log(
			values.json
				? JSON.stringify(entries, null, '\t')
				: entries.map((entry) => `${values['dry-run'] ? 'would remove' : 'removed'} ${entry}`).join('\n') ||
						'nothing to remove',
		)
		return 0
	},
})
