const board = document.querySelector('#board')
const params = new URLSearchParams(location.search)
const save = () => history.replaceState(null, '', params.size ? `?${params}` : location.pathname)

const byName = (a: HTMLElement, b: HTMLElement) => (a.dataset.name ?? '').localeCompare(b.dataset.name ?? '')

const hydrate = () => {
	const tabs = [...document.querySelectorAll<HTMLInputElement>('[role=tab]')]
	for (const tab of tabs) {
		if (tab.ariaLabel === params.get('tab')) tab.checked = true
		tab.addEventListener('change', () => {
			if (tab === tabs[0]) params.delete('tab')
			else params.set('tab', tab.ariaLabel ?? '')
			save()
		})
	}
	for (const table of document.querySelectorAll('table')) {
		const sortBy = (key: string, descending: boolean) => {
			const arrow = table.querySelector(`:scope th[data-key="${key}"] span`)
			if (!arrow) return
			const rows = [...table.tBodies].toSorted(
				key === 'name' ? byName : (a, b) => Number(a.dataset[key]) - Number(b.dataset[key]) || byName(a, b),
			)
			table.append(...(descending ? rows.toReversed() : rows))
			Object.assign(table.dataset, { sort: key, direction: descending ? 'desc' : 'asc' })
			for (const other of table.querySelectorAll(':scope th[data-key] span')) other.textContent = ''
			arrow.textContent = descending ? '▼' : '▲'
			params.set(table.id, (descending ? '-' : '') + key)
			save()
		}
		for (const button of table.querySelectorAll(':scope th[data-key] button'))
			button.addEventListener('click', () => {
				const key = button.parentElement?.dataset.key ?? ''
				sortBy(key, table.dataset.sort === key && table.dataset.direction !== 'desc')
			})
		const saved = params.get(table.id)
		if (saved) sortBy(saved.replace(/^-/, ''), saved.startsWith('-'))
	}
}

/** polls while a scan runs; the board is re-rendered whole */
const load = async () => {
	if (!board) return
	board.innerHTML = await (await fetch('/board')).text()
	board.ariaBusy = null
	hydrate()
	if (board.querySelector('.loading')) setTimeout(() => void load(), 3000)
}

await load()
