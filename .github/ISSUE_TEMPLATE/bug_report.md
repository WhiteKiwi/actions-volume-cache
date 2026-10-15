---
name: Bug report
about: Report a reproducible restore, save, cleanup, or locking problem
title: ''
labels: ''
assignees: ''
---

## Expected and actual behavior

Describe what you expected and what happened. Did it happen during restore or post-job save?

## Environment

- Action version or commit SHA:
- Linux distribution and architecture:
- Runner topology (persistent host or ephemeral container):
- Volume filesystem type:
- Does it reproduce with a fresh synthetic cache?:

## Minimal reproduction

Include a minimal workflow and synthetic files needed to reproduce the issue.
Remove credentials, private URLs, identifying paths, and real cache payloads.

## Sanitized logs

Include relevant warnings and errors. Do not paste complete private job logs.
For vulnerabilities, follow [the security policy](https://github.com/WhiteKiwi/actions-volume-cache/blob/main/SECURITY.md).
