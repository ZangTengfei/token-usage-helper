import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCiPull, reportPullRequest } from './report-pr.mjs';

const sha = 'a'.repeat(40);
const run = {
  id: 101, run_attempt: 1, event: 'pull_request', conclusion: 'failure', head_sha: sha,
  head_branch: 'fix/chart', head_repository: { id: 12, owner: { login: 'contributor' } },
  pull_requests: [],
};

test('links fork CI only when the repository, branch, and commit match', async () => {
  const ref = { ref: run.head_branch, sha, repo: { id: 12 } };
  const candidate = { number: 7, base: { repo: { id: 5 } }, head: ref };
  const api = async path => {
    assert.equal(path, '/pulls?state=all&head=contributor%3Afix%2Fchart&per_page=100');
    return [
      { ...candidate, number: 8, head: { ...ref, repo: { id: 13 } } },
      { ...candidate, number: 9, head: { ...ref, sha: 'b'.repeat(40) } },
      candidate,
    ];
  };
  assert.equal(await findCiPull(api, run, 5), 7);
  assert.equal(await findCiPull(api, run, 6), undefined);
  assert.equal(await findCiPull(api, { ...run, pull_requests: [candidate] }, 5), 7);
});

test('reruns create new timestamped comments and duplicate events leave history intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-pr-report-'));
  const summary = join(directory, 'summary');
  const env = {
    GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'org/client',
    GITHUB_STEP_SUMMARY: summary,
  };
  const comments = [];
  const api = async (path, method = 'GET', payload) => {
    if (path.includes('/jobs')) {
      return { jobs: [{
        name: 'verify (macos-15)', html_url: 'https://github.com/org/client/actions/runs/101/job/1',
        conclusion: 'failure', steps: [{ name: '构建测试安装包', conclusion: 'failure' }],
      }] };
    }
    if (path.includes('/artifacts?')) return { artifacts: [] };
    if (method === 'GET') return comments;
    assert.equal(method, 'POST');
    assert.equal(path, '/issues/7/comments');
    comments.push({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: payload.body });
  };

  try {
    for (const attempt of [1, 1, 2]) {
      await reportPullRequest(api, env, {
        repository: { id: 5 },
        workflow_run: { ...run, run_attempt: attempt, pull_requests: [{ number: 7, base: { repo: { id: 5 } } }] },
      });
    }
    assert.deepEqual(comments.map(comment => comment.body.split('\n')[0]), [
      '<!-- desktop-ci-run:101:1 -->', '<!-- desktop-ci-run:101:2 -->',
    ]);
    assert.match(comments[0].body, /失败 \| 失败 \| PR 阶段未触发/);
    assert.match(await readFile(summary, 'utf8'), /runs\/101\/attempts\/2/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
