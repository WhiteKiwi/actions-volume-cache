# actions-volume-cache

[![CI](https://github.com/WhiteKiwi/actions-volume-cache/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/WhiteKiwi/actions-volume-cache/actions/workflows/ci.yml)

Restore and update **uncompressed local caches** on persistent volumes for Linux
GitHub Actions self-hosted runners.

- Keep cache transfers on the local filesystem.
- Give each job its own writable copies, with concurrent reads across jobs.
- Update the primary key after successful jobs, including exact cache hits.
- Use one action with bundled Linux x64/arm64 lock helpers. The action needs no
  external `flock`, Go toolchain, compiler, Docker, or elevated privileges.

**Versioning:** use `@v1` for compatible 1.x updates, or `@v1.0.0` to select the
[first release](https://github.com/WhiteKiwi/actions-volume-cache/releases/tag/v1.0.0).
Both are Git tags. Native x64/arm64 CI covers the action and GitHub post-job
lifecycle. Live ARC deployment and performance measurements remain separate
qualification work. See [versions and upgrades](docs/USAGE.md#versions-and-upgrades)
for fixed versions and optional full commit-SHA pinning.

## Contents

- [Quick start](#quick-start)
- [Runner requirements](#runner-requirements)
- [Inputs](#inputs)
- [Output](#output)
- [Cache behavior](#cache-behavior)
- [Versions and upgrades](#versions-and-upgrades)
- [Differences from actions/cache](#differences-from-actionscache)
- [Guides and support](#guides-and-support)
- [Development](#development)

## Quick start

First, have the runner operator provide a persistent, writable `/cache` mount
outside the job workspace. The action uses that mount; it does not create or
provision it. See the [runner setup guide](docs/RUNNERS.md).

For an npm project with a committed `package-lock.json` and a `test` script,
copy this to `.github/workflows/ci.yml`:

```yaml
name: npm CI with local cache
on:
  push:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  test:
    runs-on: [self-hosted, linux] # Replace with your runner labels or ARC scale-set name.
    env:
      NPM_CONFIG_CACHE: ${{ github.workspace }}/.cache/npm
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
          package-manager-cache: false
      - name: Restore and update npm cache
        id: local-cache
        uses: WhiteKiwi/actions-volume-cache@v1
        with:
          volume-path: /cache
          path: .cache/npm
          key: ${{ runner.os }}-${{ runner.arch }}-node24-npm-${{ hashFiles('package-lock.json') }}
          restore-keys: |
            ${{ runner.os }}-${{ runner.arch }}-node24-npm-
      - run: npm ci
      - run: npm test
```

Change `runs-on`, the mount path, and project commands for your environment.
For ARC, use the scale-set name supplied by your operator instead of assuming
the default `self-hosted` labels exist. The workspace-local npm cache gives jobs
private destinations, and `package-manager-cache: false` avoids adding a second
GitHub-hosted npm cache through `setup-node`.

The first successful run saves during the action's post step. A later job using
the same persistent storage, repository, compatible key, and logical path can
restore it. Keep running `npm ci` and tests on a hit: cached downloads do not
replace dependency installation or build verification.

Copyable workflows: [npm](examples/npm.yml), [pnpm](examples/pnpm.yml), and
[Rust / Cargo](examples/rust.yml). These are project templates; runner deployment
and each project's build commands must be validated in your environment.

## Runner requirements

| Requirement | What to provide                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform    | Linux x64 or arm64, with an Actions runner supporting `node24`.                                                                                          |
| Storage     | A persistent local filesystem supporting kernel flock and atomic rename, mounted at a canonical absolute path.                                           |
| Permissions | The runner user can read, write, and traverse the mount. Jobs sharing entries use compatible ownership; see [runner setup](docs/RUNNERS.md#permissions). |
| Job paths   | Private writable destinations for every job, including any paths under `HOME`.                                                                           |
| Trust       | Trusted jobs sharing the writable mount. Repository namespaces organize caches; they do not isolate filesystem access.                                   |

NFS/SMB and hostile processes sharing storage are outside the current support
boundary. No custom token or cache server is required by this action. Project
tools such as Node, pnpm, or Rust are configured separately by the workflow.

## Inputs

| Input                    | Required | Default | Meaning                                                                                                                             |
| ------------------------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `path`                   | Yes      | None    | Files/directories to copy; multiline paths, globs, `~`, and `!` exclusions are supported.                                           |
| `key`                    | Yes      | None    | Exact primary lookup key and the destination key for successful saves.                                                              |
| `restore-keys`           | No       | Empty   | Ordered fallback keys/prefixes, evaluated separately for each logical path.                                                         |
| `volume-path`            | Yes      | None    | Existing persistent mount visible inside the runner; use its canonical absolute path.                                               |
| `auto-cleanup`           | No       | `true`  | Run age-based and abandoned-data cleanup during action execution.                                                                   |
| `cleanup-retention-days` | No       | `7`     | Positive number of days since the last successful restore/save before an entry is eligible for cleanup.                             |
| `max-cache-size`         | No       | Unset   | Aggregate committed payload budget across repositories in v2; for example `20GiB`. Over-budget saves warn and preserve old entries. |

See [usage and key design](docs/USAGE.md) for matching order, path examples,
capacity accounting, and cleanup settings. Configure consistent retention and
budgets across jobs sharing a volume. The budget is an admission check, not a
filesystem quota; concurrent staging and other data need extra disk headroom.

## Output

Only `cache-hit` is exposed. Step outputs are **strings**:

| Value     | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| `'true'`  | Every requested unit restored from the exact primary key. |
| `'false'` | Some data restored, with a missing unit or fallback key.  |
| `''`      | No cache data restored, including a cold miss.            |

Use explicit string comparisons such as
`steps.local-cache.outputs.cache-hit == 'true'` when reporting a hit. An exact
hit still gets updated after a successful job. See [output usage](docs/USAGE.md#reading-cache-hit).

## Cache behavior

- Entries are scoped by repository ID, key, and logical path. Adding a new path
  does not invalidate another path's entry. Same-repository branches share
  entries unless you include branch information in the key.
- Restoration merges cached files into job destinations. Cached files replace
  ordinary-file collisions; destination-only and excluded files remain.
- Jobs build using private copies. Readers can overlap; publication and deletion
  take an exclusive entry lock. Unrelated entries can copy concurrently.
- Successful jobs publish under `key`, including exact hits and fallback
  restores. The last completed publication wins per key/path. Failed or cancelled
  jobs do not publish updates.
- File times, ordinary permission bits, and symlinks are preserved. Links are not
  traversed. Restored files belong to the current runner user.
- Invalid inputs and unsafe destinations fail the action. Ordinary cache I/O
  failures warn and let the job continue. An unrecoverable restore journal fails
  the action so a partially restored workspace cannot proceed unnoticed.

## Versions and upgrades

```yaml
- uses: WhiteKiwi/actions-volume-cache@v1
```

- `v1` is a moving major-version **tag** for the latest approved compatible 1.x
  release. It is updated when releasing, independently of ongoing main development.
- `v1.0.0` is the fixed tag for the first release. Exact release tags are never
  moved; corrections are published as a new version.
- A full commit SHA selects a specific commit if your workflow requires that
  level of pinning. See the [upgrade guide](docs/USAGE.md#versions-and-upgrades).

Release history is in the [changelog](CHANGELOG.md). Maintainers follow the
[release procedure](docs/RELEASING.md) before publishing or advancing tags.

Storage currently uses `actions-volume-cache/v2`. Previous v1 storage remains
untouched and is a cold miss for v2. It is outside v2 cleanup and accounting but
still uses disk space. Storage format versions are separate from action release
tags. See [implementation and compatibility](docs/IMPLEMENTATION.md).

## Differences from actions/cache

| Concern              | This action                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| Storage              | Operator-provided local volume; no automatic GitHub cache-service fallback.  |
| Transfer             | Uncompressed private copies; still needs copy time and temporary disk space. |
| Existing primary key | Updated after successful jobs.                                               |
| Multiple paths       | Matched independently by logical path.                                       |
| Branches             | Shared within the repository unless encoded in keys.                         |
| Public interface     | One combined action and one `cache-hit` output.                              |
| Capacity             | Optional local admission budget; no eviction solely to make a save fit.      |

Tool caches with their own safe concurrency support can use operator-managed
paths such as `/cache/shared/pnpm` directly. Those paths are outside this action's
managed cleanup. See [shared tool caches](docs/USAGE.md#shared-tool-caches).

## Guides and support

- [Runner setup](docs/RUNNERS.md): mounts, permissions, persistent storage, and ARC.
- [Usage](docs/USAGE.md): keys, fallback order, paths, outputs, cleanup, and migration.
- [Troubleshooting](docs/TROUBLESHOOTING.md): misses, missing saves, permissions, and limits.
- [Specification](docs/SPEC.md), [implementation](docs/IMPLEMENTATION.md), and
  [verification coverage](docs/TESTING.md): the contract and technical boundaries.
- [Report a problem](https://github.com/WhiteKiwi/actions-volume-cache/issues/new):
  include the action version/ref, runner OS/architecture, sanitized step configuration,
  cache warnings, and whether the problem occurs on restore or post-job save.
  Keep credentials and cached file contents out of reports.

## Development

Contributors use Linux, Node 24, pnpm 11.25.0, and Go 1.27.2. Consumers run the
committed distributables and do not build the action.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec prettier --check .
```

Read the [development guide](docs/DEVELOPMENT.md) and [repository instructions](AGENTS.md)
before changing behavior or generated artifacts.
