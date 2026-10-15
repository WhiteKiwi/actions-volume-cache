# Releasing

This repository publishes a GitHub Action from committed source/distributables,
not an npm package. Release Please prepares version changes; a maintainer merging
its release PR authorizes publication of that reviewed release. Ordinary main
commits prepare a proposal and do not immediately release the action.

## Normal workflow

1. Merge focused changes into `main` using Conventional Commit squash titles:
   `fix:` for a patch, `feat:` for a minor, and `feat!:` or `BREAKING CHANGE` for
   a major. Documentation and maintenance-only commits normally wait for the
   next releasable change.
2. After successful main-push **CI**, **Release** runs Release Please in
   proposal-only mode. It maintains one bot-authored PR on
   `release-please--branches--main--components--actions-volume-cache` with the package version, CHANGELOG, and
   `.release-please-manifest.json` changes. Preserve the generated changelog
   formatting; it is excluded from Prettier while its version section is checked
   before publication.
3. The workflow explicitly starts **CI** on that bot branch. GitHub suppresses
   ordinary PR events created with `GITHUB_TOKEN`; `workflow_dispatch` avoids
   requiring a separate PAT or App key. An aggregate **Release PR CI** commit
   status links the dispatch run back to the PR; inspect that exact head status.
4. Review and squash-merge the release PR when ready. Do not add runtime source,
   workflow, or documentation edits to it; make those changes in ordinary PRs.
5. Wait for **CI** on the actual main merge commit. Only a successful main-push
   CI run can authorize publication. PR and manual-dispatch test runs cannot.
6. **Release** verifies the bot PR identity and metadata, creates the fixed
   version tag and GitHub Release, and advances the corresponding major tag
   using a targeted Git lease. It does not rewrite existing fixed releases.
7. A reusable native x64/arm64 job downloads the public major tag, verifies its
   full commit SHA, executes that downloaded action, and observes its actual
   successful-job post save. Only then is the release PR marked
   `autorelease: tagged` and preparation of the next release allowed.
8. Check the Marketplace job summary. It independently checks the listing's
   structured latest-release data. If reflection is missing or cannot be read,
   it emits a warning and a release-edit link for manual Marketplace publication.
   Successful GitHub release publication alone is not proof of Marketplace publication.

Release workflows never merge or approve the release PR for you. Keep the main
branch's normal review/merge policy. Do not automate merging the release PR with
`GITHUB_TOKEN`: that can suppress the main-push CI needed for publication.

The initial automation starts from the existing `v1.0.1` commit and manifest.
It does not recreate historical releases. Releases are stable semantic versions;
prerelease and maintenance-branch publication are outside this initial workflow.

## Repository permissions

The workflow uses the repository's short-lived `GITHUB_TOKEN`. There are no new
PATs, private keys, browser cookies, or external credential services.

Enable **Settings → Actions → General → Allow GitHub Actions to create and
approve pull requests** so Release Please can open proposals. The workflow does
not use its ability to approve. Keep default workflow token permissions read-only;
individual jobs declare the write permissions they need.

The publish job needs contents write and read access to CI/PR records. Only the
proposal job receives Actions write to dispatch bot-PR CI. Release completion
receives Issues write for its two release labels. Ordinary CI and downloaded
consumer checks keep read-only contents access. The release-PR CI reporter gets
only Statuses write, checks out no code, and reports the aggregate native test
and lifecycle results on the tested commit.

## Tag and publication policy

- Publish exact semantic tags such as `v1.0.2` once. Never reuse or move them.
- Keep a separate major tag, such as `v1`, for compatible releases. The alias is
  a Git tag, not a branch. No minor-version aliases are currently maintained.
- Release creation and major advancement run only after native CI on the source
  merge commit. Exact tags and public releases must agree with that commit.
- Reject an existing fixed tag pointing elsewhere, an older published version,
  or moving a major alias to an equal-version different commit or newer version's
  predecessor. A failed Git lease requires investigation, not an unconditional force.
- Attach GitHub Releases only to fixed tags. Major tags remain movable even if
  immutable GitHub Releases are enabled later.
- A new major version creates a separate major alias. The public-download
  verifier takes that alias as an input rather than hardcoding `v1`.
- Ordinary commits do not move aliases. Only `CHANGELOG.md`, `package.json`, and
  `.release-please-manifest.json` may change in an automated release PR.

The cache action's storage format v2 is independent of its release version.
The runtime remains committed and reproducible; no npm publication is performed.

## Recovery and manual verification

Release execution is serialized without cancelling an active publication. GitHub
may replace an older pending concurrency run when several CI completions arrive
close together. If a release remains pending, or an API/verification step fails,
use **Release → Run workflow** on `main` and supply the successful main-push CI
run ID for the release merge commit. Do not supply a PR run or a dispatch run.

Recovery runs use the current workflow controller commit; package version,
manifest, CHANGELOG, and published tags still come from the exact tested source
commit. The REST client pins the 2022-11-28 response contract used to verify the
release PR merge SHA.

The workflow rechecks the retained CI run, reuses matching tags/releases, and
retries major advancement and public verification. It rejects conflicting tags
and newer aliases instead of overwriting them. After a partial failure, a fixed
release may already exist; inspect the job summary and refs before recovery.
A failed post-publication verification leaves the release pending and stops the
next proposal. No automatic rollback or deletion of a published release occurs.

If GitHub rejects tag creation with `403` because the tested source has different
workflow files from current main, `GITHUB_TOKEN` cannot gain the required
Workflows write scope. Do not add a broad PAT to CI to bypass this restriction.
A maintainer with existing workflow-authorized Git credentials must first verify
that exact source CI, publish the unchanged fixed tag/release, and advance its
major alias using a targeted lease. Then resume **Release** with the original CI
run ID to perform public-action verification, label completion, and Marketplace
checking. This is an exceptional historical-commit recovery path; normal releases
target the newly tested main merge commit. Never retarget an exact release tag
to a different commit to make recovery pass.

For an independent observation, run **Verify published action** and provide the
major tag and optional expected full commit SHA. It uses synthetic temporary
storage and does not inspect a real runner's cache volume.

```sh
gh workflow run verify-release.yml --ref main -f major-tag=v1 -f expected-sha=FULL_RELEASE_COMMIT_SHA
```

After any release, inspect exact and major refs, GitHub Release, native consumer
verification, and Marketplace status. A draft, a local tag, or a pending job is
not evidence of completed publication.

## Marketplace listing

The account owner accepted GitHub Marketplace Developer Agreement v2.4 for the
initial `v1.0.1` listing. The release automation does not accept new agreements or
perform interactive authentication. It only reads the public listing.

When manual publication is needed, edit the existing fixed-version release,
select **Publish this Action to the GitHub Marketplace**, and save. Keep
**Dependency management** as the primary category and **Continuous integration**
as the secondary category. Verify the resulting public version. Retain the MIT
license and bundled third-party notices.

## References

- [Release Please](https://github.com/googleapis/release-please-action)
- [GitHub token event suppression and explicit dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)
- [Semantic action releases](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/release-and-maintain-actions)
- [Immutable releases and movable tags](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/using-immutable-releases-and-tags-to-manage-your-actions-releases)
- [Marketplace publishing](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace)
