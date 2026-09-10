# @trenaryja/config

One package for the shared configs: `eslint`, `tsconfig`, `prettier`, `renovate`, `release-it`. Each config is a thin layer on a well-kept upstream. Each deviation has an inline comment that says why.

## Toolchain

This package owns the shared tools as regular dependencies. Bun hoists them into each consuming repo — do not declare them there:

- `eslint`
- `prettier`
- `typescript` (see below)
- `@types/bun`

The rule: if this package configures a tool, this package owns the tool.

Not included: `react` + `@types/react`. Their majors move together, so each repo keeps both.

### TypeScript 6 and 7, side by side

typescript-eslint does not run on TS 7 — TS 7.0 has no JS API ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)). Until support lands, this package installs both ([Microsoft's pattern](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)):

- `typescript` (6.x) — the API for typescript-eslint and editors. A Renovate rule in `default.json` holds it below 7. Do not accept a 7.x bump from `get-latest`.
- `@typescript/native` (alias of `typescript@7`) — owns the `tsc` bin. Typechecks and `next build` run the native Go compiler.
- `@trenaryja/config/typescript` — re-exports `typescript` (6.x) so a consumer that needs the classic Compiler API (`createProgram`, `ScriptTarget`, …) reaches it without declaring `typescript` itself.

Not used: the official `@typescript/typescript6` wrapper. Bun resolves its internal `npm:typescript` alias back to the wrapper itself — circular, empty module.

Exit plan, when typescript-eslint announces TS 7 support:

1. Delete `@typescript/native`.
2. Bump `typescript` to `^7`.
3. Remove the Renovate rule.
4. Release once.

## eslint

Base: [@fullstacksjs/eslint-config](https://github.com/fullstacksjs/eslint-config) — finds `next`, `react`, `tailwind`, and test frameworks by itself. This layer adds:

- the official React Compiler diagnostics (`eslint-plugin-react-hooks`)
- Vercel's `next/*` error severities
- some universal overrides to taste

`eslint.config.mjs`:

```js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()
// or with per-repo extras:
export default defineConfig({ ignores: ['generated/**'], rules: { 'no-bitwise': 'off' } })
```

## tsconfig

Base: the `bun init` defaults.

- `base` — Bun CLIs and internal packages
- `next` / `vite` — apps; adds DOM and framework needs

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

`bun run release` makes the tag and the GitHub release. On tag push, `release.yml` publishes to npm with provenance via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no token, no secret. The trusted publisher is configured in the npm package settings: repo `trenaryja/config`, workflow `release.yml`.

## Non-goals

- Runtime code (TanStack helpers etc.)
- `.editorconfig`
- `.vscode` — no extends mechanism
- Biome — sticking with ESLint for now
- `turbo.json` / `bunfig.toml` / `.gitignore` — no cross-repo reference mechanism
