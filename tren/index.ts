#!/usr/bin/env bun
import { type Command, dispatch, lazy, MISUSE } from './run.ts'

const COMMANDS = {
	chk: { about: 'typecheck, format check and lint; the gate before a commit', run: lazy(() => import('./chk.ts')) },
	ci: {
		about: "the repo's chk script, then its build script, then bun test when it has tests",
		run: lazy(() => import('./ci.ts')),
	},
	clean: {
		about: 'delete git-ignored build output (.next, dist, …), never ignored data like private/ or .env',
		run: lazy(() => import('./clean.ts')),
	},
	comments: {
		about: 'score every comment against the mechanical comment rules; never edits',
		run: lazy(() => import('./comments.ts')),
	},
	doctor: {
		about:
			'check the repo against every fleet standard; the network checks keep it out of chk and ci, and --offline skips them',
		run: lazy(() => import('./doctor.ts')),
	},
	fix: { about: "doctor's offline repairs, then eslint --fix, then format", run: lazy(() => import('./fix.ts')) },
	reinstall: {
		about: 'tren clean plus every node_modules and the lockfile, then install',
		run: lazy(() => import('./reinstall.ts')),
	},
	update: {
		about: 'move every dep to its latest version unless doctor holds it back',
		run: lazy(() => import('./update.ts')),
	},
} satisfies Record<string, Command>

/** measured: the first release where `bunx bun@<version> check` and `fmt` both run, the builtins tren calls */
const BUN_FLOOR = '1.4.4'
if (Bun.semver.order(Bun.version, BUN_FLOOR) < 0) {
	console.error(`tren: needs Bun ≥${BUN_FLOOR}, have ${Bun.version}: bun upgrade`)
	process.exit(MISUSE)
}

process.exit(
	await dispatch(
		'tren',
		COMMANDS,
		Bun.argv.slice(2),
		`exit codes: 0 ok · 1 a check failed · ${MISUSE} misuse (unknown command or flag, contradicting flags, not inside a git repository)`,
	),
)
