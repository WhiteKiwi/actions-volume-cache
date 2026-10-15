# Acceptance and verification plan

Status: local acceptance tests and real GitHub lifecycle CI are implemented.
Local `pnpm check` has passed functional, process-concurrency, SIGKILL/recovery,
and standalone bundled-action tests on Linux with Node 24. GitHub CI evidence
must be checked on the reviewed commit before claiming the real lifecycle passed.
The tables below remain the acceptance plan, not a blanket claim that every
filesystem, cancellation mode, or failure has been reproduced.

Run `pnpm check` and `pnpm exec prettier --check .`. Test files are grouped into
functional cache cases, input parsing, multi-process concurrency, failure/recovery,
and distributable main/post tests. ENOSPC behavior is fault-injected; tests do not
fill a real disk. Process-death tests do send SIGKILL to synthetic child workers.

Use synthetic data in disposable directories. A local filesystem experiment
is not evidence that the complete action works. Test the main/post-job lifecycle
on GitHub before claiming successful-job or cancellation behavior is verified.

## Functional scenarios

| Area               | Required evidence                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required inputs    | Missing/empty `path`, `key`, or `volume-path` fails clearly; invalid option values follow the documented parser contract.                        |
| First run          | Missing destination and no cache allow the build to run; a successful job creates entries.                                                       |
| Exact hit          | Restore correct contents, report `'true'`, then save updated contents under the same key.                                                        |
| Ordered fallbacks  | Respect candidate order, exact-before-prefix within a candidate, and latest successful save for prefix matches.                                  |
| Independent paths  | Reuse one path when another is added; permit different matching keys per path; never bundle all paths into one invalidation hash.                |
| Output aggregation | All primary hits yield `'true'`; partial/fallback restoration yields `'false'`; no restored units yields `''`.                                   |
| Repository scope   | Same key/path in different repository namespaces cannot match through the action.                                                                |
| Branch scope       | Same repository/key/path reuses data across branches; explicit branch keys can separate it.                                                      |
| Glob paths         | Match files/directories, nested globs, exclusions, overlap cases, and saved paths absent from a fresh destination.                               |
| Merge restore      | Cache overwrites ordinary-file collisions, adds cached entries, preserves destination-only and excluded files.                                   |
| Fallback save      | Read an older key and publish the primary key without modifying the different fallback key.                                                      |
| Missing save paths | Save available paths; if no eligible files exist, warn and leave existing cache entries intact.                                                  |
| Metadata           | Preserve content, mtime, and ordinary read/write/execute bits; use current runner ownership.                                                     |
| Links              | Preserve internal and external symbolic links as links without recursively copying their targets; handle broken links and cycles per the design. |

## Failure, safety, and concurrency scenarios

| Area                       | Required evidence                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsafe paths               | Reject root/home and parent/child/equal volume overlaps after normalization, globbing, and relevant symlink resolution.                            |
| Destination redirection    | Existing symlinks and file/directory type collisions cannot redirect restoration outside allowed destinations.                                     |
| Malformed metadata         | Bounded handling; no arbitrary path writes/deletions or unbounded reads; try remaining candidates where appropriate.                               |
| Restore interruption       | Incomplete copies are not hits; demonstrate recovery for a failure during destination merge.                                                       |
| Save interruption          | A killed/crashed writer cannot corrupt a committed cache; abandoned staging stays invisible to readers.                                            |
| Failed/cancelled job       | No updated entry is published; previous committed entries remain available.                                                                        |
| Concurrent same-key writes | Independent jobs progress; complete publications are serialized/coordinated; the last publication wins per path without mixed entry contents.      |
| Active reader and writer   | Readers receive a complete generation while another process publishes; old data remains until the reader is safe.                                  |
| Cleanup race               | Retention never removes an entry/generation/staging operation actively in use.                                                                     |
| Disabled cleanup           | `auto-cleanup: false` performs no automatic retention cleanup.                                                                                     |
| Retention                  | Last successful restore/save controls age; lookup alone does not refresh retention; threshold boundaries are deterministic.                        |
| Cleanup scope              | Only action-owned managed data can be deleted; sibling/shared/unrelated data remains unchanged.                                                    |
| Size admission             | Over-budget updates fail without size-based eviction; old entries remain; concurrent distinct-key writers cannot overcommit the accounting budget. |
| Physical out of space      | Failure warns, preserves committed entries, and leaves a recoverable state.                                                                        |
| Conflicting settings       | Concurrent jobs with different size/retention settings follow the documented policy rather than silently racing.                                   |
| Repeated updates           | Old generations and abandoned files do not leak indefinitely; reclamation respects active readers.                                                 |

Use separate processes for concurrency and cancellation tests. Same-process mocks
alone cannot establish filesystem locking and process-death behavior. Inject
failures at copy, validation, publication, and reclamation boundaries.

## Integration gates

- Establish the supported generic Linux runner/runtime/filesystem combinations.
- Run an actual job using the packaged action: cold miss, warm exact hit, fallback,
  successful update, failed build, cancelled build, and concurrent updates.
- Verify checkout/tool setup interaction, writable mount permissions, and cleanup
  after disposable runner replacement.
- Separately verify the first ARC/K3s target at the intended 1 CPU / 2 GB runner
  resources; no Docker commands or privileged host access should be required.
- Do not confuse source tests, local simulations, GitHub job runs, and live
  deployment. Report which evidence exists for each claim.

## Performance evidence

Compare equivalent representative jobs with no cache, local archive-based cache,
and this implementation. Hold runner resources, filesystem, workload, and input
versions constant. Record cold and warm runs, build time, restore time, save time,
CPU use, bytes copied, logical cache size, and peak physical disk usage including
staging/old generations. Include parallel jobs and repeat measurements.

Do not set a speedup promise before measuring. Reflink or other copy optimizations
must preserve private-write behavior and have a correct fallback on supported
filesystems if introduced later.
