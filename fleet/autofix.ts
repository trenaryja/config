import { $ } from 'bun'
import { existsSync, symlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import * as R from 'remeda'
import { findUp } from '../tren/repo.ts'
import { findConsumers, GIT, manifests } from './discover.ts'

const ROOT = '/tmp/fleet-autofix'
const TSC = `${dirname(import.meta.dir)}/node_modules/.bin/tsc`
const SWAP = `${import.meta.dir}/swap-eslint.ts`

/** unmigrated repos' `check` script shadows `bun check`, so every repo gets this repo's tsc, before and after alike */
const typecheck = async (directory: string) => {
	const out = await $`${TSC} --noEmit --pretty false -p .`.cwd(directory).nothrow().quiet().text()
	return out
		.split('\n')
		.map((line) => /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line))
		.filter((match) => match !== null)
		.map(([, file, code, message]) => ({ key: `${file} ${code}`, message: `${file} ${code}: ${message}` }))
}

/** new errors: a file+code whose count grew; lines shift under the fixes, so the line can't key */
const regressions = (before: { key: string }[], after: { key: string; message: string }[]) => {
	const counts = R.countBy(before, (error) => error.key)
	return R.pipe(
		R.groupBy(after, (error) => error.key),
		R.values(),
		R.filter((errors) => errors.length > (counts[errors[0].key] ?? 0)),
		R.flat(),
		R.map((error) => error.message),
	)
}

const prepare = async (repository: string) => {
	const tree = join(ROOT, repository)
	await $`git worktree remove --force ${tree}`.cwd(join(GIT, repository)).nothrow().quiet()
	await $`git worktree add --detach ${tree} HEAD`.cwd(join(GIT, repository)).quiet()
	const directories = (await manifests(repository)).map((path) => dirname(path))
	for (const directory of directories) {
		const modules = join(GIT, repository, directory, 'node_modules')
		if (existsSync(modules)) symlinkSync(modules, join(tree, directory, 'node_modules'))
	}
	return { tree, directories }
}

const fix = async (tree: string, directories: readonly string[]) => {
	const configDirectories = directories.filter((directory) =>
		['mjs', 'js', 'ts', 'cjs'].some((ext) => existsSync(join(tree, directory, `eslint.config.${ext}`))),
	)
	for (const directory of configDirectories) {
		const cwd = join(tree, directory)
		const bin = findUp(cwd, 'node_modules/.bin/eslint')
		if (!bin) continue
		// each config reads cwd (gitignore, package.json, tsconfig), so a member's files are fixed from the member
		const nested = configDirectories.flatMap((other) =>
			other !== directory && (directory === '.' || other.startsWith(`${directory}/`))
				? ['--ignore-pattern', `${relative(directory, other)}/`]
				: [],
		)
		await $`node --import ${SWAP} ${bin} --fix --no-warn-ignored ${nested} .`.cwd(cwd).nothrow().quiet()
	}
}

export const autofix = async (only: readonly string[]) => {
	const repositories = only.length ? only : await findConsumers()
	for (const repository of repositories) {
		const { tree, directories } = await prepare(repository)
		const checked = directories.filter((directory) => existsSync(join(tree, directory, 'tsconfig.json')))
		const before = await Promise.all(checked.map(async (directory) => typecheck(join(tree, directory))))
		await fix(tree, directories)
		const changed = (await $`git diff --name-only`.cwd(tree).quiet().text()).split('\n').filter(Boolean).length
		const after = await Promise.all(checked.map(async (directory) => typecheck(join(tree, directory))))
		const broken = checked.flatMap((directory, index) =>
			regressions(before[index] ?? [], after[index] ?? []).map((message) => `${directory}/${message}`),
		)
		console.log(`${repository}: ${changed} files fixed, ${broken.length} new type errors`)
		for (const message of broken) console.log(`  ${message}`)
	}
	console.log(`\nworktrees kept under ${ROOT} for inspection`)
}
