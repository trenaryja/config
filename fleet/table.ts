import { columnLines } from '../tren/columns.ts'

/** `prefix` shows in the text report only */
type Line = { text: string; tone: string; prefix?: string }

/** what opens from a cell: a dialog on the dashboard, a block of lines in the text report */
type Detail = {
	title: string
	lines: readonly Line[]
	/** the file's contents; its presence widens the dialog */
	raw?: string
	/** the dialog button's text, when it differs from the cell's */
	label?: string
	button?: string
	hint?: string
}

/** `badge` renders `text` as a pill in `tone`; otherwise `tone` colours the cell */
export type View = { text: string; tone?: string; badge?: true; detail?: Detail }

export type Column<Row> = { key: string; view: (row: Row) => View; sort: (row: Row) => number }

export type Table<Row> = {
	id: string
	columns: readonly Column<Row>[]
	name: (row: Row) => string
	tags?: (row: Row) => readonly { text: string; tone?: string }[]
	/** indented sub-rows that fill the same columns */
	children?: (row: Row) => readonly { name: string; branch: string; views: readonly View[] }[]
}

export const escape = (text: string) => text.replaceAll(/[&<>"]/g, (char) => `&#${char.codePointAt(0)};`)

export const detailsOf = <Row>(table: Table<Row>, row: Row) =>
	table.columns.flatMap((column) => column.view(row).detail ?? [])

export const formatTable = <Row>(table: Table<Row>, rows: readonly Row[]) => {
	const lead = (name: string, tags: string) => [name, ...(table.tags ? [tags] : [])]
	return columnLines([
		[...lead('', ''), ...table.columns.map((column) => column.key)],
		...rows.flatMap((row) => [
			[
				...lead(table.name(row), (table.tags?.(row) ?? []).map((tag) => tag.text).join(' · ')),
				...table.columns.map((column) => column.view(row).text),
			],
			...(table.children?.(row) ?? []).map((child) => [
				...lead(`  ${child.name} (${child.branch})`, ''),
				...child.views.map((view) => view.text),
			]),
		]),
	])
}

/** a titled block of indented lines; none, no block */
export const block = (title: string, lines: readonly Line[]) =>
	lines.length
		? [`\n${title}`, ...lines.map((line) => `  ${(line.prefix ?? '') + line.text}`.replaceAll('\n', '\n  '))]
		: []

/** a dialog, not an inline disclosure: expanding inside a cell widens its column and reflows the whole table */
const modal = ({ title, lines, raw, label, button = '', hint }: Detail, text: string) =>
	`<button class="btn btn-xs btn-soft ${button} tabular-nums"${hint ? ` title="${hint}"` : ''} onclick="this.nextElementSibling.showModal()">${escape(label ?? text)}</button>
	<dialog class="modal modal-bottom sm:modal-middle text-left"><div class="modal-box ${raw === undefined ? '' : 'sm:max-w-3xl'} space-y-3">
	<h3 class="font-mono font-bold break-all">${escape(title)}</h3><ul class="font-mono text-xs space-y-1 whitespace-pre-wrap break-words">${lines.map((line) => `<li class="${line.tone} rounded-box px-2 py-1">${escape(line.text)}</li>`).join('')}</ul>
	${raw ? `<pre class="bg-base-300 rounded-box p-3 text-xs overflow-auto max-h-[50dvh]">${escape(raw)}</pre>` : ''}
	<form method="dialog" class="modal-action"><button class="btn btn-sm">close</button></form></div>
	<form method="dialog" class="modal-backdrop"><button>close</button></form></dialog>`

const renderView = ({ text, tone, badge, detail }: View) => {
	if (detail) return `<td class="text-center">${modal(detail, text)}</td>`
	if (badge)
		return `<td class="text-center"><span class="badge badge-soft badge-sm ${tone}">${escape(text)}</span></td>`
	return `<td class="text-center tabular-nums whitespace-nowrap ${tone ?? (text === '·' ? 'text-base-content/30' : '')}">${escape(text)}</td>`
}

const sortable = (key: string) =>
	`<th data-key="${key}" class="${key === 'name' ? '' : 'w-px text-center'}"><button class="btn btn-ghost btn-xs gap-0.5 px-1">${key}<span class="text-primary"></span></button></th>`

export const renderTable = <Row>(table: Table<Row>, rows: readonly Row[]) => {
	const body = rows.map((row) => {
		const name = escape(table.name(row))
		const tags = table
			.tags?.(row)
			.map(({ text, tone = '' }) => `<span class="badge badge-soft ${tone} badge-sm">${escape(text)}</span>`)
		return `<tbody data-name="${name}" ${table.columns.map((column) => `data-${column.key}="${column.sort(row)}"`).join(' ')}><tr>
		<th class="font-mono font-normal break-all">${name}${tags ? `<div class="flex flex-wrap gap-1 mt-1">${tags.join('')}</div>` : ''}</th>${table.columns.map((column) => renderView(column.view(row))).join('')}</tr>${(table.children?.(row) ?? []).map((child) => `<tr class="bg-base-200/40"><th class="font-mono font-normal pl-6 min-w-56 break-words">↳ ${escape(child.name)}<div class="text-xs text-base-content/50">${escape(child.branch)}</div></th>${child.views.map(renderView).join('')}</tr>`).join('')}</tbody>`
	})
	return `<div class="card bg-base-100 border border-base-content/10 shadow-md overflow-x-auto mt-3">
<table id="${table.id}" class="table table-xs sm:table-sm table-pin-rows"><thead><tr>${['name', ...table.columns.map((column) => column.key)].map(sortable).join('')}</tr></thead>
${body.join('\n')}</table></div>`
}
