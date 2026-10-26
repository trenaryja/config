# @trenaryja/config

One package for the shared configs. Each config is a thin layer on a well-kept upstream. Each deviation has an inline comment that says why.

## Toolchain

This package ships every tool its configs need as regular dependencies. Bun hoists them into each consuming repo — do not declare them there unless the repo's own code imports one (`no-extraneous-dependencies` asks for it). `tren doctor`'s `unused` check lists what a repo declares but doesn't need: a tool shipped here that it never imports, or a package nothing imports, runs or loads:

- `eslint` and its plugins
- `prettier` and its plugins — for editors; `bun fmt` reads the same config
- `typescript` (see below)
- `release-it` and `@release-it/conventional-changelog`
- `@types/bun`

A workspace repo needs `linker = "hoisted"` under `[install]` in its root `bunfig.toml` — Bun's isolated linker, the monorepo default, hoists nothing.

Not included: `react` + `@types/react`. Their majors move together, so each repo keeps both.

### Scripts

Every repo runs the same three:

```json
{
	"chk": "tren chk",
	"ci": "tren ci",
	"fix": "tren fix"
}
```

`tren` is this package's bin; `tren --help` lists its commands and `tren <command> --help` its flags, each its own module in `tren/`, loaded only when it runs. Extra args pass to eslint, which is the consumer's own, cached by content outside CI.

- `chk` is the local gate: `bun check`, `bun fmt --check`, `eslint . --max-warnings=0`, with `next typegen` first when the repo depends on `next`. It never builds. A repo's own checks chain after it in its `chk` script: `tren chk && bun scripts/validate.ts`.
- `ci` runs the repo's `chk` script (or `tren chk` when there is none), then `bun run build` when the repo has a `build` script, then `bun test` when git holds a `*.test.*` or `*.spec.*` file. Every repo's `ci` script is just `tren ci`: a gate step belongs in `chk`, the build in `build`, and which tests run in `bunfig.toml`'s `[test]` section.
- `fix` is `eslint --fix .` then `bun fmt`. `bun fmt` runs even when eslint leaves a hit it can't fix, so half-applied fixes never stay unformatted; the exit code still reflects eslint.
- `update [<dep>…] [--latest]` takes every minor and patch, keeping each spec's `^`, `~` or exact pin, and lists each major with the `--latest` command that takes it; `--latest` takes majors too, and naming deps narrows either mode to them. It skips what `doctor`'s `deps-latest` check holds back (a peer range, `engines` or a Renovate `allowedVersions`) and prints those holds with their reason.
- `reinstall` deletes `node_modules` and the lockfile, every workspace member's `node_modules` included, then runs `bun install`.
- `doctor [<check>…] [--skip <check>] [--fix] [--json] [--remote]` checks the repo against the fleet's standards (see Releasing). A finding marked `(--fix)` has a repair that needs no judgment; `--fix` applies them all, formats what it touched, and reports what remains. Its `comments` check scores every comment against the comment rules, over eslint's file set: what git tracks or would add, minus the generated globs in `generated.js`, which `eslint.js` ignores too; a `cut` fails, a `review` holds. A `.gitattributes` line like `vendor/** comment-audit=off` skips a file. Outside a repo that installs this package: `bunx -p @trenaryja/config@latest tren doctor comments`.
- A workspace root's `workspaces` globs become the `bun fmt` exclusions and eslint `--ignore-pattern`s: members run their own, so turbo filters and caches them per package.

CI runs only `ci`, through the shared workflow:

```yaml
name: CI
on:
  push:
    branches: [main]
  workflow_dispatch:
jobs:
  ci:
    uses: trenaryja/config/.github/workflows/ci.yml@main
```

No `test` script: `bun test` is Bun's runner and ignores it, so `bun run test` and `bun test` would mean different things. `chk` or `ci` chains `bun test` directly.

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
- no entry that repeats a preset or a rule's default options: `bun fleet lint redundant`, run in `chk`

