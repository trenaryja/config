/** output no one edits by hand: eslint and `tren comments` skip it */
export const GENERATED = [
	'**/*.gen.*',
	'**/_generated/', // codegen (Convex) rewritten on every dev run
	'**/*-env.d.ts', // regenerated on build
	'**/target/', // Cargo output; cmake litters it with `compiler_depend.ts` stubs that are not TypeScript
]
