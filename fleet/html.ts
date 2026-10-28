import * as R from 'remeda'
import { CANONICAL, cleanCount, isClean, type Kind, KINDS, type Row } from './audit.ts'
import { byStatus, GIT_TABLE, type RepositoryGit, totals } from './git.ts'
import { escape, renderTable } from './table.ts'

const stat = (title: string, value: string | number, tone: string) =>
	`<div class="stat bg-base-100 rounded-box shadow-md p-4"><div class="stat-title">${title}</div><div class="stat-value text-3xl sm:text-4xl ${tone}">${value}</div></div>`

/** the board's markup; the shell page fetches it, so the bundle never needs the data */
export const formatBoard = (
	rows: readonly Row[],
	gitRows: readonly RepositoryGit[],
	{ scanning, scanError, scannedAt }: { scanning?: string; scanError?: string; scannedAt?: Date } = {},
) => {
	const { unpushed, unlinked, clean } = totals(gitRows)
	const offCount = (kind: Kind) => rows.filter((row) => !isClean(row.cells[kind])).length
	return `<header class="flex flex-wrap items-center gap-3"><h1 class="grow text-2xl font-bold">fleet</h1>
<span class="text-sm text-base-content/60">${scannedAt ? `linted ${scannedAt.toLocaleString()}` : 'never linted'}</span>
${scanError ? `<span class="badge badge-error badge-soft" title="${escape(scanError)}">scan failed: ${escape(scanError)}</span>` : ''}<form method="post" action="/scan"><button class="btn btn-sm btn-primary" ${scanning ? 'disabled' : ''}>${scanning ? `<span class="loading loading-spinner loading-xs"></span>linting ${scanning}` : 'lint fleet'}</button></form></header>
<div role="tablist" class="tabs tabs-lift">
<input type="radio" name="board" role="tab" class="tab" aria-label="canonical" checked>
<div role="tabpanel" class="tab-content bg-base-200 border-base-300 rounded-box p-3 sm:p-4">
<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
${stat('canonical', `${cleanCount(rows)}/${rows.length}`, 'text-success')}${stat(
		'holds',
		R.sumBy(rows, (row) => R.sumBy(KINDS, (kind) => row.cells[kind]?.notes.length ?? 0)),
		'text-info',
	)}${KINDS.map((kind) => stat(`${kind} off`, offCount(kind), 'text-warning')).join('')}</div>
${renderTable(CANONICAL, rows)}</div>
<input type="radio" name="board" role="tab" class="tab" aria-label="git">
<div role="tabpanel" class="tab-content bg-base-200 border-base-300 rounded-box p-3 sm:p-4"><div class="grid grid-cols-3 gap-3">
${stat('unpushed', unpushed, 'text-warning')}${stat('unlinked', unlinked, 'text-error')}${stat('clean', `${clean}/${gitRows.length}`, 'text-success')}</div>
${renderTable(GIT_TABLE, byStatus(gitRows))}</div>
</div>`
}
