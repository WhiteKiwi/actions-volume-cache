# Usage guide

Start with the [complete npm workflow](../README.md#quick-start). Copyable
templates are available for [npm](../examples/npm.yml), [pnpm](../examples/pnpm.yml),
and [Rust / Cargo](../examples/rust.yml). Supply the persistent mount described
in [runner setup](RUNNERS.md), and adapt runner selection and project commands.

The examples use `WhiteKiwi/actions-volume-cache@v1`. Read
[versions and upgrades](#versions-and-upgrades) when selecting a fixed release
or a full commit SHA instead.

## Versions and upgrades

| Reference                               | Behavior                                                             |
| --------------------------------------- | -------------------------------------------------------------------- |
| `WhiteKiwi/actions-volume-cache@v1`     | Follow approved compatible 1.x releases through the moving `v1` tag. |
| `WhiteKiwi/actions-volume-cache@v1.0.0` | Select the first release through a fixed version tag.                |
| A full 40-character commit SHA          | Select one exact commit independently of tag movement.               |

`v1` and `v1.0.0` are Git tags under `refs/tags/`, not branches under
`refs/heads/`. Only the major alias moves during compatible releases. Exact
release tags identify one release and are never reused or moved. Main can
contain development commits that have not been released to `v1`.

For a fixed version, change the action step to:

```yaml
uses: WhiteKiwi/actions-volume-cache@v1.0.0
```

For full SHA pinning, find the commit for the chosen version in its
[release](https://github.com/WhiteKiwi/actions-volume-cache/releases), verify it
belongs to this repository, and use that full commit SHA after `@`. For example,
after fetching this repository's tags, `git rev-parse 'v1.0.0^{commit}'` prints the
release commit even when the version tag is annotated. A major tag can move;
a commit SHA keeps selecting the same code. Third-party actions in the templates
also use readable major tags and can be pinned independently if needed.

Review the [changelog](../CHANGELOG.md), tool compatibility, and storage notes
before upgrading. Breaking contract changes require a new major series such as
`v2`. Storage format v2 is a separate concept from the action release `v1`.

This follows GitHub's guidance for
[semantic action releases](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions)
and [version aliases](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases).

## Workflow order

Use checkout, configure the language/tool version, restore the cache, and then
install/build/test. GitHub calls the save post step only when the job succeeds.
There is no separate save action or workflow-end step to add.

Keep the same workspace and repository context through main/post. A valid path
that does not exist on the first run is a normal miss; the build can create it.
If no eligible data exists at save time, the action warns and preserves any
previous entry. An exact hit still gets saved after a successful job.

Do not combine another cache action with this action for the same destination.
For `setup-node`, disable its package-manager cache as shown in the templates.

## Keys and compatibility

Choose keys from the properties that make the cached data compatible:

- Runner OS and architecture for platform-dependent data.
- Relevant toolchain version and build options.
- Dependency lockfile hash.
- An optional project-controlled prefix to start a fresh cache generation.

The templates include OS/architecture and tool versions. If you change pnpm's
major version, also change its key prefix. The Rust template reads the selected
compiler version; adapt it for a pinned toolchain, target triple, or build flags.
Lockfile hashing happens after checkout. Check that the named lockfile exists:
an unmatched `hashFiles` pattern produces no useful dependency fingerprint.

Repository ID provides automatic repository namespacing. Branch isolation is
explicit: add `${{ github.ref_name }}` to keys and fallback prefixes if required.
There is no automatic default-branch search. Different workflows in the same
repository can intentionally share a compatible key and logical path.

Keys and fallback keys must contain 1–512 characters without control characters.
Do not include credentials or other sensitive values in keys.

## Matching and restore keys

Each logical path is matched independently:

1. Look for the exact primary `key`.
2. Try each `restore-keys` line in order.
3. For each fallback, prefer an exact key. Otherwise choose the most recently
   published compatible entry whose key starts with that fallback.
4. Skip unusable candidates and try the remaining candidates.

The primary key does not automatically become a prefix search. Broad fallback
prefixes can restore older dependencies; the package manager or build must still
validate and update its data.

For example, with primary key `Linux-X64-node24-npm-lock-b`:

```yaml
restore-keys: |
  Linux-X64-node24-npm-lock-a
  Linux-X64-node24-npm-
```

An exact `lock-b` wins first. Otherwise the first fallback is tried before the
broader second fallback. A successful job saves the updated data under `lock-b`,
leaving an entry restored from `lock-a` unchanged. Prefix recency uses publication
time, not last access time.

## Paths and exclusions

`path` accepts files/directories, multiline values, workspace-relative or absolute
paths, `~/` home expansion, globs such as `*`/`**`, and `!` exclusions:

```yaml
path: |
  frontend/.next/cache
  backend/target
  packages/*/.cache
  !**/target/tmp/**
```

Relative paths are relative to `GITHUB_WORKSPACE`, even if a run step sets a
different working directory. Use the matching workspace-relative path in that
case. Workspace/home-relative identities survive disposable runner directory
names; unrelated absolute paths retain their absolute identity.

Changing one path does not invalidate another path's cache entry. Adding a
missing path can make the aggregate `cache-hit` report `'false'` while existing
paths still restore successfully. Globs can discover saved paths missing from
a fresh workspace. Overlapping roots are handled without treating every nested
file as an independent cache.

Restoration merges into the destination. Cached files replace ordinary-file
collisions, destination-only files remain, and exclusions stay untouched. File,
directory, or link type collisions cause that restore to fail safely rather than
deleting unrelated destination trees. Symlinks are preserved as links and are
not followed. Original UID/GID, ACLs, extended attributes, capabilities, special
permission bits, and hard-link topology are not restored.

Do not cache `/`, the entire home, or a target that overlaps `volume-path` in
either direction. Directory symlinks below trusted workspace/home roots cannot
redirect cache traversal or writes. Use private job destinations, especially
when selecting paths under a host-shared `HOME`.

## Reading cache-hit

The only output is a string: `'true'` for every unit restored from the primary
key, `'false'` for partial/fallback restoration, or `''` for no restored data.
Report it without treating a nonempty string as a Boolean:

```yaml
- name: Report local cache result
  env:
    CACHE_HIT: ${{ steps.local-cache.outputs.cache-hit }}
  run: |
    printf 'Local cache hit: %s\n' "$CACHE_HIT"
```

Here `local-cache` must be the `id` of your action step. For an exact-hit condition,
use `if: steps.local-cache.outputs.cache-hit == 'true'`. Keep dependency validation
and tests in the workflow regardless of this output. An exact hit describes
restoration, not successful compilation or verified dependencies.

## Retention and capacity

Optional settings for the action's `with` mapping:

```yaml
auto-cleanup: true
cleanup-retention-days: 7
max-cache-size: 20GiB
```

Cleanup runs during action invocations, not on a timer. It uses last successful
restore/save time and skips active readers, writers, staging, and garbage owners.
A lookup alone does not extend retention. Busy data can be reclaimed by a later
run after its owner finishes or exits.

`auto-cleanup: false` disables age-based and abandoned-data cleanup. Replacement
housekeeping and removal of failed unpublished copies can still occur. No
cleanup-only action, background daemon, or schedule is installed.

`max-cache-size` applies to committed payloads across all repositories in the v2
subtree, accounting replacements by subtracting the old entry first. It rejects
an over-budget save with a warning while preserving committed entries. It does
not evict other retained entries to make space.

Use a positive integer byte count or an integer with `B`, `KB`, `MB`, `GB`, `TB`,
`KiB`, `MiB`, `GiB`, or `TiB`. Decimal sizes such as `1.5GiB` are invalid. Retention
must be a positive finite number of days. Configure the same budget and retention
policy across jobs sharing storage: settings are applied per invocation, and one
job does not inherit a stricter job's policy.

Leave physical headroom for staging, restore copies, detached garbage, metadata,
legacy v1 storage, and operator-managed shared caches. The admission budget is
not a filesystem quota or reservation.

## Shared tool caches

If a tool safely manages concurrent access itself, its cache may point directly
at an operator-managed path such as `/cache/shared/pnpm`. That avoids private-copy
restore/save for that tool. Confirm the tool's version-specific concurrency and
permissions behavior before choosing this arrangement.

There is no `shared-paths` input. Do not pass a shared path under `volume-path`
as this action's `path`; overlapping paths are rejected. `/cache/shared` and
unrelated data stay outside managed cleanup. The example workflows use private
workspace-local copies instead, including for pnpm.

## Moving from actions/cache or old storage

Keep the familiar `path`, `key`, and ordered `restore-keys`, add `volume-path`,
and use the versioned action reference. Use the combined action
before your build; remove a separate cache-save step for those same paths.
Review keys because branch scope, independent path matching, mutable exact keys,
capacity, and the available inputs differ from `actions/cache`.

Existing GitHub-hosted caches are not imported or used as fallback. Existing
`actions-volume-cache/v1` storage is also not read by v2 or cleaned by it. Expect
a cold first v2 run and budget for legacy data separately. Do not infer storage
format from an action version: the v1 release uses storage format v2.

See [troubleshooting](TROUBLESHOOTING.md) for misses, warnings, and missing saves.
