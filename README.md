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

## eslint

Base: [@fullstacksjs/eslint-config](https://github.com/fullstacksjs/eslint-config) — detects test frameworks and storybook by itself. This layer adds:

- `typescript`, `react` and `next` always on — upstream's detection reads false from a monorepo root
- the official React Compiler diagnostics (`eslint-plugin-react-hooks`)
- Vercel's `next/*` error severities
- upstream's Tailwind class lint, minus class order, wherever a CSS file does `@import 'tailwindcss'` — each against its own package's CSS

`eslint.config.mjs`:

```js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()
// or with per-repo extras: defineConfig({ ignores: ['generated/**'], rules: { 'no-bitwise': 'off' } })
```

## tsconfig

- `base` — Bun CLIs and internal packages; keeps build output (`dist`, `target`) out of `tsc`
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
