import { messageOf } from '../tren/repo.ts'
import { type Command, dispatch, MISUSE } from '../tren/run.ts'
import { audit, formatText } from './audit.ts'
import { doctor } from './doctor.ts'
import { formatGit, gitAudit } from './git.ts'
import { formatBoard } from './html.ts'
import page from './index.html'
import { lint, scan, scannedAt } from './lint.ts'

let scanning: string | undefined
let scanError: string | undefined

const startScan = () => {
	if (scanning) return
	scanning = '0/?'
	scanError = undefined
	void scan((done, total) => (scanning = `${done}/${total}`))
		.catch((error: unknown) => (scanError = messageOf(error)))
		.finally(() => (scanning = undefined))
}

/**
 * only a page fleet itself served may start a scan
 * - Origin, not Sec-Fetch-Site: Chrome omits it on a plain-http host like config.justin.internal
 * - X-Forwarded-Host first: bin's hub rewrites Host to localhost:<port>; a cross-site form can't set the header, and a cross-site fetch setting it fails preflight
 */
const fromOwnPage = (request: Request) => {
	const origin = request.headers.get('origin')
	const host = request.headers.get('x-forwarded-host') ?? new URL(request.url).host
	return origin !== null && URL.parse(origin)?.host === host
}

const print = (text: string) => {
	console.log(text)
	return 0
}

const COMMANDS = {
	audit: {
		about: 'every package against the canonical pattern (the default)',
		run: async () => print(formatText(await audit())),
	},
	git: {
		about: 'every repo under ~/Git: unpushed work, stale clones, unlinked branches',
		run: async () => print(formatGit(await gitAudit())),
	},
	doctor: {
		about: "tren doctor's findings for the named repos, or every consumer",
		args: '[repo|check…]',
		run: doctor,
	},
	lint: {
		about: 'lint the fleet with the working config: `bun fleet lint` lists the commands',
		args: '<command>',
		run: lint,
	},
	'--json': {
		about: 'both tables as JSON',
		run: async () => print(JSON.stringify({ audit: await audit(), git: await gitAudit() }, null, 2)),
	},
	'--serve': {
		about: 'the dashboard, on a random localhost port; every load re-audits',
		run: () => {
			const server = Bun.serve({
				hostname: '127.0.0.1',
				port: 0,
				routes: {
					'/': page,
					'/board': async () =>
						new Response(
							formatBoard(await audit(), await gitAudit(), { scanning, scanError, scannedAt: scannedAt() }),
							{
								headers: { 'content-type': 'text/html' },
							},
						),
					'/scan': {
						POST: (request) => {
							if (!fromOwnPage(request)) return new Response('cross-site', { status: 403 })
							startScan()
							return Response.redirect('/', 303)
						},
					},
				},
			})
			return print(`fleet audit re-runs on every load: ${server.url.href}`)
		},
	},
} satisfies Record<string, Command>

const argv = Bun.argv.slice(2)
process.exitCode = await dispatch(
	'bun fleet',
	COMMANDS,
	argv.length ? argv : ['audit'],
	`exit codes: 0 ok · 1 a check failed · ${MISUSE} misuse (unknown command or flag)`,
)
