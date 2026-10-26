import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import ts from 'typescript'
import { z } from 'zod'

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const findUp = (directory: string, path: string): string | undefined => {
	const found = join(directory, path)
	if (existsSync(found)) return found
	return directory === dirname(directory) ? undefined : findUp(dirname(directory), path)
}

/** a missing `root` reads as empty: spawning into it throws ENOENT, blamed on git */
export const git = (root: string, ...args: readonly string[]) =>
	existsSync(root)
		? Bun.spawnSync(['git', ...args], { cwd: root })
				.stdout.toString()
				.trim()
		: ''

export const gitRoot = (directory: string) => git(directory, 'rev-parse', '--show-toplevel')

/** repo-relative paths git tracks or would add: untracked but not ignored counts */
export const trackedFiles = (root: string) =>
	git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)

/** unreadable reads as empty */
export const readText = (path: string) =>
	Bun.file(path)
		.text()
		.catch(() => '')

/** JSONC: comments and trailing commas parse; an error names the file */
const parseJson = (text: string, path: string): unknown => {
	const result = ts.parseConfigFileTextToJson(path, text || '{}')
	if (result.error) throw new Error(`${path}: ${ts.flattenDiagnosticMessageText(result.error.messageText, ' ')}`)
	return result.config
}

export const readJson = async (path: string) => parseJson(await readText(path), path)

export const strings = z.record(z.string(), z.string())
export const jsonObject = z.record(z.string(), z.unknown())

const manifestSchema = z.object({
	name: z.string().optional(),
	dependencies: strings.default({}),
	devDependencies: strings.default({}),
	peerDependencies: strings.default({}),
	peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().default(false) })).default({}),
	scripts: strings.default({}),
	files: z.array(z.string()).default([]),
	bin: z.union([z.string(), strings]).optional(),
	types: z.unknown().optional(),
	typings: z.unknown().optional(),
	exports: z.unknown().optional(),
	version: z.string().optional(),
	engines: strings.default({}),
	prettier: z.unknown().optional(),
	workspaces: z
		.union([z.array(z.string()), z.object({ packages: z.array(z.string()) }).transform((x) => x.packages)])
		.optional()
		.catch(undefined),
})
export type Manifest = z.infer<typeof manifestSchema>

export const readManifest = async (path: string) => {
	const parsed = manifestSchema.safeParse(await readJson(path))
	if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`)
	return parsed.data
}

export type Ctx = { root: string; files: readonly string[]; manifests: readonly string[] }

export const CODE = /\.[cm]?[jt]sx?$/

export const depsOf = (pkg: Manifest) => ({ ...pkg.dependencies, ...pkg.devDependencies })

/** idempotent; `files` are the repo-relative paths it may touch, declared up front so `--dry-run` can list them and `--fix` reports the ones whose content changed; `install` marks `bun add`/`bun remove`: network and lockfile, so an offline repair skips it */
export type Fix = { files: readonly string[]; install?: true; label?: string; run: () => Promise<void> }

export const editText = (root: string, path: string, edit: (text: string) => string): Fix => ({
	files: [path],
	run: async () => {
		const file = join(root, path)
		await Bun.write(file, edit(await readText(file)))
	},
})

/** `bun fmt` restores the house layout afterwards; comments in a JSONC file are lost, so callers edit strict JSON only */
export const editJson = (root: string, path: string, edit: (json: Record<string, unknown>) => void) =>
	editText(root, path, (text) => {
		const json = jsonObject.parse(parseJson(text, path))
		edit(json)
		return `${JSON.stringify(json, null, '\t')}\n`
	})

export const editScripts = (
	root: string,
	manifestPath: string,
	edit: (scripts: Record<string, string>) => Record<string, string>,
) =>
	editJson(root, manifestPath, (json) => {
		json.scripts = edit(strings.catch({}).parse(json.scripts))
	})

export const setScript = (root: string, manifestPath: string, name: string, script: string) =>
	editScripts(root, manifestPath, (scripts) => ({ ...scripts, [name]: script }))

export const spawn = (cmd: readonly string[], options: Parameters<typeof Bun.spawn>[1] = {}) => {
	try {
		return Bun.spawn([...cmd], options)
	} catch (error) {
		if (!messageOf(error).includes('Executable not found')) throw error
		throw new Error(
			`${cmd[0]} is not on PATH: install it${cmd[0] === 'bun' ? ' from https://bun.sh' : ''} or fix PATH`,
			{
				cause: error,
			},
		)
	}
}

/** also rewrites the lockfile */
export const bunIn = (root: string, manifest: string, ...args: readonly string[]): Fix => ({
	files: [manifest],
	install: true,
	run: async () => {
		await spawn(['bun', ...args], { cwd: join(root, dirname(manifest)), stdio: ['ignore', 'ignore', 'inherit'] }).exited
	},
})

export const manifestsIn = (files: readonly string[]) =>
	files.filter((file) => file === 'package.json' || file.endsWith('/package.json'))

export const within = (directory: string, path: string) => directory === '.' || path.startsWith(`${directory}/`)

export const captures = (text: string, re: RegExp) =>
	text
		.matchAll(re)
		.map(([, group = '']) => group)
		.toArray()

/** `bun fmt` over repo-relative `paths`, leaving out .toml, which prettier can't format */
export const formatFiles = async (root: string, paths: readonly string[]) => {
	const formattable = paths.filter((path) => !path.endsWith('.toml'))
	if (formattable.length > 0)
		await spawn(['bun', 'fmt', '--no-script', ...formattable], { cwd: root, stdout: 'ignore' }).exited
}
