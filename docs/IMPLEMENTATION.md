# Initial implementation design

The implementation targets Node 24 JavaScript actions on Linux x64 and arm64,
with bundled static Go lock helpers and a trusted local filesystem supporting
flock and atomic same-filesystem rename. NFS, SMB, distributed mounts, hostile processes
sharing a UID, and power-loss durability are outside this initial support claim.

## Storage and locking

Use `actions-volume-cache/v2/repos/<repository-id>/<sha256(key)>/<sha256(path)>`.
Each entry has an atomically replaced `current.json` and immutable UUID-named
generations containing a bounded manifest and a native payload. Manifests include
relative paths, file hashes, sizes, ordinary permission bits, times, and link
targets. Corrupt or incompatible entries are misses, not executable metadata.

Permanent entry locks live in `locks/entries/<sha256(repository/key-hash/path-hash)>.lock`.
Restore holds a shared entry lock while reading, preparing, and merging data.
Publication and entry cleanup hold the exclusive entry lock. Multiple readers
can overlap, and unrelated entries can copy data concurrently. After acquiring
the lock, a reader re-reads the current pointer because its catalog snapshot may
predate a replacement or cleanup. Never unlink entry lock files, including after
entry deletion; replacing the inode could split cooperating lock owners.

`metadata.lock` protects directory/catalog snapshots, timestamp writes, aggregate
size admission, and pointer publication. The lock order is entry then metadata;
catalog reads release metadata before acquiring an entry lock. Shared readers
serialize timestamp updates under metadata and re-read the pointer/time, so
delayed readers cannot overwrite newer metadata. Payload copies, manifest
construction, restore merging, and recursive deletion never hold metadata.
Metadata scans still grow with entry count; there is no constant-time index claim.

`locks/workspaces/<sha256(canonical-workspace)>.lock` serializes recovery and
overlapping action operations in the same workspace. Builds hold no cache or
workspace lock, and no lock spans main to post. Separate jobs must provide private
destination paths, including any home-directory paths. A workspace guard does
not isolate destinations deliberately shared by different workspaces or volumes.

Staging and detached garbage each have a temporary exclusive lease in
`locks/operations/<uuid>.lock`, outside the recursively deleted directory. The
owner retains it throughout copy/deletion. Creation, nonblocking cleanup claims,
and removal of lease files are coordinated under metadata. Remove a lease file
only after both its staging and garbage directories are absent. An external
lease avoids unlinking an active lock inode during recursive reclamation.
Cleanup never waits for an entry or operation lease: it skips busy data.

Node opens a no-follow regular lock file and passes its descriptor as FD 3 to the
bundled helper. The helper calls `flock(2)` on that inherited descriptor; it must
not independently reopen the file or explicitly unlock on success. The shared
open file description stays locked after the helper exits until Node closes its
descriptor or dies. Waits are bounded to 300 seconds, then become cache warnings.
An orphaned helper still waiting for a lock notices its original parent exited
and stops. There is no PID/age guessing to break locks or reclaim active data.

The helper uses the Go standard library only. `pnpm build` requires Go 1.27.2 and
reproducibly cross-compiles static Linux x64 and arm64 executables, commits their
SHA-256 manifest and Go runtime license, and bundles the JavaScript entry points.
The action selects its native executable by architecture. Consumers need no
external `flock`, Go, compiler, package installation, or elevated privileges.

The v2 subtree separates this lock protocol from old clients that only honor the
v1 global lock. V1 contents remain untouched and are cold misses for v2. They are
outside v2 cleanup and size accounting but still occupy physical disk. Existing
v1 clients can keep using their separate subtree; no automatic migration occurs.

## Logical paths and matching

Normalize path identities into workspace-relative, home-relative, or absolute
names, in that priority. Absolute locations inside the current workspace/home
receive the same portable identity as relative/tilde inputs. Canonicalize the
runner-provided workspace/home roots, including aliases in absolute inputs,
before computing identities. Do not resolve directory links below those roots;
the no-follow checks still protect cache traversal and destination writes.
Main/post context checks compare the resolved workspace.

A unit is an actual matched file/directory root, not the whole multiline input.
Collapse overlapping roots when saving. When restoring, attempt parents first
and skip descendants only after their parent successfully restores. A missing
or corrupt parent cannot hide usable descendant entries; partial restoration
reports `'false'`. Exclusions filter both save and restore traversal and do not
create entries.

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
Write a preparing journal before copying, journal intended replacements, back up
overwritten leaves, merge prepared leaves, then mark committed and reclaim
backups. Before selecting restore/save units, scan each positive pattern's
literal search tree for unfinished journals, without following directory links
or entering transaction payloads. Inspect the search root's parent for its own
journal as well. This adds a directory walk and recovers temporarily absent
leaves or nested transactions even after the source cache is gone. Validate the
journal's destination, parent, filename hash, and node paths before recovery.
Unknown directories without a journal are preserved during discovery.

Normal exceptions roll back. Journal inspection/recovery failures fail the action
because a previous merge may be incomplete. A killed process does not emit a hit;
an interrupted workspace must not proceed as a successful restore. No multi-file
atomicity or recovery from disk/controller power loss is claimed. Destination-only
and excluded paths are never removed by a new restore; recovery completes the
previous transaction before applying current exclusions.

## Capacity and retention

Account committed file bytes plus symbolic-link target bytes across all repository
namespaces in v2, excluding directories, metadata, staging, detached garbage,
superseded generations, and legacy v1 data.
Replacement admission subtracts the previous entry before adding the new one.
The metadata lock covers size checks and pointer publication across distinct
keys. Concurrent staging, detached garbage, and legacy data still need additional
physical headroom and may encounter ENOSPC. The budget is not a disk quota.

Accept integer bytes or integer `B`, `KB`, `MB`, `GB`, `TB`, `KiB`, `MiB`, `GiB`,
`TiB` sizes; require a positive safe integer. Unset means no configured limit.
Retention is a finite positive number of days; zero/negative values are invalid.
Booleans accept only `true` or `false`. Keys are nonempty, at most 512 characters,
and cannot contain control characters.

Policies apply to each invocation; operators must configure
consistent retention and size budgets on a shared volume. A more permissive job
does not inherit a stricter job's admission budget, and shorter retention can
remove entries another workflow expected to retain. These are cleanup/admission
settings, not a persistent multi-tenant quota or access-control system.

Cleanup uses last successful restore/save time. Under an exclusive entry lock
and metadata, it detaches eligible data by rename into owned garbage; it releases
both locks before recursively deleting that data. It removes expired entries and,
when enabled, abandoned cache staging, unreferenced generations, entries without
a committed pointer, and interrupted pointer-write temporary files. Preserve
corrupt pointers whose referenced generation cannot be determined safely, along
with all their generations. UUID-named temporary pointer writes are still
reclaimed in those entries; their ownership does not depend on a valid pointer.
Publication failures quarantine and attempt to remove the unpublished generation
immediately, even when automatic cleanup is disabled. If that removal fails or
the process is killed, a later enabled cleanup claims its abandoned operation
lease and reclaims it. Publication also detaches and reclaims its superseded
generation after releasing entry/metadata locks; that is replacement housekeeping, not
retention eviction. Disabling automatic cleanup prevents age-based and abandoned
data cleanup; shared/unrelated data is never eligible. No background process,
cleanup action, or schedule is installed.
