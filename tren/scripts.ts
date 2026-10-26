import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as R from 'remeda'
import { captures, CODE, type Ctx, editScripts, findUp, type Manifest, setScript, within } from './repo.ts'

const BUILD = /\b(?:next|vite|ray|turbo run) build\b|\btsdown\b/

const BANNED_SCRIPTS: Record<string, { message: string; renameTo?: string }> = {
	check: { message: 'a check script survives beside chk', renameTo: 'chk' },
	test: { message: 'a test script makes bun run test and bun test differ; chk or ci runs bun test' },
	'vscode:prepublish': { message: 'vscode:prepublish makes vsce run npm' },
}

/** a script is deleted only when its body is a known spelling of the command that replaces it */
const REPLACED_SCRIPTS = {
	'get-latest': {
		command: 'tren update',
		pattern: /^(?:bun update|(?:bunx )?(?:npm-check-updates|ncu))(?:\s[^&;|]*)?$/,
	},
	reinstall: {
		command: 'tren reinstall',
		pattern: /^rm\s[^&;|]*node_modules[^&;|]*(?:&&|;)\s*bun (?:i|install)(?:\s[^&;|]*)?$/,
	},
}

/** a step the repair can keep or replace as-is: not a builtin (`cd`), env prefix or shell operator, which `tren chk && …` would reorder or break */
const TOOL_CALL = /^(?!(?:cd|echo|exit|export|set|source|test)\b)[\w@][\w@./:-]*(?:\s|$)/
const isPlainScript = (script: string) =>
	!/[|<>`$()&{}\\]/.test(script.replaceAll('&&', '')) && stepsOf(script).every((step) => TOOL_CALL.test(step))

const TREN_STEPS = {
	chk: /^(?:bun check|bun fmt --check\b.*|(?:SKIP_ENV_VALIDATION=1 )?next typegen|(?:bunx )?tsc\b.*|(?:bunx )?prettier (?:-c|--check)\b.*|(?:bunx )?eslint (?!.*--fix).*)$/,
	fix: /^(?:bun fmt(?! .*--check\b).*|(?:bunx )?prettier (?:-w|--write)\b.*|(?:bunx )?eslint .*--fix.*)$/,
	ci: /^(?:bun run (?:build|chk)|bun test|tren chk)$/,
}

const stepsOf = (script: string) =>
	script
		.split(/&&|;/)
		.map((step) => step.trim())
		.filter(Boolean)

/** a repo on a config from before the bin would lose a script to a `tren` it can't run */
const trenInstalled = (root: string, manifest: string) =>
	Boolean(findUp(join(root, dirname(manifest)), 'node_modules/.bin/tren'))

export const scriptFindings = ({ root, files }: Ctx, manifest: string, { scripts, bin }: Manifest) => {
	const isRoot = manifest === 'package.json'
	/** a Rust-only member answers to cargo, not eslint */
	const linted = isRoot || files.some((file) => CODE.test(file) && within(dirname(manifest), file))
	const ownTren = typeof bin === 'object' ? bin.tren : undefined
	const hasTren = Boolean(ownTren) || trenInstalled(root, manifest)
	/** the package shipping tren can't link its own bin, so it runs the file the bin points at */
	const trens = ['tren', ...(ownTren ? [`bun ${ownTren.replace(/^\.\//, '')}`] : [])]
	const callsTren = (script: string, name: string) =>
		stepsOf(script).some((step) =>
			trens.some((tren) => step === `${tren} ${name}` || step.startsWith(`${tren} ${name} `)),
		)
	const expand = (text: string, depth = 0): string =>
		depth > 5
			? text
			: text.replaceAll(/bun run (\S+)/g, (call, name: string) => expand(scripts[name] ?? call, depth + 1))
	const builds = (text: string, seen: ReadonlySet<string>): boolean =>
		captures(text, /bun run (\S+)/g).some(
			(name) => name === 'build' || (!seen.has(name) && builds(scripts[name] ?? '', new Set([...seen, name]))),
		)
	const ownSteps = (name: keyof typeof TREN_STEPS) =>
		stepsOf(scripts[name] ?? '').filter((step) => !TREN_STEPS[name].test(step))
	const repaired = (name: keyof typeof TREN_STEPS) => [`tren ${name}`, ...ownSteps(name)].join(' && ')
	return [
		...R.keys(TREN_STEPS)
			.filter((name) => (name === 'ci' ? isRoot : linted && (isRoot || scripts[name])))
			.filter((name) => !callsTren(scripts[name] ?? '', name))
			.map((name) => ({
				message: `${name} ${JSON.stringify(scripts[name] ?? '')} never runs tren ${name}`,
				...(hasTren && isPlainScript(scripts[name] ?? '') && { fix: setScript(root, manifest, name, repaired(name)) }),
			})),
		...(scripts.chk && (builds(scripts.chk, new Set()) || BUILD.test(expand(scripts.chk)))
			? [{ message: `chk ${JSON.stringify(scripts.chk)} builds; the build belongs in ci` }]
			: []),
		...R.entries(BANNED_SCRIPTS)
			.filter(([name]) => R.keys(scripts).includes(name))
			.map(([name, { message, renameTo }]) =>
				renameTo && !Object.hasOwn(scripts, renameTo)
					? {
							message: `a ${name} script; the fleet spells it ${renameTo}`,
							/** turbo.json names tasks after scripts, so a rename there needs its task renamed too */
							...(!existsSync(join(root, 'turbo.json')) && {
								fix: editScripts(root, manifest, (all) =>
									R.mapValues(
										R.mapKeys(all, (key) => (key === name ? renameTo : key)),
										(script) => script.replaceAll(`bun run ${name}`, () => `bun run ${renameTo}`),
									),
								),
							}),
						}
					: { message },
			),
		...R.entries(REPLACED_SCRIPTS).flatMap(([name, { command, pattern }]) => {
			const body = scripts[name]
			if (body === undefined) return []
			if (!pattern.test(body.trim()))
				return {
					message: `${name} script ${JSON.stringify(body)} is not a known spelling of ${command}; check what it does before dropping it`,
					hold: true as const,
				}
			return {
				message: `${name} script: ${command} replaces it`,
				...(trenInstalled(root, manifest) && {
					fix: editScripts(root, manifest, (all) => R.omit(all, [name])),
				}),
			}
		}),
	].map((finding) => ({ path: manifest, ...finding }))
}
