import { diagnoseOffline, fixOffline, format, toJson } from './doctor.ts'
import { gitRoot } from './repo.ts'
import { defineCommand, eslint, fmt, jsonFlag, run } from './run.ts'

/** doctor's repairs first so eslint and fmt see them; fmt last so it has the final word on layout; the exit code reflects only eslint and fmt, since chk is the gate; unscoped, so outside a repo it still runs eslint and fmt */
export default defineCommand({
	passThrough: 'eslint',
	options: {
		json: jsonFlag(
			'{ fixed, remaining, eslint, fmt } (paths doctor repaired, what it could not, and the exit codes), with eslint and fmt output on stderr',
		),
	},
	run: async ({ args, values }) => {
		const root = gitRoot(process.cwd())
		const fixed = root ? await fixOffline(root) : []
		const stdout = values.json ? 2 : 'inherit'
		const lintCode = await run(await eslint(['--fix', ...args]), undefined, stdout)
		const fmtCode = await run(await fmt(), undefined, stdout)
		const remaining = root ? (await diagnoseOffline(root)).filter((finding) => !finding.hold) : []
		if (values.json)
			console.log(
				JSON.stringify({ fixed, remaining: remaining.map(toJson), eslint: lintCode, fmt: fmtCode }, null, '\t'),
			)
		else for (const finding of remaining) console.log(format(finding))
		return fmtCode || lintCode
	},
})
