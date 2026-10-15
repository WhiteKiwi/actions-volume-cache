# Security policy

## Supported versions

Security fixes target the latest v1 release. Use `@v1` for approved compatible
updates, or track exact releases if your workflows pin a fixed tag or commit.
Historical exact tags remain fixed.

## Report a vulnerability

Do not publish exploit details, credentials, private paths, or cache contents in
a public issue or pull request. Use GitHub's **Report a vulnerability** option
on this repository's [Security page](https://github.com/WhiteKiwi/actions-volume-cache/security)
if available. If private reporting is unavailable, open an issue requesting a
private contact channel without disclosing the vulnerability itself.

In a private report, include the affected version, Linux architecture, filesystem
type, minimal synthetic reproduction, and expected impact. Avoid real credentials
and cache data. Reports are handled on a best-effort basis; no response SLA is offered.

## Trust boundary

This action is intended for trusted jobs on Linux x64/arm64 using a persistent
local filesystem. Jobs with write access to the mount must be mutually trusted.
Repository namespaces organize entries; they do not prevent a process from
accessing another namespace on the same writable filesystem.

Give each concurrent job private restore destinations, including paths under
`HOME`. Do not cache credentials. NFS/SMB, hostile local processes, and direct
mutation of managed cache internals are outside the support boundary. See the
[runner setup guide](docs/RUNNERS.md) for the full storage and ownership requirements.
