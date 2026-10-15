# Development

## Current state

An initial implementation exists. There is no tagged release; replace `@v1` in
examples with a reviewed commit SHA for evaluation. Live ARC adoption and
representative performance measurements remain separate tasks.

Read [SPEC.md](SPEC.md) for the agreed behavior and [TESTING.md](TESTING.md) for
acceptance scenarios. [AGENTS.md](../AGENTS.md) contains repository instructions
for agents. Product requirements belong in the specification, not only in
agent-specific guidance.

## Tooling and commands

Use Linux, Node 24, pnpm 11.25.0, and Go 1.27.2. Go is a contributor build
requirement; consumers use the included Linux x64/arm64 executables and need no
external `flock` command or compiler.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm exec prettier --check .
gofmt -l lock-helper
```

`pnpm check` runs typechecking and `pnpm test`; tests rebuild bundles first.
`pnpm build` first cross-compiles both static lock helpers, then bundles main/post
using esbuild. Commit all of `dist/`, including `dist/bin/manifest.json` and the Go
runtime license. The build pins Go, disables CGO, removes paths/build IDs, and
keeps build caches in `.cache/go-build` and `.cache/go-mod`. Tests use Node's test
runner plus tsx; fixtures live only in `.cache/tests`, and the pnpm store is local
to `.cache/pnpm-store`.

Use `pnpm exec prettier --write .` to format source/configuration/docs. Generated
bundles and lockfiles are excluded from formatting. Run `gofmt -w lock-helper` when
changing Go source. The CI workflow verifies reproducible distributables, local
acceptance tests, and real GitHub post-job lifecycle behavior on native x64 and
arm64 Linux runners using a test-only post observer. A standalone test runs with
an empty command search path to check that consumers need no host lock utility.
The expected-failure probe is a separate
workflow, checked by a gate so observer errors cannot pass as expected failures.
Run that probe on a separate diagnostic commit/branch (or manually after merging
the workflow); intentional failure checks must not be attached to the PR head.
The diagnostic commit can have the exact same tree as the reviewed commit.

The design for the initial implementation is in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Suggested implementation sequence

This is a work plan, not a choice of language or lock implementation.

1. Write a bounded implementation design for the engineering decisions in the
   specification: path identity, glob behavior, storage schema, publication,
   locking, accounting, and interrupted-operation recovery.
2. Establish tooling and the single combined action entry point. Validate inputs
   and make main/post state handoff explicit. Record supported runner versions.
3. Implement namespaced metadata and per-path matching using synthetic cache
   fixtures. Handle fresh workspaces and fallback selection before optimizing I/O.
4. Implement uncompressed staging, merge restoration, successful-job updates,
   and preservation of times, permissions, and links.
5. Add concurrency control, publication recovery, age-based cleanup, and size
   admission checks together with multi-process acceptance tests.
6. Package reproducibly, test the real GitHub main/post lifecycle, then validate
   the generic runner and the initial ARC integration independently.
7. Measure cold/warm behavior against no cache and local archive-based caching.
   Document limits before tagging a release or adopting it in live workflows.

Keep the action generic. Integration examples may refer to ARC/K3s, but the cache
engine must not require cluster APIs or manage Kubernetes volumes.

## Engineering constraints

- Avoid shell interpolation of workflow-controlled text. Use filesystem APIs or
  subprocess argument arrays with unambiguous paths and option boundaries.
- Check paths before and during relevant filesystem operations. A preflight
  string check alone does not handle symlink redirection or concurrent mutation.
- Keep immutable published generations or another proven safe reader strategy;
  do not assume a rename alone makes recursive merges, reclamation, or all
  filesystem types safe. The particular mechanism remains a design choice.
- Never write new entry contents directly over a committed entry before success.
- Do not hold a cache lock across the repository's build/test lifetime.
- Do not use writable hard links into the committed cache as private copies.
  Shared writable inodes would violate job/cache independence.
- Preserve mtime and ordinary permission bits without requiring privileged chown.
- Define supported filesystem semantics before claiming shared/network-storage support.
- Include bounded metadata, format compatibility checks, and recoverable staging
  in the design. Directory names are not an authorization boundary.

## Documentation maintenance

Keep README examples and input/output tables consistent with the specification.
Update the status only when implementation and corresponding checks exist.
Record intentional differences from official GitHub cache behavior explicitly.
Do not mark acceptance scenarios passed based only on a design or source review.

For documentation-only work, use the current checkout's available tools to check
relative links, code fences, option names, whitespace, and the actual Git diff.
Use the commands above for implementation changes. A source check, local test,
real GitHub lifecycle run, and live ARC deployment are distinct evidence.

Do not add a release tag, change repository visibility, select a license, install
software, modify live CI workflows, or create a schedule as a side effect of
documentation setup. Those are separate changes with their own task scope.
