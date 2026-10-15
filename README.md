# actions-volume-cache

Uncompressed, key-based local caches for Linux GitHub Actions self-hosted runners.

**Status: specification only.** The agreed behavior is documented, but there is
no executable action, release, or validated cache implementation yet. Examples
below describe the planned interface; `@v1` is not an available release.

## What it will do

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

## Planned usage

The operator must mount a persistent, writable volume at the same runner-visible
path for jobs that should share caches. This action will not provision or mount it.

```yaml
# Planned interface only; no v1 release exists yet.
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

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `path` | Yes | None | Files or directories to restore and save; multiline and glob/exclusion patterns supported. |
| `key` | Yes | None | Primary lookup key and destination key for successful saves. |
| `restore-keys` | No | Empty | Ordered fallback keys/prefixes. |
| `volume-path` | Yes | None | Persistent volume path visible inside the runner. |
| `auto-cleanup` | No | `true` | Run age-based cleanup during action execution. |
| `cleanup-retention-days` | No | `7` | Remove entries unused since their last successful restore or save for this many days. |
| `max-cache-size` | No | Unset: no limit | Aggregate managed-cache budget; for example `100GiB`. Over-budget saves fail without evicting other entries. |

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

## Documentation

- [Specification and decisions still to resolve](docs/SPEC.md)
- [Development workflow and implementation plan](docs/DEVELOPMENT.md)
- [Acceptance and verification plan](docs/TESTING.md)
- [Repository instructions for agents](AGENTS.md)
