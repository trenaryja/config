import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import * as R from 'remeda'
import {
	CHECKS,
	DETAILS,
	diagnose,
	failing,
	format,
	SELECT_OPTIONS,
	selectChecks,
	shown,
	toJson,
} from '../tren/doctor.ts'
import { messageOf } from '../tren/repo.ts'
import { defineCommand, jsonFlag, MISUSE } from '../tren/run.ts'
import { eachRepo, findConsumers, GIT } from './discover.ts'

/** one repo that cannot be read is reported and fails the run, but never hides the others */
export const doctor = defineCommand({
	bin: 'bun fleet',
	positionals: '[<repo|check>...]',
	options: {
		...SELECT_OPTIONS,
		json: jsonFlag('one { root, findings } per repo, the shape tren doctor --json prints,'),
	},
	details: `A name that is a check selects it; any other names a repo under ${GIT}.\n\n${DETAILS}`,
	run: async ({ positionals, values }) => {
		const [named, repositories] = R.partition(positionals, (name) => R.isIncludedIn(name, CHECKS))
		const { checks, misuse } = selectChecks(named, values)
		if (misuse) {
			console.error(`bun fleet doctor: ${misuse}`)
			return MISUSE
		}
		const results = await eachRepo(
			repositories.length > 0 ? repositories : await findConsumers(),
			async (repository) => {
				const root = resolve(GIT, repository)
				try {
					if (!existsSync(root))
						throw new Error(`${root} doesn't exist: name a repo under ${GIT} or pass an absolute path`)
					return { root, findings: await diagnose(root, checks), unreadable: false }
				} catch (error) {
					console.error(`${repository}: ${messageOf(error)}`)
					return { root, findings: [], unreadable: true }
				}
			},
		)
		const printed = results.map((result) => ({ ...result, findings: shown(result.findings, values.holds) }))
		if (values.json)
			console.log(
				JSON.stringify(
					printed.map(({ root, findings }) => ({ root, findings: findings.map(toJson) })),
					null,
					'\t',
				),
			)
		else
			for (const { root, findings } of printed)
				if (findings.length > 0)
					console.log([`\n${root}`, ...findings.map((finding) => `  ${format(finding)}`)].join('\n'))
		return results.some((result) => result.unreadable || failing(result.findings)) ? 1 : 0
	},
})
