import { basename, dirname } from 'node:path'
import { depsOf, trackedFiles } from './repo.ts'
import { defineCommand, eslint, fmt, manifest, run } from './run.ts'

/** `bun check` fails on "Nothing to check" without one */
const TS_FILE = /\.[cm]?tsx?$/

/** `bun check` reads only the root tsconfig; a nested one (a browser page beside Bun code) is its own project, unless a nested package.json owns it */
const nestedProjects = (files: readonly string[]) => {
	const packages = files.filter((file) => file.includes('/') && basename(file) === 'package.json').map(dirname)
	return files
		.filter((file) => file.includes('/') && basename(file) === 'tsconfig.json')
		.map(dirname)
		.filter((dir) => packages.every((pkg) => dir !== pkg && !dir.startsWith(`${pkg}/`)))
}

export const chk = async (args: readonly string[]) => {
	const next = 'next' in depsOf(await manifest())
	// typegen loads next.config, whose env.ts import would demand runtime secrets a static check never needs
	const typegen = next ? await run(['bun', 'next', 'typegen'], undefined, 'inherit', { SKIP_ENV_VALIDATION: '1' }) : 0
	if (typegen) return typegen
	/** every check runs, so one red step doesn't hide the others; the first failure's code wins */
	const files = trackedFiles(process.cwd())
	const codes = []
	for (const step of [
		...(files.some((file) => TS_FILE.test(file)) ? [['bun', 'check', '--no-script']] : []),
		...nestedProjects(files).map((dir) => ['bun', 'check', '--no-script', '-p', dir]),
		await fmt('--check'),
		await eslint(args, '--max-warnings=0'),
	])
		codes.push(await run(step))
	return codes.find(Boolean) ?? 0
}

export default defineCommand({ scope: 'repo', passThrough: 'eslint', run: ({ args }) => chk(args) })
