import { isClean, KINDS, label } from './audit.ts'
import type { Cell, Row } from './audit.ts'
import { byStatus, COLUMNS, describe, statusOf, totals } from './git.ts'
import type { Column, RepoGit, Status } from './git.ts'

const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)

/** absent sorts before clean so an unexpected file never hides among the ✓ */
const rank = (cell: Cell) => (cell === undefined ? -1 : cell.residue.length)

/** a dialog, not an inline disclosure: expanding inside a cell widens its column and reflows the whole table */
const renderCell = (row: Row, cell: Cell) => {
	if (cell === undefined) return '<td class="text-center text-base-content/30">·</td>'
	if (isClean(cell) && !cell.notes.length) return '<td class="text-center text-success">✓</td>'
	const items = (lines: string[], tone: string) =>
		lines.map((line) => `<li class="bg-${tone}/10 rounded-box px-2 py-1">${escape(line)}</li>`).join('')
	const button = isClean(cell)
		? `<button class="btn btn-xs btn-soft btn-success" title="allowed override" onclick="this.nextElementSibling.showModal()">✓</button>`
		: `<button class="btn btn-xs btn-soft btn-warning tabular-nums" onclick="this.nextElementSibling.showModal()">${cell.residue.length}</button>`
	return `<td class="text-center">${button}
		<dialog class="modal modal-bottom sm:modal-middle text-left"><div class="modal-box sm:max-w-3xl space-y-3">
		<h3 class="font-mono font-bold break-all">${escape(label(row))}/${cell.path}</h3>
		<ul class="font-mono text-xs whitespace-pre-wrap break-words space-y-1">${items(cell.residue, 'warning')}${items(cell.notes, 'success')}</ul>
		${cell.raw && `<pre class="bg-base-300 rounded-box p-3 text-xs overflow-auto max-h-[50dvh]">${escape(cell.raw)}</pre>`}
		<form method="dialog" class="modal-action"><button class="btn btn-sm">close</button></form></div>
		<form method="dialog" class="modal-backdrop"><button>close</button></form></dialog></td>`
}

const stat = (title: string, value: string, tone: string) =>
	`<div class="stat bg-base-100 rounded-box shadow-md p-4"><div class="stat-title">${title}</div><div class="stat-value text-3xl sm:text-4xl ${tone}">${value}</div></div>`

const sortable = (key: string, text: string) =>
	`<th data-key="${key}" class="${key === 'name' ? '' : 'w-px text-center'}"><button class="btn btn-ghost btn-xs gap-0.5 px-1">${text}<span class="text-primary"></span></button></th>`

const TONES: Record<Status, string> = {
	new: 'accent',
	unlinked: 'error',
	unpushed: 'warning',
	dirty: 'info',
	clean: 'success',
}

const renderGitRow = (row: RepoGit) => {
	const branchList = row.branches
		.map((branch) => `<li class="bg-base-200 rounded-box px-2 py-1">${escape(describe(branch))}</li>`)
		.join('')

	const cell = (column: Column) => {
		const value = escape(column.show(row))
		if (column.key === 'status')
			return `<td class="text-center"><span class="badge badge-soft badge-sm badge-${TONES[statusOf(row)]}">${value}</span></td>`
		if (column.key === 'branches' && row.branches.length)
			return `<td class="text-center"><button class="btn btn-xs btn-soft tabular-nums" onclick="this.nextElementSibling.showModal()">${value}</button>
				<dialog class="modal modal-bottom sm:modal-middle text-left"><div class="modal-box space-y-3">
				<h3 class="font-mono font-bold">${escape(row.repo)}</h3>
				<ul class="font-mono text-xs space-y-1">${branchList}</ul>
				<form method="dialog" class="modal-action"><button class="btn btn-sm">close</button></form></div>
				<form method="dialog" class="modal-backdrop"><button>close</button></form></dialog></td>`
		return `<td class="text-center tabular-nums whitespace-nowrap ${value === '·' ? 'text-base-content/30' : ''}">${value}</td>`
	}

	return `<tr data-name="${escape(row.repo)}" ${COLUMNS.map((column) => `data-${column.key}="${column.sort(row)}"`).join(' ')}>
		<th class="font-mono font-normal break-all">${escape(row.repo)}</th>${COLUMNS.map(cell).join('')}</tr>`
}

const renderGit = (rows: RepoGit[]) => {
	const { unpushed, unlinked, clean } = totals(rows)
	return `<div class="grid grid-cols-3 gap-3">
${stat('unpushed', `${unpushed}`, 'text-warning')}${stat('unlinked', `${unlinked}`, 'text-error')}${stat('clean', `${clean}/${rows.length}`, 'text-success')}</div>
<div class="card bg-base-100 border border-base-content/10 shadow-md overflow-x-auto mt-3">
<table id="git" class="table table-xs sm:table-sm table-pin-rows"><thead><tr>${sortable('name', 'name')}${COLUMNS.map((column) => sortable(column.key, column.key)).join('')}</tr></thead>
<tbody>${byStatus(rows).map(renderGitRow).join('\n')}</tbody></table></div>`
}

