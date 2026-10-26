# @trenaryja/config

One package for the shared configs. Each config is a thin layer on a well-kept upstream. Each deviation has an inline comment that says why.

## Toolchain

This package ships every tool its configs need as regular dependencies. Bun hoists them into each consuming repo — do not declare them there unless the repo's own code imports one (`no-extraneous-dependencies` asks for it). `bun fleet verify deps [repo…]` lists what a repo declares but doesn't need: a tool shipped here that it never imports, or a package nothing imports, runs or loads:

- `eslint` and its plugins
- `prettier` and its plugins — for editors; `bun fmt` reads the same config
- `typescript` (see below)
- `release-it` and `@release-it/conventional-changelog`
- `@types/bun`

A workspace repo needs `linker = "hoisted"` under `[install]` in its root `bunfig.toml` — Bun's isolated linker, the monorepo default, hoists nothing.

Not included: `react` + `@types/react`. Their majors move together, so each repo keeps both.

### Scripts

Every repo runs the same two:

```json
{
	"chk": "bun check && bun fmt --check && eslint . --max-warnings=0",
	"fix": "eslint --fix .; bun fmt"
}
```

`fix` chains with `;`, not `&&`: a hit eslint can't fix would otherwise skip `bun fmt` and leave its half-applied fixes unformatted.

A workspace root appends `. '!apps' '!packages'` to each `bun fmt` and `--ignore-pattern apps --ignore-pattern packages` to each `eslint`: members run their own, so turbo filters and caches them per package.

`chk`, not `check`: a package.json script shadows the built-in of the same name, so a `check` script would hide `bun check`. `bun check` typechecks with the TS 7 compiler built into Bun 1.4.4+.

### TypeScript 6 for the API

`typescript` stays on 6.x for typescript-eslint, editors and `next build`; the TypeScript rule in `default.json` holds it there and says why. Typechecks run TS 7 through `bun check`.

Exit, once that rule's condition is met:

1. Bump `typescript` to `^7`.
2. Delete the TypeScript rule in `default.json`.
3. Release once.

## eslint

Each plugin's own published preset, plus one layer of named changes in `eslint.js`:

- `@eslint/js` recommended, `typescript-eslint` strict and stylistic (type-checked), `regexp`, `unicorn`, `de-morgan`, `react-hooks` (React Compiler diagnostics), `jsx-a11y-x` strict, `import-x`, and `@next/eslint-plugin-next` core-web-vitals where the package depends on `next`
- size and complexity limits (`max-*`, `complexity`)
- nothing tsc already reports: the compiler gate in `tsconfig/base.json` owns those
- no entry that repeats a preset or a rule's default options: `bun fleet verify redundant`, run in `chk`

`unicorn` is the broadest general-purpose rule set, and most of what the fleet trips. Bun's `bun lint` can't replace eslint yet: it runs unicorn, `regexp`, `jsx-a11y-x`, `import-x` and `de-morgan` as JS plugins without type information, so unicorn's typed rules misreport. Revisit once `bun lint` ships in a Bun release and JS plugins get types ([oven-sh/bun#45162](https://github.com/oven-sh/bun/issues/45162)).

`eslint.config.mjs`:

```js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()
```

That is the default file in every repo. A rule that fires wrongly across the fleet is tuned here; a hit anywhere else is fixed in the code. An `eslint-disable` comment is the escape hatch: it names its rules (`unicorn/no-abusive-eslint-disable`), fails the lint once it suppresses nothing, and `bun fleet verify report` counts the hits disables hide across the fleet.

As a bandaid until the fix lands here, `defineConfig` appends config objects after its own. Their `rules` are typed against every rule this package ships, options included, so a typo or a bad option fails `tsc`. A plugin registered in `plugins` opens up its own `<name>/*` rules, options unchecked:

```js
export default defineConfig({ files: ['scripts/**'], rules: { complexity: ['error', { max: 30 }] } })
```

## tsconfig

- `base` — Bun CLIs and internal packages; keeps build and test output out of `tsc`
- `workspace` — monorepo roots; `base` that also leaves `apps` and `packages` to their own tsconfig
- `node` — code hosted by Node (VS Code, Raycast); swaps Bun's globals for Node's
- `dom` — adds the DOM; for browser code that isn't a framework app
- `next` / `vite` — apps; `dom` plus framework needs; vite also maps `@/*` to `src/`, falling back to the root

`tsconfig.json`:

```json
{ "extends": "@trenaryja/config/tsconfig/base" }
```

## prettier

In `package.json`:

```json
{ "prettier": "@trenaryja/config/prettier" }
```

## renovate

Renovate reads this from GitHub — no publish involved. `renovate.json`:

```json
{ "extends": ["github>trenaryja/config"] }
```

## release-it

`package.json`:

```json
{ "release-it": { "extends": "@trenaryja/config/release-it" } }
```

## Releasing this package

Before releasing, `bun fleet verify scan` then `bun fleet verify report` lint every sibling repo that consumes this package against the working `eslint.js`. `bun run release` picks the version from the conventional commits, then makes the tag and the GitHub release with their changelog, authenticated by your `gh` login. Publishing that release triggers `release.yml`, which publishes to npm with provenance via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no token, no secret. The trusted publisher is configured in the npm package settings: repo `trenaryja/config`, workflow `release.yml`.

`bun fleet verify conform [repo…]` checks a consumer against the fleet's standards: the `chk` and `fix` scripts, the React Compiler wherever React builds, a Next app reading env only through `env.ts`, the shared Renovate preset, a workflow that runs `chk`, no disables or comment-audit cuts, nothing unused, and every dep at its latest version. A dep that a peer range, `engines` or a Renovate `allowedVersions` keeps behind latest prints as a hold and passes; an `allowedVersions` that no peer range or `engines` backs fails, so a hold ends when its reason does.
