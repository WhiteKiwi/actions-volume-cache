# Releasing

This repository publishes a GitHub Action from committed source/distributables.
It does not publish an npm package. Release/tag operations require explicit
release authorization; documentation-only edits do not authorize them.

## Tag policy

- Publish semantic releases using exact tags such as `v1.0.0`.
- Keep exact release tags fixed. Publish corrections as another version.
- Use a separate moving major tag such as `v1` for the latest approved compatible
  release in that series. `v1` is a tag, not a branch.
- Move the major alias only as part of an approved release, after validation.
  A new main commit does not automatically move it.
- Create a new major tag for breaking contract changes. A backport must not move
  an alias backwards over a newer compatible release.
- Attach GitHub Releases to exact tags, never to moving aliases. This also keeps
  the alias movable if immutable GitHub Releases are enabled later.

The initial release provides `v1.0.0` and `v1`. Minor-version aliases are not
currently published. Public examples use major tags; repository CI keeps its
separate SHA pins. GitHub's
[release guidance](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions)
and [immutable-release/tag model](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases)
describe this separation.

## Prepare and verify

1. Update `package.json` to the release version and add its entry to
   [CHANGELOG.md](../CHANGELOG.md). Keep the public input/output contract and
   supported platforms explicit. Update examples for a new major version.
2. Review the changes through a PR. Follow [DEVELOPMENT.md](DEVELOPMENT.md) for
   frozen installation, checks, formatting, and committed distributables.
3. Merge only after native x64/arm64 CI, reproducible distributables, post-job
   lifecycle checks, and relevant review findings pass.
4. Fetch main and choose its exact tested commit. Check main CI on that commit,
   not just an earlier PR head. Inspect `action.yml`, `package.json`, `dist/`,
   the helper checksum manifest, and executable file modes in that tree.
5. Confirm the exact tag/release does not already exist. Check existing major
   aliases and the release history before selecting the next version.
6. Prepare release-specific notes with the tested commit and CI evidence. State
   unsupported deployment/performance claims honestly.

## First release

After the checks above, from this repository with main fetched and a clean
working tree:

```sh
release_commit=$(git rev-parse origin/main)
git tag -a v1.0.0 "$release_commit" -m 'Release v1.0.0'
git tag v1 "$release_commit"
git push --atomic origin refs/tags/v1.0.0 refs/tags/v1
gh release create v1.0.0 --verify-tag --title 'v1.0.0' --notes-file .cache/release-notes.md --latest
```

Prepare `.cache/release-notes.md` first. Use the repository's configured Git
authentication. The exact and major tags initially resolve to the same commit;
only the exact tag has a GitHub Release.

## Later compatible releases

Create and publish the new exact tag/release after the same verification. Then
advance the major alias to that tested release commit. Observe the remote alias
before updating it and use a targeted lease to detect concurrent changes:

```sh
release_commit=$(git rev-parse 'v1.0.1^{commit}')
old_alias=$(git ls-remote origin refs/tags/v1 | cut -f1)
test -n "$old_alias"
git push --force-with-lease="refs/tags/v1:$old_alias" origin "$release_commit:refs/tags/v1"
```

`v1.0.1` is an example of a future patch release; select the actual approved
version. Never force-push every tag or overwrite an exact release tag. If a lease
fails, inspect the new remote state before deciding what to publish.

## Verify publication

Confirm the remote exact tag (peeling an annotated tag to its commit), major tag,
and GitHub Release all resolve to the tested commit. Confirm no `v1` branch was
created and `uses: WhiteKiwi/actions-volume-cache@v1` fetches the full action,
including both executable lock helpers and their checksum manifest.

Run the manual consumer check after publishing and inspect its native x64/arm64
results. It downloads `WhiteKiwi/actions-volume-cache@v1` as a remote action and
uses a post observer to verify saving. Confirm the downloaded action SHA in the
logs matches the chosen release commit:

```sh
gh workflow run verify-release.yml --ref v1.0.0
gh run list --workflow verify-release.yml
```

Select the exact tag being verified; `v1.0.0` is the initial-release example.

For the first release:

```sh
git ls-remote origin refs/tags/v1 refs/tags/v1.0.0 'refs/tags/v1.0.0^{}' refs/heads/v1
gh release view v1.0.0
```

A draft, a local-only tag, or a pending CI run is not a completed release. Keep
the release commit, tag targets, CI URLs, and final publication receipt with the
task's verification record.

## Marketplace listing

Use the public display name and branding in `action.yml`. Keep the listing
focused on local-volume caching for Linux self-hosted runners, and retain the
persistent-mount and trusted-job requirements in the README. Check name
availability in GitHub's release form rather than assuming it is unique.

The project uses the root MIT license. Preserve bundled third-party notices.
A release containing license or listing changes still follows the exact-commit
checks above; do not rewrite an older tag to add them.

When publishing a release, select **Publish this release to the GitHub
Marketplace** and choose **Dependency management** as the primary category and
**Continuous integration** as the secondary category, when offered. Validate
metadata in the release form and verify the resulting public listing and version.
A normal CLI-created GitHub Release does not by itself prove Marketplace publication.

The account owner must accept GitHub's Marketplace Developer Agreement before
first publication. Acceptance is a separate legal commitment and requires the
owner's confirmation; repository edits do not accept it. Follow GitHub's
[publishing instructions](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).
