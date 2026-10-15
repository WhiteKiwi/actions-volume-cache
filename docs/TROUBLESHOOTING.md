# Troubleshooting

Start with the action's restore log and its **post-job** save log. Confirm the
runner prerequisites in [runner setup](RUNNERS.md), then locate the symptom below.
Expected cold misses and ordinary cache warnings do not fail the build.

| Symptom                                                     | Check                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every run is cold                                           | The same persistent backing data must survive runner replacement. Check repository ID, key, logical path, and runner placement; matching `/cache` strings on different hosts do not share data.              |
| First run is cold                                           | Expected. Confirm the successful job saved during its post step, then run a fresh job against the same backing data. GitHub-service and legacy v1 caches are not imported.                                   |
| `cache-hit` is `'false'`                                    | Some data restored, but a path was missing or used a fallback. Inspect each restored path and key; adding a new path can change the aggregate output.                                                        |
| Output behaves like a truthy Boolean                        | Outputs are strings. Compare explicitly with `'true'`; the string `'false'` is still nonempty.                                                                                                               |
| New key is never found                                      | Check lockfile location and checkout order, tool/architecture prefixes, branch components, and fallback order. The primary key is exact-only.                                                                |
| No save appears                                             | Check whether the overall job failed/cancelled, whether eligible files exist at job end, and whether the save post step ran. There is no separate save step to invoke.                                       |
| `No eligible data to save` / `No cache entries saved`       | Confirm the tool actually writes to the configured paths and exclusions leave data. An empty save preserves the previous entry.                                                                              |
| `volume-path must use its canonical filesystem path`        | Use the real absolute mount path reported by `readlink -f`, not a symlink alias.                                                                                                                             |
| `Unsafe cache path` / `Unsafe directory ancestor`           | Check `/`, the entire home, volume overlap, and directory symlinks below workspace/home. Select the actual private cache directory.                                                                          |
| Permission or unavailable-volume warning                    | Check inside the action's execution environment as the runner UID. The mount must exist and allow traversal/read/write; UID changes after image replacement can break access.                                |
| `Cannot safely account a cache with corrupt entry metadata` | Size admission cannot trust corrupted pointers. The previous entries are preserved. Investigate the named entry using the implementation layout; do not edit live metadata or lock files to force admission. |
| `Cache save exceeds max-cache-size`                         | The configured aggregate budget would be exceeded. Keep a consistent policy across jobs; retained entries are not evicted just to fit the save.                                                              |
| Filesystem out of space                                     | Check physical free space and temporary-copy headroom as well as committed bytes. The configured budget does not count staging, metadata, garbage, legacy v1, or shared tool caches.                         |
| `Timed out waiting for cache lock`                          | Lock waits are bounded to 300 seconds. Check slow or active operations for that entry/workspace and filesystem health. Unrelated entries can still copy concurrently.                                        |
| Checksum or invalid-metadata warning                        | The candidate is unusable; remaining candidates may be tried. Report repeat failures with sanitized metadata paths and action SHA.                                                                           |
| Restore journal/recovery error                              | Treat the failed action as an incomplete workspace operation. Preserve logs and inspect the affected private workspace before reusing it; the action fails instead of accepting a partial restore.           |
| `Exec format error` / unsupported architecture              | Use Linux x64 or arm64 and the complete action distributable from the selected version/ref. Other architectures/platforms are outside the current support boundary.                                          |
| Native helper cannot execute                                | Confirm executable permissions and that the action checkout is on an executable filesystem. Installing host `flock` or Go is not part of consumer setup.                                                     |

## Safe diagnosis

Keep existing entry/workspace lock files in place. Unlinking a live lock can
create a second inode and break coordination between processes. Kernel locks are
released when their owning descriptors close; stale-lock deletion is not needed.
Enabled cleanup reclaims abandoned operation data while skipping active owners.

Corrupt committed pointers and their generations are preserved because cleanup
cannot safely identify the referenced generation. Known UUID-named abandoned
pointer-write temporary files can still be cleaned. Unknown filenames are not a
reason to delete an entry or broaden cleanup scope.

## Reporting a problem

[Open an issue](https://github.com/WhiteKiwi/actions-volume-cache/issues/new) with:

- The action version/ref, resolved commit SHA if available, runner OS/architecture,
  and relevant tool versions.
- Sanitized `with` values and runner-visible volume/destination paths.
- Whether it occurs during restore, the build, or the action's post-job save.
- Relevant warnings and whether fresh jobs reuse the same physical volume.
- A minimal reproduction using synthetic data, if possible.

Do not attach secrets, environment dumps, credential files, cached project
contents, or a complete cache volume. [Usage](USAGE.md) and the
[implementation design](IMPLEMENTATION.md) describe matching and storage details.
