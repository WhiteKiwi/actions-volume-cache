import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareVersions,
  isReleasePR,
  marketplaceVersion,
  publishRelease,
  releaseNotes,
  versionParts,
} from './release-lib.mjs';

const sha = 'a'.repeat(40);
const old = 'b'.repeat(40);
const repo = 'WhiteKiwi/actions-volume-cache';
function fixture() {
  const pr = {
    number: 7,
    merged_at: '2026-10-15T12:00:00Z',
    merge_commit_sha: sha,
    base: { ref: 'main' },
    head: {
      ref: 'release-please--branches--main--components--actions-volume-cache',
      repo: { full_name: repo },
    },
    user: { login: 'github-actions[bot]' },
    labels: [{ name: 'autorelease: pending' }],
  };
  const state = {
    pr,
    mutations: [],
    pushes: [],
    refs: `${old}\trefs/tags/v1\n`,
    oldVersion: '1.0.1',
    releases: [{ tag_name: 'v1.0.1' }],
    failRelease: false,
    failPush: false,
    files: ['package.json', '.release-please-manifest.json', 'CHANGELOG.md'],
  };
  const api = async (method, path, body) => {
    if (method !== 'GET') state.mutations.push({ method, path, body });
    if (path.startsWith('/commits/')) return state.pr ? [state.pr] : [];
    if (path.startsWith('/pulls/'))
      return state.files.map((filename) => ({ filename, status: state.fileStatus || 'modified' }));
    if (path.startsWith('/contents/package.json'))
      return {
        content: Buffer.from(JSON.stringify({ version: state.oldVersion })).toString('base64'),
      };
    if (path === '/releases?per_page=100') return state.releases;
    if (path === '/git/tags') return { sha: 'c'.repeat(40) };
    if (path === '/git/refs') return body;
    if (path === '/releases') {
      if (state.failRelease) throw new Error('release API failed');
      return { html_url: `https://github.com/${repo}/releases/tag/v1.0.2`, ...body };
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  };
  const git = async (args) => {
    if (args[0] === 'ls-remote') return state.refs;
    assert.equal(args[0], 'push');
    state.pushes.push(args);
    if (state.failPush) throw new Error('lease failed');
    return '';
  };
  const args = {
    api,
    git,
    repo,
    sha,
    version: '1.0.2',
    manifest: { '.': '1.0.2' },
    changelog:
      '# Changelog\n\n## [1.0.2](https://example.com) (2026-10-15)\n\n* fix: test\n\n## v1.0.1 — 2026-10-15\n\nold',
    ciUrl: 'https://github.com/WhiteKiwi/actions-volume-cache/actions/runs/42',
  };
  return { state, args };
}

test('publishes only a reviewed bot release merge and uses a targeted alias lease', async () => {
  const { state, args } = fixture();
  const result = await publishRelease(args);
  assert.deepEqual(result, {
    released: true,
    tag: 'v1.0.2',
    major: 'v1',
    sha,
    pr: 7,
    url: `https://github.com/${repo}/releases/tag/v1.0.2`,
  });
  assert.deepEqual(
    state.mutations.map((x) => x.path),
    ['/git/tags', '/git/refs', '/releases'],
  );
  assert.equal(state.mutations[0].body.object, sha);
  assert.equal(state.mutations[2].body.target_commitish, sha);
  assert.match(state.mutations[2].body.body, /native x64\/arm64 CI/);
  assert(!state.mutations[2].body.body.includes('\nold'));
  assert.deepEqual(state.pushes, [
    ['push', `--force-with-lease=refs/tags/v1:${old}`, 'origin', `${sha}:refs/tags/v1`],
  ]);
});

test('ordinary main commits cannot publish releases', async () => {
  const { state, args } = fixture();
  state.pr = null;
  assert.deepEqual(await publishRelease(args), { released: false });
  assert.equal(state.mutations.length, 0);
  assert.equal(state.pushes.length, 0);
});

test('fork, human, other-branch and unrelated merge PRs cannot impersonate a release', () => {
  const { state } = fixture();
  for (const mutate of [
    (p) => (p.user.login = 'someone'),
    (p) => (p.head.repo.full_name = 'fork/repo'),
    (p) => (p.base.ref = 'dev'),
    (p) => (p.merge_commit_sha = old),
    (p) => (p.labels = []),
    (p) => (p.head.ref = 'feature'),
  ]) {
    const pr = structuredClone(state.pr);
    mutate(pr);
    assert(!isReleasePR(pr, repo, sha));
  }
  assert(isReleasePR(state.pr, repo, sha));
});

test('refuses runtime files in a release PR before any publication', async () => {
  const { state, args } = fixture();
  state.files.push('dist/main.js');
  await assert.rejects(publishRelease(args), /only version metadata/);
  assert.equal(state.mutations.length, 0);
});

test('refuses mismatched versions and missing changelog before writing', async () => {
  for (const patch of [
    { manifest: { '.': '1.0.3' } },
    { changelog: '# Changelog\n## 1.0.1\nold' },
  ]) {
    const { state, args } = fixture();
    await assert.rejects(publishRelease({ ...args, ...patch }));
    assert.equal(state.mutations.length, 0);
  }
});

test('release metadata cannot be renamed, removed or added from another path', async () => {
  for (const status of ['renamed', 'removed', 'added']) {
    const { state, args } = fixture();
    state.fileStatus = status;
    await assert.rejects(publishRelease(args), /file operation/);
    assert.equal(state.mutations.length, 0);
  }
});

test('does not overwrite an exact tag on a different commit', async () => {
  const { state, args } = fixture();
  state.refs += `${old}\trefs/tags/v1.0.2\n`;
  await assert.rejects(publishRelease(args), /exact tag points to another commit/);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.pushes.length, 0);
});

