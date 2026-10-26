import { join } from 'node:path'
import { diagnose, format } from '../tren/doctor.ts'
import { findConsumers, repositoryRoot } from './discover.ts'

/** repos are paths under ~/Git or absolute, default every consumer; a hold prints but passes */
export const doctor = async (repositories: readonly string[]) => {
	const targets = repositories.length > 0 ? repositories : await findConsumers()
	const results = await Promise.all(
		targets.map(async (repository) => {
			const root = repositoryRoot(repository)
			return (await diagnose(root)).map((finding) => ({ ...finding, path: join(root, finding.path) }))
		}),
	)
	const findings = results.flat()
	for (const finding of findings) console.log(format(finding))
	if (findings.some((finding) => !finding.hold)) process.exitCode = 1
}
