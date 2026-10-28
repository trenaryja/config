import type { ESLint, Linter } from 'eslint'
import type { ESLintRules } from 'eslint/rules'
import type { RuleOptions } from './eslint-rules.gen.js'

/** every rule this package ships, options included: ESLint's own core types, minus the index signature that would let a typo through, plus the generated plugin types */
export type Rules = RuleOptions & {
	[Rule in keyof ESLintRules as string extends Rule ? never : Rule]?: ESLintRules[Rule]
}

/** A config object whose `rules` are checked against every rule this package ships, options included; a plugin it registers opens up `<plugin>/*` keys, options unchecked */
export type Override<Plugin extends string = never> = Omit<Linter.Config, 'plugins' | 'rules'> & {
	plugins?: Record<Plugin, ESLint.Plugin>
	rules?: Rules & Partial<Record<`${Plugin}/${string}`, Linter.RuleEntry>>
}

/**
 * The shipped config, with `overrides` appended so they win.
 * - Overrides are a bandaid: a rule that fires wrongly belongs fixed in this package, not patched in each repo.
 */
export declare const defineConfig: <const Plugin extends string = never>(
	...overrides: readonly Override<Plugin>[]
) => Linter.Config[]
