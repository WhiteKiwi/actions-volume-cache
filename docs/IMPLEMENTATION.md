# Initial implementation design

The implementation targets Node 24 JavaScript actions on Linux, with the
`flock` command from util-linux and a trusted local filesystem supporting flock
and atomic same-filesystem rename. NFS, SMB, distributed mounts, hostile processes
sharing a UID, and power-loss durability are outside this initial support claim.

## Storage and locking

Use `actions-volume-cache/v1/repos/<repository-id>/<sha256(key)>/<sha256(path)>`.
Each entry has an atomically replaced `current.json` and immutable UUID-named
generations containing a bounded manifest and a native payload. Manifests include
relative paths, file hashes, sizes, ordinary permission bits, times, and link
targets. Corrupt or incompatible entries are misses, not executable metadata.

A permanent volume-wide flock serializes cache filesystem operations, including
copies, publication, accounting, and cleanup. It does not serialize builds or
remain held between main and post. This deliberately favors simple correctness
over concurrent cache I/O in the first version. Lock contention waits up to 300
seconds, then becomes a cache warning. A future finer-grained implementation must
retain equivalent reader and admission guarantees.

The Node process opens the lock inode and passes a duplicate descriptor to
`flock`; the open file description remains locked until Node closes it or exits.
Never unlink a lock file during operation. All cooperating operations use the
same global lock, so interrupted staging and unreferenced generations can be
reclaimed safely under that lock. No PID or elapsed-time stale-lock guessing.

## Logical paths and matching

Normalize path identities into workspace-relative, home-relative, or absolute
names, in that priority. Absolute locations inside the current workspace/home
receive the same portable identity as relative/tilde inputs. A unit is an actual
matched file/directory root, not the whole multiline input. Collapse overlapping
roots so parent directories own their descendants. Exclusions filter both save
and restore traversal and do not create entries.

Discover units from current filesystem matches plus saved metadata, so globs can
find cache roots absent from a fresh workspace. Literal missing paths still count
as requested units for hit aggregation. A positive glob with no live or cached
matches prevents an all-exact hit. Never traverse directory symlinks during glob
discovery. Nested symlinks are preserved as leaves. Type collisions fail that
restore and roll back instead of deleting unrelated directories.

## Copies and restore transactions

File copies use no-follow file opens and private files; no writable hard links
point into committed entries. Hash files while copying and verify against the
manifest before applying a restore. Preserve links without traversing targets.
Bound manifests to 32 MiB and 100,000 nodes per unit. Refuse unsupported special
files rather than attempting FIFO/device copies. Preserve ordinary mode bits and
mtime, not ownership, ACLs, capabilities, set-ID bits, or hard-link topology.

Prepare restore data in a private directory beside the destination so rename
operations stay on one filesystem. Preflight all destination types and ancestors.
Journal intended replacements, back up overwritten leaves, merge prepared leaves,
then mark committed and reclaim backups. Recover an unfinished journal before
another restore to the same root. Normal exceptions roll back. A killed process
does not emit a hit; an interrupted workspace must not proceed as a successful
restore. No multi-file atomicity or recovery from disk/controller power loss is
claimed. Destination-only/excluded paths are never removed.

## Capacity and retention

Account committed file bytes plus symbolic-link target bytes across all repository
namespaces, excluding directories, metadata, staging, and superseded generations.
Replacement admission subtracts the previous entry before adding the new one.
The same lock covers size checks and publication across distinct keys. Staging
still needs additional physical headroom and may encounter ENOSPC.

Accept integer bytes or integer `B`, `KB`, `MB`, `GB`, `TB`, `KiB`, `MiB`, `GiB`,
`TiB` sizes; require a positive safe integer. Unset means no configured limit.
Retention is a finite positive number of days; zero/negative values are invalid.
Booleans accept only `true` or `false`. Keys are nonempty, at most 512 characters,
and cannot contain control characters.

Policies apply to each invocation under the lock; operators must configure
consistent retention and size budgets on a shared volume. A more permissive job
does not inherit a stricter job's admission budget, and shorter retention can
remove entries another workflow expected to retain. These are cleanup/admission
settings, not a persistent multi-tenant quota or access-control system.

Cleanup uses last successful restore/save time. It removes expired entries and,
when enabled, abandoned cache staging. Publication also reclaims its superseded
generation; that is replacement housekeeping, not retention eviction. Disabling
automatic cleanup prevents age-based cleanup; shared/unrelated data is never
eligible. No background process, cleanup action, or schedule is installed.
