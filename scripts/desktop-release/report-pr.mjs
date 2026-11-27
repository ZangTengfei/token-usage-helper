import { appendFile } from 'node:fs/promises';

const {
  GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA,
  GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_STEP_SUMMARY, GH_TOKEN, RELEASE_VERSION,
} = process.env;

if (!/^\d+\.\d+\.\d+$/.test(RELEASE_VERSION || '')) throw new Error('无效发布版本号');

async function api(path, method = 'GET', body) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${GH_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

function stepStatus(job, name) {
  const conclusion = job.steps.find(step => step.name === name)?.conclusion;
  return {
    success: '成功', failure: '失败', skipped: '未运行',
    cancelled: '已取消', timed_out: '超时',
  }[conclusion] ?? '无结果';
}

const [{ jobs }, pulls] = await Promise.all([
  api(`/actions/runs/${GITHUB_RUN_ID}/jobs?filter=latest`),
  api(`/commits/${GITHUB_SHA}/pulls`),
]);
const releaseJobs = jobs.filter(job => /^release \(/.test(job.name));
const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
const marker = `<!-- desktop-release-run:${GITHUB_RUN_ID} -->`;
const status = releaseJobs.map(job => {
  const platform = job.name.includes('macos') ? 'Mac ARM64' : 'Windows x64';
  const columns = ['构建并签名安装包', '上传私有 COS 并校验', '发布官网下载', '发布应用内更新'];
  return `| [${platform}](${job.html_url}) | ${columns.map(name => stepStatus(job, name)).join(' | ')} |`;
});
const body = [
  marker,
  `### Token 用量助手 ${RELEASE_VERSION} 发布结果`,
  '',
  `[查看 Actions 日志及工件（第 ${GITHUB_RUN_ATTEMPT} 次运行）](${runUrl})`,
  '',
  '| 平台 | 构建打包并签名 | 私有 COS 上传及校验 | 官网发布 | 应用内更新 |',
  '| --- | --- | --- | --- | --- |',
  ...status,
].join('\n');

await appendFile(GITHUB_STEP_SUMMARY, body + '\n');
const pull = pulls.find(item => item.merged_at && item.merge_commit_sha === GITHUB_SHA && item.base.ref === 'main');
if (pull) {
  let existing;
  for (let page = 1; !existing; page++) {
    const comments = await api(`/issues/${pull.number}/comments?per_page=100&page=${page}`);
    existing = comments.find(comment => comment.user.login === 'github-actions[bot]' && comment.body?.startsWith(marker));
    if (comments.length < 100) break;
  }
  if (existing) await api(`/issues/comments/${existing.id}`, 'PATCH', { body });
  else await api(`/issues/${pull.number}/comments`, 'POST', { body });
}
