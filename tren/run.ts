import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ParseArgsOptionDescriptor, parseArgs } from 'node:util'
import * as R from 'remeda'
import { columnLines } from './columns.ts'
import { findUp, git, gitRoot, messageOf, readManifest, spawn } from './repo.ts'

/** from tren's own install, not the repo root, so any linker works */
const own = (specifier: string) => {
	try {
		return Bun.resolveSync(specifier, import.meta.dir)
	} catch {
		throw new Error(`${specifier} is missing from tren's own install (${import.meta.dir}): run bun install`)
	}
}

export const manifest = () => readManifest('package.json')

/** exit code of a command with stdio streamed through; `stdout: 2` sends its stdout to stderr, keeping ours for data; `env` reaches this child only */
export const run = (
	cmd: readonly string[],
	cwd?: string,
	stdout: 'inherit' | 2 = 'inherit',
	env: Record<string, string> = {},
) => spawn(cmd, { cwd, env: { ...process.env, ...env }, stdio: ['inherit', stdout, 'inherit'] }).exited

/** a workspace root leaves its members to their own chk, which turbo filters and caches per package */
const memberDirs = async () => R.unique((await workspaceGlobs()).map((glob) => glob.replace(/\/.*/, '')))

export const workspaceGlobs = async (directory = '.') =>
	(await readManifest(join(directory, 'package.json'))).workspaces ?? []

/** keyed on the whole repo, since a per-file cache passes a file whose tsconfig or imported types changed; git's stat cache reads only changed files */
const eslintCache = async () => {
	const root = gitRoot(process.cwd())
	const untracked = git(root, 'ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean)
	const hasher = new Bun.CryptoHasher('sha1')
	hasher.update(git(root, 'ls-files', '--stage'))
	hasher.update(git(root, 'diff', '--binary'))
	for (const [path, bytes] of await Promise.all(
		untracked.map(async (file) => [file, await Bun.file(join(root, file)).bytes()] as const),
	))
		hasher.update(`${path}\0`).update(bytes)
	const dir = join(dirname(findUp(process.cwd(), 'package.json') ?? 'package.json'), 'node_modules/.cache/eslint')
	const location = join(dir, hasher.digest('hex'))
	if (!(await Bun.file(location).exists())) await rm(dir, { recursive: true, force: true })
	return ['--cache', '--cache-location', location]
}

export const eslint = async (args: readonly string[], ...flags: readonly string[]) => {
	const ignores = (await memberDirs()).flatMap((dir) => ['--ignore-pattern', dir])
	/** CI never reuses a cache */
	const cache = process.env.CI ? [] : await eslintCache()
	return [
		process.execPath,
		/** eslint's exports map hides bin/ from resolve, so its bin is run by path */
		join(dirname(own('eslint/package.json')), 'bin/eslint.js'),
		...cache,
		...flags,
		...ignores,
		...(args.some((arg) => !arg.startsWith('-')) ? [] : ['.']),
		...args,
	]
}

export const fmt = async (...flags: readonly string[]) => {
	const dirs = await memberDirs()
	return ['bun', 'fmt', '--no-script', ...flags, ...(dirs.length > 0 ? ['.', ...dirs.map((dir) => `!${dir}`)] : [])]
}

type Option = ParseArgsOptionDescriptor & { about: string; value?: string }
type Parsed<Options extends Record<string, Option>> = ReturnType<
	typeof parseArgs<{ options: Options; allowPositionals: true }>
> & { args: readonly string[] }

/** exit code for misuse: an unknown command or flag, contradicting flags, a repo command outside a repo; 1 is a failed check */
export const MISUSE = 2

export type Command = {
	about: string
	/** shown beside the name in usage */
	args?: string
	run: (args: readonly string[], name: string, about: string) => number | Promise<number>
}

export const lazy =
	(load: () => Promise<{ default: Command['run'] }>): Command['run'] =>
	async (...args) =>
		(await load()).default(...args)

export const dispatch = async (
	bin: string,
	commands: Readonly<Record<string, Command>>,
	[name = '', ...args]: readonly string[],
	footer = '',
) => {
	const command = Object.hasOwn(commands, name) ? commands[name] : undefined
	if (command)
		try {
			return await command.run(args, name, command.about)
		} catch (error) {
			if (!(error instanceof Error)) throw error
			console.error(`${bin} ${name}: ${error.message}`)
			return 1
		}
	const usage = columnLines(
		R.entries(commands).map(([key, entry]) => [[key, entry.args].join(' ').trim(), entry.about]),
		'  ',
	).join('\n')
	const asked = !name || name === '--help' || name === '-h'
	console[asked ? 'log' : 'error'](
		`${asked ? '' : `${bin}: unknown command "${name}"; valid: ${R.keys(commands).join(', ')}\n\n`}usage: ${bin} <command> [--help]\n\n${usage}${footer && `\n\n${footer}`}`,
	)
	return asked ? 0 : MISUSE
}

export const jsonFlag = (shape: string) => ({ type: 'boolean', about: `print ${shape} instead of text` }) as const

/** `scope: 'repo'` refuses outside a git repository and hands `run` the git root */
export const defineCommand =
	<const Options extends Record<string, Option>>(
		spec: {
			options?: Options
			positionals?: string
			details?: string
			/** the tool that gets the flags tren doesn't own, in `args`; only `--help` is intercepted */
			passThrough?: 'eslint' | 'bun install'
			/** the program the usage line names */
			bin?: string
		} & (
			| { scope?: undefined; run: (parsed: Parsed<Options>) => Promise<number> }
			| { scope: 'repo'; run: (parsed: Parsed<Options> & { root: string }) => Promise<number> }
		),
	) =>
	async (args: readonly string[], name: string, about: string) => {
		const flags = R.entries<Record<string, Option>>(spec.options ?? {}).map(
			([flag, option]) => [`--${flag}${option.value ? ` <${option.value}>` : ''}`, option.about] as const,
		)
		const synopsis = [
			spec.positionals,
			...flags.map(([flag]) => `[${flag}]`),
			spec.passThrough && `[${spec.passThrough} args]`,
		]
		const help = [
			`usage: ${spec.bin ?? 'tren'} ${name} ${synopsis.filter(Boolean).join(' ')}`.trimEnd(),
			`\n${about}\n`,
			...columnLines(flags, '  '),
			...(spec.details ? [`\n${spec.details}`] : []),
		]
			.join('\n')
			.trimEnd()
		if (args.includes('--help') || args.includes('-h')) {
			console.log(help)
			return 0
		}
		const parsed = (() => {
			try {
				return parseArgs({
					args: [...args],
					options: spec.options,
					allowPositionals: true,
					strict: !spec.passThrough,
					tokens: true,
				})
			} catch (error) {
				console.error(`${messageOf(error)}\n\n${help}`)
			}
		})()
		if (!parsed) return MISUSE
		const owned = new Set(
			parsed.tokens.flatMap((token) =>
				token.kind === 'option' && Object.hasOwn(spec.options ?? {}, token.name)
					? [token.index, ...(token.inlineValue === false ? [token.index + 1] : [])]
					: [],
			),
		)
		const passed = { ...parsed, args: args.filter((_, index) => !owned.has(index)) }
		if (spec.scope !== 'repo') return spec.run(passed)
		const root = gitRoot(process.cwd())
		if (root) return spec.run({ ...passed, root })
		console.error(`${spec.bin ?? 'tren'} ${name}: not inside a git repository`)
		return MISUSE
	}
