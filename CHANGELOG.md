# Changelog

## v1.0.1 — 2026-10-15

- License the project under MIT and retain bundled third-party notices.
- Prepare the Actions Volume Cache Marketplace metadata and repository identity.
- Improve the README, contribution guide, security policy, and issue templates.

The cache engine, inputs, output, storage format, and committed executables are
unchanged from v1.0.0.

## v1.0.0 — 2026-10-15

First versioned GitHub Actions release.

- Restore uncompressed local-volume caches into private job destinations and
  update the primary key after successful jobs, including exact hits.
- Match entries by repository, key, and logical path with ordered fallback keys.
- Support multiline paths, globs/exclusions, merge restoration, preserved ordinary
  permissions/times, and symlinks without following their targets.
- Coordinate concurrent readers, publication, cleanup, and aggregate size
  admission with scoped kernel locks and kill-safe operation leases.
- Include static Linux x64/arm64 lock helpers; consumers need no external `flock`
  or Go installation.
- Provide optional age cleanup and a committed-payload admission budget.
- Include runner setup, usage/troubleshooting guides, and npm/pnpm/Rust templates.

The release uses storage format v2. Legacy v1 storage remains untouched and is
outside v2 restore, cleanup, and accounting. Linux x64/arm64 CI covers functional
behavior and GitHub post-job saving; live ARC deployment and representative
performance measurements remain separate qualification work.