`unicorn` is the broadest general-purpose rule set, and most of what the fleet trips. Bun's `bun lint` can't replace eslint yet: it runs unicorn, `regexp`, `jsx-a11y-x`, `import-x` and `de-morgan` as JS plugins without type information, so unicorn's typed rules misreport. Revisit once `bun lint` ships in a Bun release and JS plugins get types ([oven-sh/bun#45162](https://github.com/oven-sh/bun/issues/45162)).

`eslint.config.mjs`:

```js
import { defineConfig } from '@trenaryja/config/eslint'

export default defineConfig()
```

That is the default file in every repo. A rule that fires wrongly across the fleet is tuned here; a hit anywhere else is fixed in the code. An `eslint-disable` comment is the escape hatch: it names its rules (`unicorn/no-abusive-eslint-disable`), fails the lint once it suppresses nothing, and `bun fleet lint report` counts the hits disables hide across the fleet.

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

Before releasing, `bun fleet lint scan` then `bun fleet lint report` lint every sibling repo that consumes this package against the working `eslint.js`. `bun run release` picks the version from the conventional commits, then makes the tag and the GitHub release with their changelog, authenticated by your `gh` login. Publishing that release triggers `release.yml`, which publishes to npm with provenance via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no token, no secret. The trusted publisher is configured in the npm package settings: repo `trenaryja/config`, workflow `release.yml`.

`tren doctor` checks the repo at the working directory (`bun fleet doctor [repo…]` checks siblings from here), printing one `path: message` per finding and exiting 1 on any but a hold; naming checks runs only those, `--skip` drops one; `--json` prints `{ root, findings }`, each finding carrying a stable `check` id (`scripts`, `compiler`, `env`, `renovate`, `workflow`, `disables`, `unused`, `deps-latest`, …). It is not part of `chk` or `ci`: `deps-latest` needs the network, and an upstream release must never turn CI red. It checks a repo against the fleet's standards: the `chk`, `fix` and `ci` scripts each running `tren chk`, `tren fix` and `tren ci` as a step, a tsconfig extending a preset with no overrides but a runtime `@/*` alias, an `eslint.config` adding nothing to `defineConfig()`, `package.json` declaring this package and its prettier preset, the React Compiler wherever React builds, a Next app reading env only through `env.ts`, the shared Renovate preset, a `chk` that never builds, no `test` script, a workflow calling the shared `ci.yml` on `main` and `renovate/**` pushes, so Renovate's branch automerge sees a check, no disables or comment-rule cuts, nothing unused, and every dep at its latest version. A dep that a peer range, `engines` or a Renovate `allowedVersions` keeps behind latest prints as a hold and passes; an `allowedVersions` that no peer range or `engines` backs must carry a `description` saying why, printed as the hold's reason, or it fails. Every hold is a hit on the fleet dashboard: it passes, and it is a goal to remove. `--remote` adds the checks that ask a hosting account, which `chk`, `ci` and a bare `doctor` never run, so they need no login; `bun fleet` passes it. Today that is Vercel, wherever a package has a `.vercel/project.json`: `vercel-env` fails for each variable `env.ts` requires (a `createEnv` `server`, `client` or `shared` key whose schema never reaches `.optional()`, `.nullish()`, `.default()` or `.catch()`, read statically; a `superRefine` that makes optional keys required together is not modelled) that the project's Production environment lacks, by name only, with the repair `vercel env add <NAME> production`; `vercel-node` fails when a project's dashboard Node.js Version (read through `vercel project inspect`) is below the newest major in `vercel project update --help`'s `--node-version` list, or when the `package.json` of the app the project builds (its Root Directory) declares `engines.node`, which silently overrides the dashboard setting so it must go; `--fix` removes `engines.node` and, since `--remote` is what runs the check, also runs `vercel project update --node-version <newest> --yes`, which changes the Production project's setting. A `--help` that lists no versions fails, naming the cause. A missing or signed-out CLI fails `vercel-env` with `vercel login`, never a skip.
