# @trenaryja/config

One package for the shared configs. Each config is a thin layer on a well-kept upstream. Each deviation has an inline comment that says why.

## Toolchain

This package owns the shared tools as regular dependencies. Bun hoists them into each consuming repo — do not declare them there:

- `eslint`
- `prettier`
- `typescript` (see below)
- `@types/bun`

The rule: if this package configures a tool, this package owns the tool.

A workspace repo needs `linker = "hoisted"` under `[install]` in its root `bunfig.toml` — Bun's isolated linker, the monorepo default, hoists nothing.

Not included: `react` + `@types/react`. Their majors move together, so each repo keeps both.

### TypeScript 6 and 7, side by side

typescript-eslint does not run on TS 7 — TS 7.0 has no JS API ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)). Until support lands, this package installs both ([Microsoft's pattern](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)):

- `typescript` (6.x) — the API for typescript-eslint and editors. A Renovate rule in `default.json` holds it below 7. Do not accept a 7.x bump from `get-latest`.
- `@typescript/native` (alias of `typescript@7`) — owns the `tsc` bin. Typechecks run the native Go compiler — except `next build`, which runs the bin of whatever `typescript` resolves to, so 6.x.

Not used: the official `@typescript/typescript6` wrapper. Bun resolves its internal `npm:typescript` alias back to the wrapper itself — circular, empty module.

Exit plan, when typescript-eslint announces TS 7 support:

1. Delete `@typescript/native`.
2. Bump `typescript` to `^7`.
3. Remove the Renovate rule.
4. Release once.

### Bun-native fmt, lint and check

Bun has `bun fmt` (Prettier-compatible), `bun lint` (reads `eslint.config.mjs`, runs about half the rules natively) and `bun check` (tsc diagnostics) in canary only; stable 1.4.3 has none of them. On canary `1.4.4-canary.1` (2026-10-17), all three matched the current pipeline on this repo and health.trenary.love, 2–10× faster.

Plan, when a stable Bun ships all three:

1. Run `fleet verify` with each command in place of `prettier -c`, `eslint` and `tsc`; every repo must report what it reports today.
2. Rename every repo's `check` script to `chk`: a package.json script shadows the built-in of the same name, so `check` would hide `bun check` and a `check` that calls `bun check` calls itself. `chk` is the CI gate (lint, types, format, tests); `fix` applies every format and lint fix it can.
3. Point `chk` and `fix` at the Bun commands fleet-wide; drop each tool this package owns once `bun fmt --doctor` and `bun lint --doctor` say nothing loads it.
4. Release once.

## eslint

Each plugin's own published preset, plus one layer of named changes in `eslint.js`:

- `@eslint/js` recommended, `typescript-eslint` with type-aware type-safety rules, `react-hooks` (React Compiler diagnostics), `jsx-a11y-x` strict, `import-x`, and `@next/eslint-plugin-next` core-web-vitals where the package depends on `next`
- size and complexity limits (`max-*`, `complexity`)
- nothing tsc already reports: the compiler gate in `tsconfig/base.json` owns those

`eslint.config.mjs`:

```js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()
```

That is the whole file in every repo, permanently: `defineConfig` takes no options, and `noInlineConfig` ignores every `eslint-disable` comment. A rule that fires wrongly across the fleet is tuned here; a hit anywhere else is fixed in the code.

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

`.release-it.js`:

```js
import config from '@trenaryja/config/release-it' with { type: 'json' }
export default config
```

## Releasing this package

Before releasing, `bun fleet verify scan` then `bun fleet verify report` lint every sibling repo that consumes this package against the working `eslint.js`. `bun run release` makes the tag and the GitHub release. Publishing that release triggers `release.yml`, which publishes to npm with provenance via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no token, no secret. The trusted publisher is configured in the npm package settings: repo `trenaryja/config`, workflow `release.yml`.
