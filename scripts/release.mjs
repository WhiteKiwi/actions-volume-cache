import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { RELEASE_BRANCH, isReleasePR, marketplaceVersion, publishRelease } from './release-lib.mjs';

const repo = process.env.GITHUB_REPOSITORY;
assert.equal(repo, 'WhiteKiwi/actions-volume-cache');
const base = `https://api.github.com/repos/${repo}`;
const summary = (text) => appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
const output = async (data) => {
  for (const [key, value] of Object.entries(data)) {
    assert(!String(value).includes('\n'));
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
};
async function api(method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `GitHub ${method} ${route} returned ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

const command = process.argv[2];
if (command === 'publish') {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (!event.workflow_run) assert.match(event.inputs['ci-run-id'], /^\d+$/);
  const run =
    event.workflow_run || (await api('GET', `/actions/runs/${event.inputs['ci-run-id']}`));
  assert.equal(run?.event, 'push');
  assert.equal(run.head_branch, 'main');
  assert.equal(run.head_repository.full_name, repo);
  assert.equal(run.conclusion, 'success');
  // Confirm the retained run itself rather than trusting only workflow-event fields.
  const checkedRun = await api('GET', `/actions/runs/${run.id}`);
  assert.equal(checkedRun.head_sha, run.head_sha);
  assert.equal(checkedRun.conclusion, 'success');
  assert.equal(checkedRun.path, '.github/workflows/ci.yml');
  assert.equal(checkedRun.event, 'push');
  assert.equal(checkedRun.head_branch, 'main');
  assert.equal(checkedRun.repository.full_name, repo);
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  const result = await publishRelease({
    api,
    git: (args) => execFileSync('git', args, { encoding: 'utf8' }),
    repo,
    sha: run.head_sha,
    version: JSON.parse(
      execFileSync('git', ['show', `${run.head_sha}:package.json`], { encoding: 'utf8' }),
    ).version,
    manifest: JSON.parse(
      execFileSync('git', ['show', `${run.head_sha}:.release-please-manifest.json`], {
        encoding: 'utf8',
      }),
    ),
    changelog: execFileSync('git', ['show', `${run.head_sha}:CHANGELOG.md`], { encoding: 'utf8' }),
    ciUrl: run.html_url,
  });
  await output(result);
  await summary(
    result.released
      ? `Published [${result.tag}](${result.url}); ${result.major} → ${result.sha}. Public download/save verification follows.`
      : 'No release PR merged at this tested commit. Preparing the next release PR only.',
  );
} else if (command === 'complete') {
  const sha = process.env.RELEASE_SHA;
  const number = Number(process.env.RELEASE_PR);
  assert(Number.isSafeInteger(number) && number > 0);
  const pr = await api('GET', `/pulls/${number}`);
  assert(isReleasePR(pr, repo, sha), 'Release PR identity changed');
  await api('POST', `/issues/${number}/labels`, { labels: ['autorelease: tagged'] });
  if (pr.labels.some((label) => label.name === 'autorelease: pending')) {
    await api('DELETE', `/issues/${number}/labels/autorelease%3A%20pending`);
  }
  await summary(`Release PR #${number} marked tagged after native public-action verification.`);
} else if (command === 'dispatch-pr-ci') {
  const prs = await api('GET', '/pulls?state=open&base=main&per_page=100');
  for (const pr of prs.filter(
    (item) =>
      item.head.ref === RELEASE_BRANCH &&
      item.head.repo?.full_name === repo &&
      item.user.login === 'github-actions[bot]',
  )) {
    // GITHUB_TOKEN-created PRs do not fire pull_request. workflow_dispatch is an explicit exception.
    await api('POST', '/actions/workflows/ci.yml/dispatches', { ref: pr.head.ref });
    await summary(
      `Release PR [#${pr.number}](${pr.html_url}) is ready for review. Explicitly dispatched CI for ${pr.head.sha}. Merge this PR when ready to release.`,
    );
  }
} else if (command === 'marketplace') {
  const tag = process.env.RELEASE_TAG;
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  const url = 'https://github.com/marketplace/actions/actions-volume-cache';
  let observed = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'Cache-Control': 'no-cache' },
      });
      assert(response.ok, `Marketplace HTTP ${response.status}`);
      observed = marketplaceVersion(await response.text());
      if (observed === tag) break;
    } catch (error) {
      observed = `unavailable (${error.message})`;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  const matched = observed === tag;
  await output({ 'marketplace-status': matched ? 'published' : 'manual-publish-needed' });
  if (!matched)
    console.log(
      '::warning::Marketplace publication is not confirmed. Use the release edit link in the job summary to publish manually.',
    );
  await summary(
    matched
      ? `Marketplace shows [${tag}](${url}) as latest.`
      : `Marketplace publication **needs manual verification**. Expected ${tag}; observed ${observed}. Git tags/release and public action verification succeeded. [Edit release](https://github.com/${repo}/releases/edit/${tag}), select **Publish this Action to the GitHub Marketplace**, save, then check the [listing](${url}). No browser cookies or interactive credentials are stored in CI.`,
  );
} else {
  throw new Error(`Unknown release command: ${command}`);
}
