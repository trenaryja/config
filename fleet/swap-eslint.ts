import { registerHooks } from 'node:module'
import self from '../package.json' with { type: 'json' }

const working = new URL('../eslint.js', import.meta.url).href
const installed = new RegExp(String.raw`/${self.name}/eslint\.js$`)

/** every installed copy of our eslint.js resolves to the working one, so its imports resolve against this repo's deps */
registerHooks({
	resolve: (specifier, context, nextResolve) => {
		const result = nextResolve(specifier, context)
		return installed.test(result.url) ? { ...result, url: working } : result
	},
})
