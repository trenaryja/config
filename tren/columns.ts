import * as R from 'remeda'

export const columns = (rows: readonly (readonly string[])[]) => {
	const widths = R.range(0, Math.max(...rows.map((row) => row.length))).map((col) =>
		Math.max(...rows.map((row) => row[col]?.length ?? 0)),
	)
	return rows.map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col] ?? 0))))
}

export const columnLines = (rows: readonly (readonly string[])[], indent = '') =>
	columns(rows).map((cells) => indent + cells.join('  '))
