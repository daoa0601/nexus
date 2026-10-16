# Nexus quality gates

This repository uses pnpm 11.13.1 exclusively. pnpm enforces it natively through `packageManager`
and `engines.pnpm` in `package.json` plus `engineStrict` and `pmOnFail: error` in
`pnpm-workspace.yaml`; npm cannot resolve the `workspace:*` dependencies.

## Setup

```bash
pnpm --version
pnpm install --frozen-lockfile
pnpm hooks:install
```

Use a supported Node.js release from `package.json`. CI and clean-room verification must always use `pnpm install --frozen-lockfile`.

## Shared TypeScript policy

Nexus uses the sibling `@agentic-orch/ts-quality` development module for the repository secret
scan, managed Git-hook templates, strict Node.js TypeScript baseline, and Prettier defaults. The
repository-level commands below remain stable; their shared mechanics delegate to `ts-quality` so
fixes land once. Coverage floors, Nexus's additional compiler flags, build behavior, and dependency
policy remain owned by this repository.

## Siblings

`node-guardrails` and `ts-quality` must be checked out next to this repository; see the catalog
README for the layout. The lock resolves them as `link:` entries, so a missing sibling fails the
frozen install instead of falling back to a registry. The GitHub workflow checks both out at their
default branch, and `pnpm install` builds `node-guardrails` through its `prepare` script.

## Gate ladder

| Command                | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm quality:quick`   | Prettier check, warning-free Oxlint, strict TypeScript, and repository secret scan.                       |
| `pnpm check`           | Quick gate plus the deterministic unit/integration test suite.                                            |
| `pnpm quality:offline` | Quick gate, coverage thresholds, and production build.                                                    |
| `pnpm deps:check`      | Production advisory audit at high severity and registry-signature verification. Requires registry access. |
| `pnpm preflight`       | Complete offline and online gate; this is the handoff command.                                            |

Coverage is measured over all `src/**/*.ts` files, including currently untested entrypoints. The enforced global floor is 75% statements, 60% branches, 80% functions, and 75% lines. Raising a floor is welcome; lowering one requires an explicit rationale.

`pnpm hooks:install` installs the package-owned managed hooks into this checkout's active Git hooks
directory:

- pre-commit runs `pnpm quality:quick`;
- pre-push runs `pnpm quality:offline`.

The hooks are a fast local feedback layer, not the source of truth. Automation should repeat the frozen install and `pnpm preflight`.

## Dependency and supply-chain policy

`pnpm-workspace.yaml` enforces:

- exact dependency saves and an exact pnpm version;
- Node engine and peer-dependency compatibility;
- frozen lockfiles in CI;
- a strict 24-hour minimum package release age;
- rejection of transitive Git/tarball dependencies;
- explicit review of every dependency lifecycle script;
- dependency-state verification before scripts run.

`minimumReleaseAge: 1440` continues to protect newly released third-party dependencies. It does not
apply to local `workspace:*` modules.

Only `esbuild` is approved to execute a third-party install script. Optional native acceleration from `msgpackr-extract` is explicitly denied. Any new lifecycle script makes installation fail until it is reviewed and recorded in `allowBuilds`.

## Secret scan scope

The shared scanner examines staged Git blobs, their current working-tree copies, and unignored
untracked files for secret-bearing filenames, private keys, common provider token formats, and
non-placeholder secret assignments in configuration files. It never follows symlinks, bounds file
reads, and reports only escaped file and line metadata—never the matched value. This supplements
host and repository secret-scanning controls; it does not replace them.
