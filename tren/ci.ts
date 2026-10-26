import { chk } from './chk.ts'
import { trackedFiles } from './repo.ts'
import { defineCommand, manifest, run } from './run.ts'

/** `bun test` exits 1 when it finds no tests */
const TEST_FILE = /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/

export default defineCommand({
	scope: 'repo',
	passThrough: 'eslint',
	run: async ({ args }) => {
		const { scripts } = await manifest()
		const code = scripts.chk ? await run(['bun', 'run', 'chk', ...args]) : await chk(args)
		if (code) return code
		for (const step of [
			...('build' in scripts ? [['bun', 'run', 'build']] : []),
			...(!/\bbun test\b/.test(scripts.chk ?? '') && trackedFiles(process.cwd()).some((file) => TEST_FILE.test(file))
				? [['bun', 'test']]
				: []),
		]) {
			const stepCode = await run(step)
			if (stepCode) return stepCode
		}
		return 0
	},
})
