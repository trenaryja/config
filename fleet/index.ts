import { audit, formatText } from './audit.ts'
import { formatHtml } from './html.ts'
import { scan, scannedAt, verify } from './verify.ts'

const [command, ...rest] = Bun.argv.slice(2)
let scanning: string | undefined

const startScan = () => {
	if (scanning) return
	scanning = '0/?'
	void scan((done, total) => (scanning = `${done}/${total}`)).finally(() => (scanning = undefined))
}

if (command === 'verify') await verify(rest)
else if (command === '--json') console.log(JSON.stringify(await audit(), null, 2))
else if (command === '--serve') {
	const server = Bun.serve({
		port: 0,
		routes: {
			'/': async () =>
				new Response(formatHtml(await audit(), { scanning, scannedAt: await scannedAt() }), {
					headers: { 'content-type': 'text/html' },
				}),
			'/scan': {
				POST: () => {
					startScan()
					return Response.redirect('/', 303)
				},
			},
		},
	})
	console.log(`fleet audit re-runs on every load: ${server.url}`)
} else if (command)
	console.log('usage: bun fleet [--json | --serve | verify scan | verify report | verify rule <ruleId>]')
else console.log(formatText(await audit()))
