# @trenaryja/config

Shared eslint, prettier, tsconfig, Renovate and release-it config for Bun repos, plus a `tren` CLI. Each config is a thin layer on its upstream, with every deviation commented inline.

## Install

```sh
bun add -d @trenaryja/config
```

It ships eslint + plugins, prettier + plugins, typescript and `@types/bun`. Don't declare those yourself unless your code imports one, or you need a newer version than this package ships.

- eslint, prettier and their plugins are pinned exactly, so lint and format results move mostly with this package's releases; the plugins' own `^` dependencies (axe-core, refa, @babel) can still shift them. `typescript` and `@types/bun` pick up new minors on their own.
- Not included: `react` + `@types/react`. Their majors move together, so each repo keeps both.
- Workspace repos need `linker = "hoisted"` under `[install]` in the root `bunfig.toml`, because Next looks for `typescript` inside each app, where Bun's isolated linker doesn't put it. `tren fix` adds it.

## Scripts

```json
{
	"chk": "tren chk",
	"ci": "tren ci",
	"fix": "tren fix"
}
```

`tren --help` says what each command does. Chain repo-specific checks after `chk`: `tren chk && bun scripts/validate.ts`.

## CI

```yaml
name: CI
on:
  push:
    branches: [main, 'renovate/**']
  workflow_dispatch:
jobs:
  ci:
    uses: trenaryja/config/.github/workflows/ci.yml@main
```

`renovate/**` lets Renovate's automerge see a passing check.

## eslint

Each plugin's own preset, plus named changes in `eslint/index.js`. `eslint.config.mjs`:

```js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()
```

Extra config objects can be passed, and their rules are type-checked:

```js
export default defineConfig({ files: ['scripts/**'], rules: { complexity: ['error', { max: 30 }] } })
```

## tsconfig

| Preset         | For                                                  |
| -------------- | ---------------------------------------------------- |
| `base`         | Bun CLIs and packages                                |
| `workspace`    | monorepo roots                                       |
| `node`         | Node-hosted code, like VS Code or Raycast extensions |
| `dom`          | browser code that isn't a framework app              |
| `next`, `vite` | apps                                                 |

```json
{ "extends": "@trenaryja/config/tsconfig/base" }
```

## prettier

In `package.json`:

```json
{ "prettier": "@trenaryja/config/prettier" }
```

## Renovate

`renovate.json`:

```json
{ "extends": ["github>trenaryja/config//renovate/base"] }
```

One grouped update a week plus a lockfile refresh, merged automatically once CI passes. Majors wait for your approval on the Dependency Dashboard.

## release-it

Only if you publish: `bun add -d release-it @release-it/conventional-changelog`. Then in `package.json`:

```json
{ "release-it": { "extends": "@trenaryja/config/release-it" } }
```

A release runs `bun run ci` first, then bumps, tags and opens a GitHub release. It never publishes: publish from CI.
