import { registerHooks } from 'node:module'
import self from '../package.json' with { type: 'json' }

const working = new URL('../eslint/index.js', import.meta.url).href
// TODO: drop the `eslint.js` form once no fleet repo installs @trenaryja/config 0.2.x, whose config sat at the package root
const installed = new RegExp(String.raw`/${self.name}/eslint(?:\.js|/index\.js)$`)

/** every installed copy of our eslint config resolves to the working one, so its imports resolve against this repo's deps */
registerHooks({
	resolve: (specifier, context, nextResolve) => {
		const result = nextResolve(specifier, context)
		return installed.test(result.url) ? { ...result, url: working } : result
	},
})
