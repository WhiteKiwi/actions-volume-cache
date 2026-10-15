# Contributing

Focused bug fixes, documentation improvements, and reproducible reports are
welcome. For a new feature or contract change, open an issue to discuss the
intended behavior before implementing it.

## Report a problem

Use the bug report template and include:

- Action version or commit SHA, Linux distribution, and architecture.
- Runner topology and filesystem type, without private hostnames or addresses.
- A minimal workflow and the expected versus actual result.
- Sanitized warnings and whether the failure occurred during restore or post-job save.

Never attach credentials, real cache payloads, or unsanitized private job logs.
Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.

## Make a change

1. Fork the repository and create a focused branch.
2. Read the [specification](docs/SPEC.md) and [development guide](docs/DEVELOPMENT.md).
3. Use Linux, Node 24, pnpm 11.25.0, and Go 1.27.2 for builds. Run
   `pnpm install --frozen-lockfile`, `pnpm check`, and
   `pnpm exec prettier --check .`.
4. Include meaningful regression coverage for behavior changes and commit the
   reproducible `dist/` artifacts. Use only synthetic data on task-owned storage.
5. Update relevant guides and keep the README quick-start workflow consistent
   with `examples/npm.yml`.
6. Open a pull request describing the problem, resulting behavior, and verification.

For documentation-only changes, check links, examples, formatting, and consistency.
You do not need to provision a runner or test against a real cache volume.

Contributions are licensed under the repository's [MIT license](LICENSE).
Maintainers handle release tags using the [release procedure](docs/RELEASING.md).
