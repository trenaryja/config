import self from '../package.json'

/** `bun --preload` this: every installed copy of our eslint.js re-exports the working one, so its imports resolve against this repo's deps as the next release will */
await Bun.plugin({
	name: 'swap-eslint',
	setup(build) {
		build.onLoad({ filter: new RegExp(`/${self.name}/eslint\\.js$`) }, () => ({
			contents: `export * from ${JSON.stringify(`${import.meta.dir}/../eslint.js`)}`,
			loader: 'js',
		}))
	},
})
