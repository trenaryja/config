import { audit, formatText } from './audit.ts'
import { doctor } from './doctor.ts'
import { formatGit, gitAudit } from './git.ts'
import { formatHtml } from './html.ts'
import { lint, scan, scannedAt } from './lint.ts'

const [command, ...rest] = Bun.argv.slice(2)
let scanning: string | undefined

const startScan = () => {
	if (scanning) return
	scanning = '0/?'
	void scan((done, total) => (scanning = `${done}/${total}`)).finally(() => (scanning = undefined))
}

if (command === 'lint') await lint(rest)
else if (command === 'doctor') await doctor(rest)
else if (command === 'git') console.log(formatGit(await gitAudit()))
else if (command === '--json') console.log(JSON.stringify({ audit: await audit(), git: await gitAudit() }, null, 2))
else if (command === '--serve') {
	const server = Bun.serve({
		port: 0,
		routes: {
			'/': async () =>
				new Response(formatHtml(await audit(), await gitAudit(), { scanning, scannedAt: await scannedAt() }), {
					headers: { 'content-type': 'text/html' },
				}),
			'/scan': {
				POST: (request) => {
					startScan()
					return Response.redirect(request.headers.get('referer') ?? '/', 303)
				},
			},
		},
	})
	console.log(`fleet audit re-runs on every load: ${server.url.href}`)
} else if (command)
	console.log(
		'usage: bun fleet [doctor [repo…] | git | lint <scan | report | rule <ruleId> | autofix [repo…] | redundant> | --json | --serve]',
	)
else console.log(formatText(await audit()))