const SCRIPT = `
const params = new URLSearchParams(location.search)
const save = () => history.replaceState(null, '', params.size ? '?' + params : location.pathname)
const tabs = [...document.querySelectorAll('[role=tab]')]
for (const tab of tabs) {
	if (tab.ariaLabel === params.get('tab')) tab.checked = true
	tab.addEventListener('change', () => {
		if (tab === tabs[0]) params.delete('tab')
		else params.set('tab', tab.ariaLabel)
		save()
	})
}
for (const table of document.querySelectorAll('table')) {
	const body = table.tBodies[0]
	const sortBy = (key, descending) => {
		const arrow = table.querySelector('th[data-key="' + key + '"] span')
		if (!arrow) return
		const byName = (a, b) => a.dataset.name.localeCompare(b.dataset.name)
		const rows = [...body.rows].sort(key === 'name' ? byName : (a, b) => a.dataset[key] - b.dataset[key] || byName(a, b))
		body.append(...(descending ? rows.reverse() : rows))
		Object.assign(table.dataset, { sort: key, direction: descending ? 'desc' : 'asc' })
		for (const other of table.querySelectorAll('th[data-key] span')) other.textContent = ''
		arrow.textContent = descending ? '▼' : '▲'
		params.set(table.id, (descending ? '-' : '') + key)
		save()
	}
	for (const button of table.querySelectorAll('th[data-key] button'))
		button.addEventListener('click', () => {
			const key = button.parentElement.dataset.key
			sortBy(key, table.dataset.sort === key && table.dataset.direction !== 'desc')
		})
	const saved = params.get(table.id)
	if (saved) sortBy(saved.replace(/^-/, ''), saved.startsWith('-'))
}
`

/** `scanning` = `done/total` while a lint scan runs; the page refreshes itself until it ends */
export const formatHtml = (
	rows: Row[],
	gitRows: RepoGit[],
	{ scanning, scannedAt }: { scanning?: string; scannedAt?: Date } = {},
) => {
	const offCount = (kind: (typeof KINDS)[number]) => rows.filter((row) => !isClean(row.cells[kind])).length
	const clean = rows.filter((row) => KINDS.every((kind) => isClean(row.cells[kind]))).length
	const body = rows
		.map(
			(row) =>
				`<tr data-name="${escape(label(row))}" ${KINDS.map((kind) => `data-${kind}="${rank(row.cells[kind])}"`).join(' ')}>
				<th class="font-mono font-normal break-all">${escape(label(row))}<div class="flex flex-wrap gap-1 mt-1"><span class="badge badge-soft badge-sm">${row.role}</span><span class="badge badge-soft badge-primary badge-sm">${row.preset}</span></div></th>
				${KINDS.map((kind) => renderCell(row, row.cells[kind])).join('')}</tr>`,
		)
		.join('\n')
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>fleet</title>${scanning ? '<meta http-equiv="refresh" content="3">' : ''}
<!-- ui ships precompiled utilities too; Tailwind appends its sheet after this link so its sm: variants win -->
<link href="https://cdn.jsdelivr.net/npm/@trenaryja/ui" rel="stylesheet" crossorigin="anonymous">
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser"></script></head>
<body class="bg-base-300 text-base-content min-h-dvh"><main class="mx-auto max-w-5xl p-3 sm:p-6 space-y-4">
<header class="flex flex-wrap items-center gap-3"><h1 class="grow text-2xl font-bold">fleet</h1>
<span class="text-sm text-base-content/60">${scannedAt ? `linted ${scannedAt.toLocaleString()}` : 'never linted'}</span>
<form method="post" action="/scan"><button class="btn btn-sm btn-primary" ${scanning ? 'disabled' : ''}>${scanning ? `<span class="loading loading-spinner loading-xs"></span>linting ${scanning}` : 'lint fleet'}</button></form></header>
<div role="tablist" class="tabs tabs-lift">
<input type="radio" name="board" role="tab" class="tab" aria-label="canonical" checked>
<div role="tabpanel" class="tab-content bg-base-200 border-base-300 rounded-box p-3 sm:p-4">
<div class="grid grid-cols-2 sm:grid-cols-5 gap-3">
${stat('canonical', `${clean}/${rows.length}`, 'text-success')}${KINDS.map((kind) => stat(`${kind} off`, `${offCount(kind)}`, 'text-warning')).join('')}</div>
<div class="card bg-base-100 border border-base-content/10 shadow-md overflow-x-auto mt-3">
<table id="canonical" class="table table-xs sm:table-sm table-pin-rows"><thead><tr>${sortable('name', 'name')}${KINDS.map((kind) => sortable(kind, kind)).join('')}</tr></thead>
<tbody>${body}</tbody></table></div></div>
<input type="radio" name="board" role="tab" class="tab" aria-label="git">
<div role="tabpanel" class="tab-content bg-base-200 border-base-300 rounded-box p-3 sm:p-4">${renderGit(gitRows)}</div>
</div></main><script type="module">${SCRIPT}</script></body></html>`
}
