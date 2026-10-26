import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as R from 'remeda'
import ts from 'typescript'
import { z } from 'zod'
import { type Ctx, editJson, jsonObject, readJson, readManifest, readText, within } from './repo.ts'

const NOT_REQUIRED = /\.(?:optional|nullish|default|catch)\(/

/** a refine that makes optional keys required together is not modelled */
const requiredVars = (text: string) => {
	const find = (node: ts.Node): ts.CallExpression | undefined =>
		ts.isCallExpression(node) && node.expression.getText() === 'createEnv' ? node : ts.forEachChild(node, find)
	const options = find(ts.createSourceFile('env.ts', text, ts.ScriptTarget.Latest, true))?.arguments[0]
	if (!options || !ts.isObjectLiteralExpression(options)) return []
	return options.properties
		.filter(ts.isPropertyAssignment)
		.filter((shape) => R.isIncludedIn(shape.name.getText(), ['server', 'client', 'shared']))
		.map((shape) => shape.initializer)
		.filter(ts.isObjectLiteralExpression)
		.flatMap((shape) =>
			shape.properties
				.filter(ts.isPropertyAssignment)
				.filter((variable) => !NOT_REQUIRED.test(variable.initializer.getText()))
				.map((variable) => variable.name.getText()),
		)
}

const LOGIN_REPAIR = 'install the Vercel CLI and run `vercel login`'
let signedIn: Promise<void> | undefined
/** the flag asked for Vercel, so a missing or signed-out CLI fails loudly rather than skipping */
const requireLogin = () =>
	(signedIn ??= Promise.try(() => Bun.spawn(['vercel', 'whoami'], { stdout: 'ignore', stderr: 'ignore' }).exited)
		.catch(() => 1)
		.then((code) => {
			if (code) throw new Error(`the Vercel CLI is missing or signed out: ${LOGIN_REPAIR}`)
		}))

const vercel = async (cwd: string, ...args: readonly string[]) => {
	await requireLogin()
	const proc = Bun.spawn(['vercel', ...args, '--no-color'], { cwd, stderr: 'pipe' })
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited])
	if (code) throw new Error(`vercel ${args.join(' ')} failed in ${cwd}: ${err.trim()}; ${LOGIN_REPAIR} if signed out`)
	return `${out}\n${err}`
}

let newestNode: Promise<number> | undefined
const newestVercelNode = (cwd: string) =>
	(newestNode ??= vercel(cwd, 'project', 'update', '--help').then((help) => {
		const lines = help.split('\n')
		const start = lines.findIndex((line) => line.includes('--node-version'))
		const option = lines.slice(start + 1).findIndex((line) => /^\s+-/.test(line))
		const listed = lines.slice(start, option === -1 ? undefined : start + 1 + option).join(' ')
		const majors = listed.matchAll(/(\d+)\.x/g).toArray()
		if (start === -1 || majors.length === 0)
			throw new Error(
				'vercel project update --help lists no `--node-version` majors, so the newest cannot be read; the CLI help changed',
			)
		return Math.max(...majors.map(([, major]) => Number(major)))
	}))

/** the dashboard's Node.js Version is the one home for a project's Node: `engines.node` in the app's `package.json` silently overrides it, so it must be absent */
const nodeFindings = async (root: string, directory: string, name: string, inspected: string) => {
	const path = join(directory, 'package.json')
	const cwd = join(root, directory)
	const [{ engines }, newest] = await Promise.all([readManifest(join(root, path)), newestVercelNode(cwd)])
	const current = /^Node\.js Version\s+(\d+)/m.exec(inspected)?.[1]
	if (current === undefined) throw new Error(`vercel project inspect shows no Node.js Version for ${name} in ${cwd}`)
	return [
		...(Number(current) < newest
			? [
					{
						path: join(directory, '.vercel/project.json'),
						message: `${name}'s Node.js Version is ${current}.x but Vercel offers ${newest}.x: vercel project update ${name} --node-version ${newest}.x --yes`,
						fix: {
							files: [],
							label: `vercel project update ${name} --node-version ${newest}.x`,
							run: async () => {
								const code = await Bun.spawn(
									['vercel', 'project', 'update', name, '--node-version', `${newest}.x`, '--yes'],
									{ cwd, stdout: 'ignore' },
								).exited
								if (code) throw new Error(`vercel project update failed for ${name} in ${cwd}`)
							},
						},
					},
				]
			: []),
		...(engines.node === undefined
			? []
			: [
					{
						path,
						message: `engines.node "${engines.node}" overrides ${name}'s Node.js Version in the Vercel dashboard, so the dashboard lies: remove it`,
						fix: editJson(root, path, (json) => {
							json.engines = R.omit(jsonObject.catch({}).parse(json.engines), ['node'])
						}),
					},
				]),
	]
}

const found = new WeakMap<Ctx, ReturnType<typeof inspectProjects>>()

export const vercelFindings = (ctx: Ctx) => {
	const cached = found.get(ctx) ?? inspectProjects(ctx)
	found.set(ctx, cached)
	return cached
}

/** the Vercel projects among `manifests`' directories and what each must satisfy; `.vercel` is gitignored, so it is looked up on disk */
const inspectProjects = async ({ root, files, manifests }: Ctx) => {
	const named = await Promise.all(
		manifests
			.map((manifest) => dirname(manifest))
			.filter((directory) => existsSync(join(root, directory, '.vercel/project.json')))
			.map(async (directory) => ({
				directory,
				name: z
					.object({ projectName: z.string().optional() })
					.parse(await readJson(join(root, directory, '.vercel/project.json'))).projectName,
			})),
	)
	const projects = named.flatMap(({ directory, name }) => (name === undefined ? [] : { directory, name }))
	const broken = named
		.filter(({ name }) => name === undefined)
		.map(({ directory }) => ({
			path: join(directory, '.vercel/project.json'),
			message: 'names no Vercel project, so nothing can be checked: vercel link',
		}))
	if (projects.length === 0) return { env: broken, node: [] }
	const ownerOf = (file: string) =>
		R.firstBy(
			projects.filter(({ directory }) => within(directory, file)),
			[({ directory }) => directory.length, 'desc'],
		)
	const results = await Promise.all(
		projects.map(async ({ directory, name }) => {
			const cwd = join(root, directory)
			const envFiles = files.filter((file) => basename(file) === 'env.ts' && ownerOf(file)?.directory === directory)
			const [production, inspected] = await Promise.all([
				envFiles.length > 0 ? vercel(cwd, 'env', 'ls', 'production') : '',
				vercel(cwd, 'project', 'inspect'),
			])
			const have = new Set(
				production
					.split('\n')
					.filter((line) => /\bProduction\b/.test(line))
					.map((line) => line.trim().split(/\s+/, 1)[0]),
			)
			const envs = await Promise.all(
				envFiles.map(async (file) =>
					requiredVars(await readText(join(root, file)))
						.filter((variable) => !have.has(variable))
						.map((variable) => ({
							path: file,
							message: `${variable} is required but missing from ${name}'s Production environment: vercel env add ${variable} production`,
						})),
				),
			)
			const appRoot = /^Root Directory\s+(\S+)/m.exec(inspected)?.[1] ?? '.'
			return { env: envs.flat(), node: await nodeFindings(root, join(directory, appRoot), name, inspected) }
		}),
	)
	return {
		env: [...broken, ...results.flatMap((result) => result.env)],
		node: results.flatMap((result) => result.node),
	}
}
