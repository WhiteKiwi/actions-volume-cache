# Specification

Status: agreed requirements with an initial implementation. Baseline: 2026-10-15.

This document is the product contract for the first implementation. Requirements
below are decisions. [IMPLEMENTATION.md](IMPLEMENTATION.md) records engineering
choices and support limits; [TESTING.md](TESTING.md) separates acceptance goals
from the evidence currently available.

## 1. Purpose and support boundary

Provide a local-volume cache action for Linux GitHub Actions self-hosted runners.
Jobs restore private writable copies, run in parallel, and publish cache updates
after success. Cache storage uses native files and directories without archive
compression, extraction, or a network cache service.

The operator supplies a persistent writable filesystem mount. The action does not
provision storage, mount filesystems, install tools, or manage runners. ARC on K3s
is the first integration target; ordinary Linux self-hosted runners remain in scope.
The first deployment target is a common 1 CPU / 2 GB runner without Docker.

Copies still cost local I/O, time, and temporary disk space. No performance claim
or support matrix is established until measured.

## 2. Public interface

One action restores during its main step and saves in its post-job phase when
the job succeeds. There are no separate restore, save, or cleanup actions in the
initial contract. There is no background cleanup service or scheduler installation.

### Inputs

| Name                     | Required | Default | Contract                                                                                                          |
| ------------------------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `path`                   | Yes      | None    | Nonempty multiline list of files, directories, or glob patterns; `!` patterns exclude matches.                    |
| `key`                    | Yes      | None    | Nonempty primary lookup key and destination key for updates.                                                      |
| `restore-keys`           | No       | Empty   | Ordered multiline fallback keys/prefixes; no data from a candidate means continue searching.                      |
| `volume-path`            | Yes      | None    | Persistent cache volume path visible inside the runner.                                                           |
| `auto-cleanup`           | No       | `true`  | Enable age-based cleanup during action execution.                                                                 |
| `cleanup-retention-days` | No       | `7`     | Retention since the last successful restore or save, in days.                                                     |
| `max-cache-size`         | No       | Unset   | Aggregate budget for this action's managed caches; `100GiB` is an intended value. Over-budget saves are rejected. |

Further optional inputs from `actions/cache`, including `lookup-only`,
`fail-on-cache-miss`, and cross-OS archive controls, are not in the initial
interface. Parsing ranges and accepted size units are documented in the
implementation design.

### Output

Expose only `cache-hit`. GitHub step outputs are strings.

| Value     | Meaning                                                                                     |
| --------- | ------------------------------------------------------------------------------------------- |
| `'true'`  | Every requested cache unit was successfully restored using the exact primary `key`.         |
| `'false'` | At least one unit was restored, but another was missing or used a fallback key.             |
| `''`      | No units were successfully restored, including a cold miss or recoverable restore failures. |

An exact hit does not skip saving. The output describes restoration, not build
correctness or whether future steps should run. Do not add matched-key,
primary-key, save-result, or cache-path outputs without changing this contract.

## 3. Cache identity and layout

Identify entries by repository, key, and logical path. Multiple paths are
independent units, not one bundle invalidated by hashing the entire `path` input.
Adding a path must not invalidate the cache for another unchanged path.

Use the GitHub repository ID for the repository namespace. Represent user keys
and path identities using safe hashes in filesystem names; retain their logical
values in bounded metadata for matching and inspection. Never use raw key text
as a path fragment.

The conceptual layout is:

```text
${volume-path}/
  shared/                              # Operator/tool managed; never cleaned here.
  actions-volume-cache/
    ${repository-id}/
      ${key-hash}/
        ${path-hash}/                   # Entry data and metadata.
```

This layout describes logical ownership. Generation directories, indexes,
locks, and staging names are implementation details and are not a public API.
Include a storage format version so future readers can reject incompatible data.

Path identity must survive disposable runner workspace/home locations. Define
normalization before implementation; do not hash an ephemeral runner's absolute
checkout path in a way that silently prevents reuse. Exact encoding and versioning
are open engineering decisions.

Branches within one repository share entries when key/path identities match.
There is no implicit branch scope or automatic default-branch lookup. Workflows
can include branch, platform, toolchain, or dependency identifiers in their keys.
Different repositories must not match each other's entries through this action.

Repository directories are namespacing, not a filesystem security boundary. A
job with direct write access to the whole mount can access other data on it.
Operator permissions, trusted-job policy, and mount boundaries remain separate.

## 4. Matching and restoration

For each cache unit:

