# Runner setup

The runner operator supplies persistent storage once. Workflow authors then use
the action with the runner-visible mount path. Start with the
[README quick start](../README.md#quick-start) after completing this setup.

## Supported environment

- Linux x64 or arm64 and an Actions runner supporting `node24`.
- A trusted local filesystem with flock and atomic same-filesystem rename.
- A persistent cache mount separate from the disposable workspace.
- Private job destinations, including paths under `HOME` if used.

The action includes static native lock helpers. Consumers need no external
`flock`, Go, compiler, Docker, custom token, or cache service. Build tools used by
the repository are separate workflow prerequisites. NFS/SMB, hostile jobs sharing
write access, and power-loss durability are outside the current support claim.

## Persistent storage

Mount local storage at a stable path such as `/cache`. `volume-path` is the path
**inside the runner's execution environment**, which may differ from the host path.
The directory must already exist and be writable when the action starts.

For containerized or disposable runners, keep the backing storage when replacing
the runner and mount it into every runner that should reuse it. A directory only
inside an ephemeral container is lost with that container. A job container must
also see the mount if the action executes inside it.

Two hosts both using `/cache` do not automatically share data. Independent local
disks have independent caches and can each start cold. This action does not
distribute or synchronize caches across nodes.

Use the canonical absolute mount path, not a symlink alias. Keep the volume
outside cache destinations; a destination cannot equal, contain, or sit inside
`volume-path`. The filesystem root and the entire home are invalid volume roots.

## Permissions

Use a consistent numeric runner UID for jobs sharing entries. Action-owned
directories and lock files use restrictive permissions; sharing a group alone
does not make entries created by different UIDs mutually writable.

Have the operator set ownership on the dedicated mount for that runner UID.
The action does not change host ownership or need sudo during jobs. After
replacing a container image, check that its runner UID still matches the volume.

Run these read-only checks as the actual runner user, inside the same execution
environment as the action:

```sh
id
test -d /cache
test -r /cache && test -w /cache && test -x /cache
readlink -f /cache
df -h /cache
```

These checks confirm basic access and location; they do not prove persistence or
every filesystem guarantee. Run the first-use procedure below to verify reuse.

## Runner selection and ARC

On conventional self-hosted runners, select your registered labels, for example:

```yaml
runs-on: [self-hosted, linux]
```

On ARC, use the runner scale-set name configured by your operator:

```yaml
runs-on: your-linux-scale-set
```

That name is a placeholder. The action does not install ARC, provision volumes,
change scale sets, or impose CPU/memory limits. With multiple Kubernetes nodes,
plan local-volume placement so jobs that should reuse a cache reach the same
backing data. ARC/K3s deployment remains separately qualified from generic action CI.

## Trust and job isolation

Repository IDs namespace entries but do not enforce filesystem access control.
Any job with direct write access to the entire mount can modify data there.
Use this shared mount only for jobs you trust; keep secrets, credential files,
and authentication configuration outside cache paths.

Builds must use private destinations. The action locks cache operations, not the
whole build. Different jobs writing the same host `HOME` cache directory would
still share that destination; choose workspace-local cache paths as in the
[example workflows](../README.md#quick-start).

On one cache volume, action operations using the same canonical workspace path
string share a workspace guard. Identical paths inside separate containers can
therefore serialize restore/save operations even when their destinations are on
different filesystems. Unique workspace paths allow independent cache operations
to overlap. The guard is released before the build runs.

## First-use verification

1. Run a trusted project's workflow against the persistent mount. A cold miss
   produces an empty `cache-hit`; confirm its successful job logs a saved entry
   in the action's post step.
2. Start a fresh job against the same backing data with the same repository,
   key, and logical path. Confirm a restore and an exact hit when every requested
   unit is present.
3. Replace the disposable runner, if used, and repeat the second run. A warm hit
   after replacement confirms the intended backing storage persists.
4. Measure restore/save time and peak disk use on that workload before setting
   performance expectations. Include concurrent jobs in your measurements.

Native x64/arm64 CI covers functional behavior and GitHub post-job saving.
The procedures above validate your mount and project integration; they have not
been executed against every example project or a live ARC deployment.
