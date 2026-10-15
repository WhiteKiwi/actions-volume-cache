# Repository instructions

## Project status and scope

This repository contains an initial TypeScript/Node 24 implementation, committed
JavaScript distributables, tests, and CI. Public examples use semantic version
tags; follow `docs/RELEASING.md` when publishing or moving a major-version alias.
Read `README.md`, `docs/SPEC.md`, `docs/IMPLEMENTATION.md`, `docs/DEVELOPMENT.md`,
and `docs/TESTING.md` before changing behavior.

`docs/SPEC.md` records the agreed product contract. Distinguish confirmed
requirements from its open implementation decisions. Do not turn an open item
into an undocumented assumption or claim unimplemented behavior works.

## Preserve the agreed contract

- Provide one combined restore/post-job-save action and only the `cache-hit` output.
- Keep the core inputs `path`, `key`, `restore-keys`, and `volume-path`.
- Keep cleanup optional, enabled by default, with configurable age retention.
- Use uncompressed job-local copies; publish updates only after successful jobs.
- Update exact-key hits and resolve concurrent publications per key/path pair.
- Preserve repository namespacing, path validation, metadata, and symlink handling.
- Treat managed-cache limits as admission checks, not a reason to evict live entries.
- Keep `/cache/shared` and unrelated files outside managed cleanup.

Do not reintroduce shared-cache inputs, cache-slot leasing throughout a job,
separate restore/save/cleanup actions, a cache server, cloud storage, or an ARC-only
dependency without an explicit scope change.

## Work safely

- Keep filesystem experiments in task-owned temporary directories with synthetic data.
- Never exercise cleanup against a real cache volume during routine tests.
- Do not read or copy host credentials, SSH material, or real repository cache contents into fixtures.
- Validate filesystem boundaries before recursive copy, replacement, or deletion.
- Use argument arrays for subprocesses; do not interpolate keys or paths into shell commands.
- Preserve unrelated work and avoid global Git or host configuration changes.
- Do not install or reconfigure live runners, Kubernetes resources, or schedules as part of a code or documentation task.

## Change and verify

Keep documentation in English to match the repository. Respond to users in their
language. Explain behavior changes and limitations directly.

For documentation-only changes, check relative links, examples, consistency,
whitespace, and Git status. Do not claim runtime tests passed when no runtime exists.

For implementation changes, use the meaningful scenarios in `docs/TESTING.md`.
Use Node 24, pnpm 11.25.0, and Go 1.27.2. Run `pnpm install --frozen-lockfile`, `pnpm check`,
and `pnpm exec prettier --check .`. `pnpm check` includes typechecking, bundling,
and tests. Commit all of `dist/`, including both Linux lock helpers, their checksum
manifest, and the Go runtime license; CI must reproduce them without a diff.
Run `gofmt` on `lock-helper/`. Build with `pnpm build` when only regenerating
distributables. Consumers need neither Go nor an external `flock` command.

The action under `tests/fixtures/post-observer` is a private CI fixture, not a
second supported public action. Do not confuse its always-running post observer
with the product's successful-job-only save hook.

Report changed files, actual verification, and remaining limitations. Never report
an example version, acceptance target, speed claim, or deployment as verified without evidence.