1. Try an exact match for the primary `key` and that logical path.
2. If unavailable, evaluate `restore-keys` in input order.
3. For each fallback, prefer an exact key; otherwise choose the most recently
   successfully saved matching key with that prefix and compatible path identity.
4. Skip candidates with unreadable data or detected structural damage and try remaining candidates.
5. If no usable candidate exists, continue without cached data for that unit.

The primary key does not implicitly become a prefix search. A workflow can list
it explicitly in `restore-keys` if it wants that fallback behavior. Recency is
publication/save recency, not the access timestamp used for retention.

Select one source per path unit. Do not merge several candidate keys into one
unit. Different path units may restore from different keys.

### Path syntax and absence

Support files, directories, multiline paths, workspace-relative paths, absolute
paths, `~`, `*`, `**`, and `!` exclusions. Exclusions are filters, not cache units.
Globs must be able to discover restorable saved paths even when those paths do
not yet exist in a fresh workspace. Define glob expansion, overlapping paths,
and identity rules in the implementation design rather than assuming one hash
per input line handles every case.

A missing or empty required input is invalid. A valid path referring to a
directory that does not yet exist is normal: create it when restoring cached
data, or allow the build to create it after a miss.

### Destination behavior

On a usable hit, replace each selected destination root with a prepared private
copy. This also replaces nonempty directories and file/directory type collisions.
Destination-only files and existing excluded files beneath a replaced root are
removed. Exclusions filter the restored content; they do not preserve existing
content inside a replaced root. A miss or empty restore selection leaves the
existing root unchanged. Select disposable cache paths, not directories containing
other application data.

Prepare the complete copy beside the destination on the same mounted filesystem.
Rename an existing destination into transaction-owned backup, rename the prepared
root into place, commit the journal, then reclaim the backup. If replacement
fails or is interrupted before commit, recover the previous root (or its absence).
The two renames are not one atomic operation; jobs need private destinations.

Do not calculate or verify file-content checksums during save or restore. Keep
bounded metadata validation, manifest checksums, file types, sizes, no-follow
handling and source-change checks. Same-size payload corruption is not detected.
Incomplete copies and detected structural damage are not usable hits.

## 5. Saving, failure, and concurrency

After a successful job, save each path under the primary `key`, even if it was
an exact hit during restoration. Restoring from a fallback does not authorize
mutating that fallback entry when it has a different key.

Do not publish changes after a failed or cancelled job. If some requested paths
exist at save time, save the available data. If no eligible files exist, warn and
skip the save rather than replacing an existing entry with an empty result.

Jobs use independent writable copies and must not wait for another job's build
to finish. Concurrent saves to the same repository/key/path do not combine their
contents: the last completed publication becomes the current cache. This order
is publication completion, not job start time.

Different repository/key/path entries can copy data concurrently. Multiple
readers of one entry may overlap; publication and deletion exclude readers and
other writers for that entry. Brief global metadata coordination is allowed for
catalog consistency and aggregate admission, without holding it during payload
copies or recursive deletion. Jobs must provide private destination paths.

Include the Linux lock executable with the action so consumers need no external
`flock` command, compiler, or package installation. The persistent volume mount
remains an operator prerequisite.

Build replacement data separately and publish a completed entry using coordinated
filesystem operations. Readers and cleanup must never observe a half-written
entry or lose data they are actively reading. Coordinate storage admission across
different keys too; a key-local lock alone cannot protect a global size budget.

Before publication, failures must preserve the previously committed entry.
Crashes or cancellation may leave temporary files, but they must not turn those
files into hits. Define abandoned-staging cleanup and lock recovery without
guessing liveness solely from elapsed time.

There is no all-path transaction requirement: independent path units may be
published at different times. Transaction and publication details must still be
documented before implementation claims are made.

## 6. Path and metadata handling

Validate input paths and their actual resolved destinations before copying or
deleting. Reject filesystem root, the entire runner home, and any cache target
equal to, containing, or contained by `volume-path`. Detect aliases via `~`, `..`,
and symlinks. Validate a usable volume root separately; a broad volume root must
not become authorization for broad cleanup.

Validate glob matches as well as explicit inputs. Recursive traversal must not
silently cross an unvalidated symlink into unrelated data. During restoration,
existing destination symlinks must not redirect writes beyond allowed paths.
Define behavior for file/directory/link type collisions in the implementation
design; whole-root replacement must never follow a destination link into its target.

Preserve:

- File and directory modification times where supported.
- Read, write, and execute permission bits.
- Symbolic links as links, without recursively copying their targets.

