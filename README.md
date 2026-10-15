# actions-local-cache

Reusable local filesystem caches for GitHub Actions self-hosted runners.

**Status: design stage.** This repository currently contains the project outline.
There is no executable action, released version, or validated cache implementation yet.

## Purpose

Keep useful cache data on a persistent local volume while runner instances and
job workspaces are replaced. Reuse files in place so large build caches can avoid
the archive creation, transfer, and extraction required by archive-based caches.

The initial integration target is Linux runners managed by Actions Runner
Controller (ARC). The surrounding CI platform provides a common 1 CPU / 2 GB
runner without Docker; repositories manage their own tools and workflows.

## Design goals

- Offer one general-purpose cache contract across repositories and languages.
- Use an operator-provided persistent cache volume.
- Separate cache namespaces by repository and compatible runtime generation.
- Coordinate concurrent jobs without forcing the entire repository to run serially.
- Reuse idle caches across jobs while keeping active writable caches out of cleanup.
- Keep job workspaces and temporary files disposable.
- Allow jobs to rebuild after a cache miss or discarded cache.

## Design decisions still open

- The action or helper interface, cache keys, and directory layout.
- Shared caches versus exclusive writable cache slots.
- Cache ownership and access boundaries for organization-wide runner pools.
- Lease acquisition, cancellation, crashes, and stale-state recovery.
- Capacity limits, retention, and pruning under concurrent jobs.
- Integration with ARC job hooks and runner lifecycle events.
- Implementation language, packaging, and supported tool versions.

Repository namespaces alone do not enforce filesystem access isolation. The
implementation must define that boundary before claiming cross-repository isolation.

## Acceptance targets

The implementation needs evidence for concurrent cache use, repeated warm jobs,
job failure and cancellation, interrupted writers, cleanup during active work,
and cache misses. Compare total job time, cache preparation time, and disk usage
with an uncached baseline and an archive-based cache on the same runner resources.

## References

- [ARC runner scale-set configuration](https://docs.github.com/en/actions/how-tos/manage-runners/use-actions-runner-controller/deploy-runner-scale-sets)
- [GitLab persistent per-concurrency build volumes](https://docs.gitlab.com/runner/executors/kubernetes/#persistent-per-concurrency-build-volumes)
- [Slot-warmed caching: an operational example](https://jeffverkoeyen.com/blog/2025/12/15/SlotWarmedCaching/)
- [runner-manager dependency-cache implementation](https://github.com/IvanMurzak/GitHub-Runner-Scaler-UI/blob/41b766291695e54a2820953a8e94aac29e009767/crates/platform/src/dependency_cache.rs)
