# actions-volume-cache

Uncompressed, key-based local caches for Linux GitHub Actions self-hosted runners.

**Status: initial implementation.** Source, bundled JavaScript, local tests, and
GitHub lifecycle CI are included. There is no tagged release yet; `@v1` below is
an intended release reference, not an available tag. Use a reviewed commit SHA
when evaluating the implementation. ARC deployment and performance qualification
are separate from the source and lifecycle checks.

## What it does

1. Find local cache entries using `key`, then ordered `restore-keys`.
2. Copy cached data into the requested job paths without creating or extracting archives.
3. Let the job use its own writable copies, including during parallel jobs.
4. After a successful job, publish updated entries under `key`, including exact hits.

This keeps transfer on the local filesystem. It still copies files, consumes
temporary disk space, and needs measurement before claiming a speed improvement.
The runner and job workspace can be disposable; the cache volume must persist.

Linux self-hosted runners are the support target. ARC on K3s is the first
integration environment, not a required platform. The initial CI environment
provides 1 CPU / 2 GB per runner without Docker; repositories choose their own tools.

## Usage

Requirements: a Linux x64 or arm64 runner supporting `node24` and a persistent,
writable local filesystem supporting flock and atomic rename.
Use the canonical absolute mount path. NFS/SMB and hostile jobs sharing writable
storage are not supported by this first implementation.

The operator must mount the volume at the same runner-visible path for jobs that
should share caches. This action does not provision or mount it and needs no Docker.
The action includes native lock helpers for both architectures. Consumers do not
install `flock`, Go, a compiler, or packages and need no sudo for the action.

```yaml
# Replace @v1 with a reviewed commit SHA until a release is tagged.
- name: Restore and update local build cache
  id: local-cache
  uses: WhiteKiwi/actions-volume-cache@v1
  with:
    volume-path: /cache
    path: |
      frontend/.next/cache
      backend/target
    key: linux-build-${{ hashFiles('**/Cargo.lock', '**/pnpm-lock.yaml') }}
    restore-keys: |
      linux-build-
    auto-cleanup: true
    cleanup-retention-days: 7

- name: Build and test
  run: ./scripts/ci.sh
```

The example is an excerpt from a job, after checkout and repository-specific tool
setup. Adapt paths, compatibility keys, and the build command to the repository.

## Inputs

| Input                    | Required | Default         | Meaning                                                                                                      |
| ------------------------ | -------- | --------------- | ------------------------------------------------------------------------------------------------------------ |
| `path`                   | Yes      | None            | Files or directories to restore and save; multiline and glob/exclusion patterns supported.                   |
| `key`                    | Yes      | None            | Primary lookup key and destination key for successful saves.                                                 |
| `restore-keys`           | No       | Empty           | Ordered fallback keys/prefixes.                                                                              |
| `volume-path`            | Yes      | None            | Persistent volume path visible inside the runner.                                                            |
| `auto-cleanup`           | No       | `true`          | Run age-based cleanup during action execution.                                                               |
| `cleanup-retention-days` | No       | `7`             | Remove entries unused since their last successful restore or save for this many days.                        |
| `max-cache-size`         | No       | Unset: no limit | Aggregate managed-cache budget; for example `100GiB`. Over-budget saves fail without evicting other entries. |

## Output

Only `cache-hit` is exposed, as a string:

- `'true'`: every requested cache unit was restored from the exact primary key.
- `'false'`: some data was restored, but a unit was missing or a fallback key was used.
- `''`: no cache data was restored.

An exact hit still gets updated after a successful job. A hit is not a guarantee
that the current build or tests can be skipped.

## Behavior to know

- Cache units are independent key/path pairs within a repository namespace.
- Restore merges into existing paths: cached files overwrite collisions, while
  destination-only files remain. Exclusions stay untouched.
- Successful jobs update caches; failed or cancelled jobs do not publish updates.
- Parallel jobs work independently. The last completed publication wins per key/path pair.
- Ordinary cache I/O failures warn and allow the job to continue. Invalid inputs fail the action.
- Same-repository branches share entries when their keys match; branch isolation is explicit in keys.
- Preserve modification times, read/write/execute permissions, and symbolic links.
  Restored files belong to the current runner user; original UID/GID are not restored.
- Cleanup is age-based. A size limit rejects a save instead of triggering size-based eviction.

## Shared tool caches

Tools that safely support concurrent cache access can point directly at an
operator-managed location such as `/cache/shared/pnpm`. They do not need this
action. Configure their cache directories in the workflow or tool configuration.

There is no `shared-paths` input. `/cache/shared` is outside this action's managed
subtree and cleanup scope. Trust, permissions, and tool-specific concurrency
requirements remain the operator's responsibility.

## Differences from actions/cache

The core input names and the single output are familiar, but this is not a
drop-in implementation of all GitHub cache behavior. Storage is a local volume;
copies are uncompressed; exact-key entries are mutable; matching is per path;
branch scope is controlled through keys. There are no separate restore/save
actions or automatic GitHub-service fallback in the agreed initial scope.

## Implementation and verification

The action is written in TypeScript and bundled for Node 24, with a small static
Go executable for kernel locks. Main restores; GitHub runs post-job saving only
on job success. Readers share a lock for the actual repository/key/path entry.
Publication and cleanup take an exclusive lock for that entry. Different entries
can copy data concurrently; a brief metadata lock coordinates catalog reads,
timestamps, aggregate size admission, and pointer publication. Payload copies
and recursive deletion happen outside that metadata lock.

A workspace lock protects restore recovery and overlapping action operations in
the same workspace. All locks are released before the build runs. Jobs must use
private destination paths, including any home-directory cache paths; this action
does not isolate destinations that jobs deliberately share. No cache throughput
or power-loss durability claim is made.

The new lock protocol uses `actions-volume-cache/v2`. Previous `v1` data stays
untouched and is a cold miss for this implementation. It is outside v2 cleanup
and `max-cache-size` accounting but still occupies disk space. Existing v1 clients
can keep using their separate subtree; this is not an automatic data migration.

Restore uses prepared copies and a rollback journal. Recoverable merge failures
roll back; an unrecoverable journal/rollback error fails the action instead of
allowing a partially restored workspace to proceed. A later invocation to the
same path recovers an interrupted merge before attempting any hit or miss.

For development with Node 24, pnpm 11.25.0, and Go 1.27.2:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec prettier --check .
```

`pnpm check` type-checks, builds the distributables, and runs functional,
multi-process, process-death, and standalone bundle tests. The CI workflow also
checks real successful/failed GitHub job main/post behavior and reproducible
distributables. See the acceptance plan for coverage and remaining qualification.

## Documentation

- [Specification](docs/SPEC.md)
- [Implementation design and support limits](docs/IMPLEMENTATION.md)
- [Development workflow and implementation plan](docs/DEVELOPMENT.md)
- [Acceptance and verification plan](docs/TESTING.md)
- [Repository instructions for agents](AGENTS.md)
