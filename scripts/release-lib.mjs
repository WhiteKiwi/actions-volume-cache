import assert from 'node:assert/strict';

export const RELEASE_BRANCH = 'release-please--branches--main--components--actions-volume-cache';

export function versionParts(value) {
  assert.equal(typeof value, 'string');
  assert.equal(value.trim(), value, 'Version cannot contain surrounding whitespace');
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const parts = value.split('.').map(Number);
  assert(parts.every(Number.isSafeInteger), 'Version components must be safe integers');
  return parts;
}

export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

export function releaseNotes(changelog, version) {
  versionParts(version);
  const sections = changelog.split(/(?=^## )/m);
  const section = sections.find((text) => {
    const heading = text.split('\n')[0];
    const match = heading.match(/^## (?:\[)?v?(\d+\.\d+\.\d+)(?:\]|\s|$)/);
    return match?.[1] === version;
  });
  assert(section?.trim(), `Missing CHANGELOG section for ${version}`);
  return section.trim();
}

export function marketplaceVersion(html) {
  // Read the listing's structured release data, never a version mentioned in README HTML.
  for (const match of html.matchAll(
    /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    try {
      const data = JSON.parse(match[1]);
      const latest = data.payload?.releaseData?.latestRelease;
      if (latest?.isPrerelease === false && typeof latest.tagName === 'string') {
        versionParts(latest.tagName.replace(/^v/, ''));
        return latest.tagName;
      }
    } catch {
      // Other embedded JSON is unrelated to listing version data.
    }
  }
  throw new Error('Marketplace latest-release data is unavailable; verify the listing manually');
}

export function isReleasePR(pr, repo, sha) {
  return (
    pr.merged_at &&
    pr.merge_commit_sha === sha &&
    pr.base.ref === 'main' &&
    pr.head.repo?.full_name === repo &&
    pr.head.ref === RELEASE_BRANCH &&
    pr.user.login === 'github-actions[bot]' &&
    pr.labels.some((label) => ['autorelease: pending', 'autorelease: tagged'].includes(label.name))
  );
}

export function parseRefs(text) {
  return new Map(
    text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, ref] = line.split(/\s+/);
        assert.match(sha, /^[a-f0-9]{40}$/);
        return [ref, sha];
      }),
  );
}

export async function publishRelease({ api, git, repo, sha, version, manifest, changelog, ciUrl }) {
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const prs = await api('GET', `/commits/${sha}/pulls?per_page=100`);
  for (const pr of prs) {
    if (pr.merged_at && pr.head.ref === RELEASE_BRANCH && pr.user.login === 'github-actions[bot]') {
      assert.match(
        pr.merge_commit_sha || '',
        /^[a-f0-9]{40}$/,
        'Missing release PR merge identity',
      );
    }
  }
  const candidates = prs.filter((pr) => isReleasePR(pr, repo, sha));
  assert(candidates.length <= 1, 'Ambiguous release pull request');
  if (!candidates.length) return { released: false };
  const pr = candidates[0];
  versionParts(version);
  assert.equal(manifest['.'], version, 'Package and release manifest versions differ');
  const files = await api('GET', `/pulls/${pr.number}/files?per_page=100`);
  const allowed = new Set(['CHANGELOG.md', 'package.json', '.release-please-manifest.json']);
  assert(files.length > 0 && files.length <= 3, 'Release PR must contain only version metadata');
  assert(
    files.every((file) => allowed.has(file.filename) && file.status === 'modified'),
    'Unexpected release PR file or file operation',
  );
  const tag = `v${version}`;
  const major = `v${versionParts(version)[0]}`;
  const body = `${releaseNotes(changelog, version)}\n\nRelease commit: \`${sha}\`.\n\nVerified by [native x64/arm64 CI](${ciUrl}).`;
  const releases = await api('GET', '/releases?per_page=100');
  for (const release of releases.filter((item) => !item.draft && !item.prerelease)) {
    assert.match(release.tag_name, /^v\d+\.\d+\.\d+$/);
    assert(compareVersions(version, release.tag_name.slice(1)) >= 0, 'Refusing an older release');
  }
  const refs = parseRefs(
    await git([
      'ls-remote',
      'origin',
      `refs/tags/${tag}`,
      `refs/tags/${tag}^{}`,
      `refs/tags/${major}`,
      `refs/tags/${major}^{}`,
    ]),
  );
  const exactRef = `refs/tags/${tag}`;
  const aliasRef = `refs/tags/${major}`;
  const exactSha = refs.get(`${exactRef}^{}`) || refs.get(exactRef);
  assert(!exactSha || exactSha === sha, 'Existing exact tag points to another commit');
  const oldAlias = refs.get(aliasRef) || '';
  const oldAliasCommit = refs.get(`${aliasRef}^{}`) || oldAlias;
  if (oldAliasCommit && oldAliasCommit !== sha) {
    const oldPackage = await api('GET', `/contents/package.json?ref=${oldAliasCommit}`);
    const oldVersion = JSON.parse(Buffer.from(oldPackage.content, 'base64').toString()).version;
    assert.equal(versionParts(oldVersion)[0], versionParts(version)[0], 'Alias major differs');
    assert(
      compareVersions(version, oldVersion) > 0,
      'Refusing to replace an equal/newer alias commit',
    );
  }
  const existingRelease = releases.find((item) => item.tag_name === tag);
  assert(!existingRelease || exactSha === sha, 'Published release has lost its exact tag');
  assert(
    !existingRelease || (!existingRelease.draft && !existingRelease.prerelease),
    'Existing release is not stable/public',
  );
  // All admission checks precede publication. Exact tags are created once and never moved.
  if (!exactSha) {
    const object = await api('POST', '/git/tags', {
      tag,
      message: `Release ${tag}`,
      object: sha,
      type: 'commit',
    });
    await api('POST', '/git/refs', { ref: exactRef, sha: object.sha });
  }
  let release = existingRelease;
  if (!release) {
    release = await api('POST', '/releases', {
      tag_name: tag,
      target_commitish: sha,
      name: tag,
      body,
      draft: false,
      prerelease: false,
      make_latest: 'true',
    });
  }
  if (oldAliasCommit !== sha) {
    await git([
      'push',
      `--force-with-lease=${aliasRef}:${oldAlias}`,
      'origin',
      `${sha}:${aliasRef}`,
    ]);
  }
  return { released: true, tag, major, sha, pr: pr.number, url: release.html_url };
}