test('does not move an equal/newer alias to another commit', async () => {
  for (const version of ['1.0.2', '1.0.3']) {
    const { state, args } = fixture();
    state.oldVersion = version;
    await assert.rejects(publishRelease(args), /equal\/newer alias/);
    assert.equal(state.mutations.length, 0);
    assert.equal(state.pushes.length, 0);
  }
});

test('older versions cannot supersede a newer published release', async () => {
  const { state, args } = fixture();
  state.releases.push({ tag_name: 'v1.1.0' });
  await assert.rejects(publishRelease(args), /older release/);
  assert.equal(state.mutations.length, 0);
});

test('retries a published release without rewriting it or its tags', async () => {
  const { state, args } = fixture();
  state.refs = `${sha}\trefs/tags/v1\n${'c'.repeat(40)}\trefs/tags/v1.0.2\n${sha}\trefs/tags/v1.0.2^{}\n`;
  state.releases.push({ tag_name: 'v1.0.2', html_url: 'release-url' });
  assert.equal((await publishRelease(args)).released, true);
  assert.equal(state.mutations.length, 0);
  assert.equal(state.pushes.length, 0);
});

test('a failed release API call cannot advance the major alias', async () => {
  const { state, args } = fixture();
  state.failRelease = true;
  await assert.rejects(publishRelease(args), /release API failed/);
  assert.equal(state.pushes.length, 0);
});

test('an alias lease failure is surfaced instead of forcing over a concurrent update', async () => {
  const { state, args } = fixture();
  state.failPush = true;
  await assert.rejects(publishRelease(args), /lease failed/);
  assert.equal(state.pushes.length, 1);
});

test('releases never recreate a lost historical tag', async () => {
  const { state, args } = fixture();
  state.releases.push({ tag_name: 'v1.0.2' });
  await assert.rejects(publishRelease(args), /lost its exact tag/);
  assert.equal(state.mutations.length, 0);
});

test('major releases create a separate major alias', async () => {
  const { state, args } = fixture();
  state.refs = '';
  args.version = '2.0.0';
  args.manifest = { '.': '2.0.0' };
  args.changelog = '## 2.0.0\n\nbreaking';
  const result = await publishRelease(args);
  assert.equal(result.major, 'v2');
  assert.equal(state.pushes[0][1], '--force-with-lease=refs/tags/v2:');
});

test('semver parsing rejects prereleases, leading zeros and unsafe components', () => {
  for (const v of ['1.0.1-beta', '01.0.1', '1.0.1\n', '1.2', '1.0.9007199254740992'])
    assert.throws(() => versionParts(v));
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.match(releaseNotes('## v1.0.1 — 2026-10-15\n\nnotes', '1.0.1'), /notes/);
});

test('Marketplace verification reads actual listing version, not README claims', () => {
  const listing = {
    payload: {
      readmeHtml: '@v1.0.2',
      releaseData: { latestRelease: { tagName: 'v1.0.1', isPrerelease: false } },
    },
  };
  const html = `<script type="application/json">${JSON.stringify(listing)}</script><p>v1.0.2 Latest</p>`;
  assert.equal(marketplaceVersion(html), 'v1.0.1');
  assert.throws(() => marketplaceVersion('<p>v1.0.2 Latest</p>'), /unavailable/);
  assert.throws(
    () => marketplaceVersion('<script type="application/json">bad</script>'),
    /unavailable/,
  );
});
