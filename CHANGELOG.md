# Changelog

## [1.0.3](https://github.com/WhiteKiwi/actions-volume-cache/compare/v1.0.2...v1.0.3) (2026-10-15)


### Bug Fixes

* **ci:** authorize verified release PR completion and recovery ([#11](https://github.com/WhiteKiwi/actions-volume-cache/issues/11)) ([673c07d](https://github.com/WhiteKiwi/actions-volume-cache/commit/673c07d6d13410e5f020b88178eef1a017e7f261))
* **ci:** pin release admission API and recovery controller ([#10](https://github.com/WhiteKiwi/actions-volume-cache/issues/10)) ([4b26521](https://github.com/WhiteKiwi/actions-volume-cache/commit/4b265217e8ca47343a941ec47aaeff22cd0b54d1))

## [1.0.2](https://github.com/WhiteKiwi/actions-volume-cache/compare/v1.0.1...v1.0.2) (2026-10-15)


### Bug Fixes

* **ci:** automate reviewed action releases ([#6](https://github.com/WhiteKiwi/actions-volume-cache/issues/6)) ([dba5d82](https://github.com/WhiteKiwi/actions-volume-cache/commit/dba5d820c39e9e1822bc9e0085386cc82c31cac0))
* **ci:** report dispatched release checks on the pull request ([#9](https://github.com/WhiteKiwi/actions-volume-cache/issues/9)) ([aafe0b4](https://github.com/WhiteKiwi/actions-volume-cache/commit/aafe0b4dc967ac5be03a954f649fc868f08991c0))
* **ci:** validate the generated release proposal branch ([#8](https://github.com/WhiteKiwi/actions-volume-cache/issues/8)) ([0f2fab8](https://github.com/WhiteKiwi/actions-volume-cache/commit/0f2fab87f760eff27e4896e0d23d323d3087f99b))

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