Do not restore original UID/GID. Restored files belong to the executing runner
user. Operation must not require root or ownership-changing privileges. ACLs,
extended attributes, capabilities, special permission bits, hard-link topology,
and special files have no agreed preservation contract yet; do not silently
promise support for them.

## 7. Cleanup and capacity

When `auto-cleanup` is enabled, perform age-based cleanup during an action run.
By default, entries unused for 7 days since their last successful restore or
save are eligible for removal. A lookup alone must not count as a successful
restore. Protect active reads and publications regardless of retention age.

Retention cleanup only targets this action's managed subtree. Do not clean
`/cache/shared`, unrelated files, or job destinations. Whole-root restoration
separately replaces the selected job destination as described above. `auto-cleanup: false` disables automatic
cleanup. No run means no cleanup; there is no installed daemon or schedule.
Cleanup-only actions and Locron integration are deferred.

`max-cache-size` applies to the aggregate managed cache, not only one key or
repository. It is an admission budget, not a size-eviction policy:

- A save that would exceed the configured budget is rejected.
- Do not delete otherwise retained entries merely to make that save fit.
- Warn, preserve previous entries, and allow the job result to stand.
- Treat filesystem out-of-space failures the same way.

The budget is not a filesystem quota. Temporary copies, retained reader
generations, and concurrent staging can require extra physical headroom. Define
the precise accounted bytes, reservations, replacement arithmetic, and behavior
when jobs use conflicting budget/retention settings in the implementation design.

## 8. Error policy

| Condition                             | Behavior                                         |
| ------------------------------------- | ------------------------------------------------ |
| Missing required input or unsafe path | Fail the action.                                 |
| Cold miss or no existing destination  | Continue without cached data.                    |
| Unusable candidate                    | Warn, try remaining compatible candidates.       |
| No usable candidate                   | Continue without restored data.                  |
| Empty save selection                  | Warn, skip saving, preserve the old entry.       |
| Capacity or cache I/O failure         | Warn, preserve committed data, continue the job. |

Warnings should identify the operation and affected logical key/path without
dumping file contents, credentials, environment variables, or unbounded metadata.
An implementation bug or unsafe destination must not be mislabeled as a harmless
cache miss to bypass validation.

## 9. Explicit non-goals

- Shared cache management: tools point directly at operator-managed paths instead.
- Slot leasing for the whole lifetime of jobs.
- Separate restore, save, or cleanup actions.
- A network cache server, GitHub storage override, or remote cache fallback.
- Docker, Kubernetes, or privileged-host dependencies in the public contract.
- Automatic language setup or package-manager cache detection.
- Automatic branch isolation or a guarantee of cross-job filesystem isolation.
- Full option and behavior parity with `actions/cache`.

## 10. Engineering review points

Resolve these without changing the agreed behavior silently:

1. Language/runtime, packaging, version support, and reproducible distribution.
2. Logical path normalization, glob/exclusion grouping, overlaps, and per-path
   output aggregation when patterns match cached but currently absent entries.
3. Manifest schema, compatibility/version rules, index lookup, and corruption detection.
4. Locking, safe publication, active-reader protection, interrupted replacements,
   cancellation, and abandoned temporary-data recovery on supported filesystems.
5. Size parsing, accounting, concurrent reservations, and conflicting per-run settings.
6. Link/type-collision handling, permission edge cases, and unsupported filesystem objects.
7. Host mount permissions, supported filesystem guarantees, and trusted-job deployment policy.

The initial engineering choices for these areas are recorded in
[IMPLEMENTATION.md](IMPLEMENTATION.md). They remain review points for future
changes, not unspecified behavior to decide silently. The acceptance plan is in
[TESTING.md](TESTING.md); performance and live ARC deployment remain unqualified.

## References

These informed the design; they do not imply complete behavioral compatibility.

- [Official cache inputs and output](https://github.com/actions/cache/blob/3edfce9056124e459a23f683a21433670d47daca/action.yml)
- [Official cache matching and branch scope](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-key-matching)
- [Official cache archive creation and extraction](https://github.com/actions/toolkit/blob/7e25f67e8fd17369aa21e6e816ac99654106e0dc/packages/cache/src/internal/tar.ts)
- [Official path expansion](https://github.com/actions/toolkit/blob/7e25f67e8fd17369aa21e6e816ac99654106e0dc/packages/cache/src/internal/cacheUtils.ts)
- [Official glob options, including symlink traversal defaults](https://github.com/actions/toolkit/blob/7e25f67e8fd17369aa21e6e816ac99654106e0dc/packages/glob/src/internal-glob-options.ts)
