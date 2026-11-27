import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function status(conclusion) {
  return {
    success: '通过', failure: '失败', skipped: '未运行',
    cancelled: '已取消', timed_out: '超时',
  }[conclusion] ?? '无结果';
}

function stepStatus(job, name) {
  return status(job.steps.find(step => step.name === name)?.conclusion);
}

function platform(name) {
  return name.includes('macos-15') ? 'Mac ARM64' : 'Windows x64';
}

export async function findCiPull(api, run, repositoryId) {
  if (run.event !== 'pull_request') return;
  const attached = (run.pull_requests ?? []).filter(pull => pull.base.repo.id === repositoryId);
  if (attached.length === 1) return attached[0].number;
  if (attached.length > 1 || !run.head_repository || !run.head_branch) return;

  // GitHub may omit pull_requests for forks. Require an exact current head in that fork.
  const head = encodeURIComponent(`${run.head_repository.owner.login}:${run.head_branch}`);
  const pulls = await api(`/pulls?state=all&head=${head}&per_page=100`);
  const matches = pulls.filter(pull =>
    pull.base.repo.id === repositoryId && pull.head.repo?.id === run.head_repository.id &&
    pull.head.ref === run.head_branch && pull.head.sha === run.head_sha
  );
  if (matches.length === 1) return matches[0].number;
}

export async function postNewComment(api, pull, marker, report) {
  const query = `/issues/${pull}/comments`;
  for (let page = 1; ; page++) {
    const comments = await api(`${query}?per_page=100&page=${page}`);
    if (comments.some(comment =>
      comment.user.type === 'Bot' && comment.user.login === 'github-actions[bot]' &&
      comment.body?.startsWith(marker)
    )) return;
    if (comments.length < 100) break;
  }
  return api(query, 'POST', { body: `${marker}\n${report}` });
}

export async function reportPullRequest(api, env, event) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT, GITHUB_STEP_SUMMARY, RELEASE_VERSION } = env;
  const ci = event?.workflow_run;
  const runId = ci?.id ?? GITHUB_RUN_ID;
  const attempt = ci?.run_attempt ?? GITHUB_RUN_ATTEMPT;
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) throw new Error('无效的 Actions 运行编号');

  const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${runId}`;
  const attemptUrl = `${runUrl}/attempts/${attempt}`;
  const jobsPath = `/actions/runs/${runId}/attempts/${attempt}/jobs`;
  let pull;
  let lines;
  if (ci) {
    pull = await findCiPull(api, ci, event.repository.id);
    if (!pull) return;
    const [{ jobs }, { artifacts }] = await Promise.all([
      api(jobsPath), api(`/actions/runs/${runId}/artifacts?per_page=100`),
    ]);
    const rows = jobs.filter(job => /^verify \(/.test(job.name)).map(job => {
      const runner = job.name.includes('macos-15') ? 'macos-15' : 'windows-latest';
      const artifact = artifacts.find(item => !item.expired && item.name === `pr-package-${runner}-attempt-${attempt}`);
      const result = artifact
        ? `[下载测试安装包](${runUrl}/artifacts/${artifact.id})`
        : stepStatus(job, '构建测试安装包');
      return `| [${platform(job.name)}](${job.html_url}) | ${status(job.conclusion)} | ${result} | PR 阶段未触发 |`;
    });
    lines = [
      '### PR 构建结果', '',
      `提交 \`${ci.head_sha.slice(0, 7)}\` · [Actions 第 ${attempt} 次运行](${attemptUrl}) · ${status(ci.conclusion)}`, '',
      '| 平台 | 检查结果 | 测试安装包 | COS 上传 |',
      '| --- | --- | --- | --- |', ...rows,
    ];
  } else {
    if (!/^\d+\.\d+\.\d+$/.test(RELEASE_VERSION || '')) throw new Error('无效发布版本号');
    const [{ jobs }, pulls] = await Promise.all([
      api(jobsPath), api(`/commits/${GITHUB_SHA}/pulls`),
    ]);
    const merged = pulls.find(item => item.merged_at && item.merge_commit_sha === GITHUB_SHA && item.base.ref === 'main');
    pull = merged?.number;
    const stages = ['构建并签名安装包', '上传私有 COS 并校验', '发布官网下载', '发布应用内更新'];
    const rows = jobs.filter(job => /^release \(/.test(job.name)).map(job =>
      `| [${platform(job.name)}](${job.html_url}) | ${stages.map(name => stepStatus(job, name)).join(' | ')} |`
    );
    lines = [
      `### Token 用量助手 ${RELEASE_VERSION} 发布结果`, '',
      `[查看 Actions 日志及工件（第 ${attempt} 次运行）](${attemptUrl})`, '',
      '| 平台 | 构建打包并签名 | 私有 COS 上传及校验 | 官网发布 | 应用内更新 |',
      '| --- | --- | --- | --- | --- |', ...rows,
    ];
  }
  const report = lines.join('\n');
  await appendFile(GITHUB_STEP_SUMMARY, report + '\n');
  if (pull) {
    const marker = `<!-- desktop-${ci ? 'ci' : 'release'}-run:${runId}:${attempt} -->`;
    await postNewComment(api, pull, marker, report);
  }
}

async function run() {
  const env = process.env;
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GH_TOKEN } = env;
  const event = process.argv.includes('--ci') ? JSON.parse(await readFile(GITHUB_EVENT_PATH, 'utf8')) : undefined;
  if (event && !event.workflow_run) throw new Error('缺少已完成的 Actions 运行');
  await reportPullRequest(async (path, method = 'GET', body) => {
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }, env, event);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
