import { existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { clean } from './clean.ts'
import { defineCommand, MISUSE, run } from './run.ts'

/** a hoisted workspace still installs a member's conflicting versions inside it, so every node_modules goes, with the build output; the lockfile waits aside so a failed install leaves it in place */
export default defineCommand({
	scope: 'repo',
	passThrough: 'bun install',
	run: async ({ args, root, positionals }) => {
		if (positionals.length > 0) {
			console.error(`tren reinstall: takes no package names (bun install would add them), got ${positionals.join(' ')}`)
			return MISUSE
		}
		const lockfile = join(root, 'bun.lock')
		const aside = existsSync(lockfile)
		if (aside) renameSync(lockfile, `${lockfile}.tren-old`)
		await clean(root, ['node_modules'])
		let code = 1
		try {
			code = await run(['bun', 'install', ...args], root)
		} finally {
			if (aside && code) renameSync(`${lockfile}.tren-old`, lockfile)
			else rmSync(`${lockfile}.tren-old`, { force: true })
		}
		return code
	},
})
