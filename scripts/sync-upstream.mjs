// Poll byJoey/cfnew-panel, merge it, and reapply the Loon VLESS credential repair.
// Validate runs tests without a write token. Publish fast-forwards main only
// when that tested tree is reproduced. See FORK.md.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { RepairError, repairLoonVlessSource } from './repair-loon-vless.mjs';

export const OFFICIAL_UPSTREAM = 'https://github.com/byJoey/cfnew-panel.git';
export const OFFICIAL_REF = 'refs/heads/main';
const ENGINE = 'src/engine.mjs';
const WORKFLOWS = '.github/workflows';
const PROTECTED = [
  WORKFLOWS, // test.yml and sync-upstream.yml; upstream workflow files are dropped
  'scripts/repair-loon-vless.mjs',
  'scripts/sync-upstream.mjs',
  'src/test/loon-vless.test.mjs',
  'src/test/upstream-sync.test.mjs',
  'FORK.md',
];

function redact(text) {
  return String(text || '')
    .replace(/x-access-token:[^@\s]+/g, 'x-access-token:REDACTED')
    .replace(/https:\/\/[^@\s/]+@/g, 'https://REDACTED@');
}

function fail(message) {
  const error = new Error('sync failed closed: ' + redact(message) + '\nmain was not pushed');
  error.exitCode = 1;
  return error;
}

function git(repo, args, { allowFail = false, config = [] } = {}) {
  const result = spawnSync('git', [
    '-C', repo,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'advice.detachedHead=false',
    ...config,
    ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (!allowFail && result.status !== 0) {
    throw fail('git ' + args.join(' ') + ' failed\n' + redact(result.stderr || result.stdout).trim());
  }
  return result;
}

function assertUpstream(url, allowFixture) {
  if (url === OFFICIAL_UPSTREAM) return;
  if (allowFixture && url && !url.includes('://')) return;
  if (allowFixture && typeof url === 'string' && url.startsWith('file:')) return;
  throw fail('refusing unexpected upstream URL');
}

function isProtected(file) {
  return PROTECTED.some(item => file === item || file.startsWith(item + '/'));
}

async function pathExists(repo, ref, file) {
  const result = git(repo, ['cat-file', '-e', ref + ':' + file], { allowFail: true });
  return result.status === 0;
}

function listFiles(repo, args) {
  const output = git(repo, args).stdout;
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

async function restoreProtected(repo) {
  const skipped = [];
  for (const file of PROTECTED) {
    if (!(await pathExists(repo, 'HEAD', file))) continue;
    git(repo, ['checkout', 'HEAD', '--', file]);
    git(repo, ['add', '--', file]);
  }
  const ours = new Set(listFiles(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', WORKFLOWS]));
  for (const file of listFiles(repo, ['ls-files', '--', WORKFLOWS])) {
    if (!ours.has(file)) {
      skipped.push(file);
      git(repo, ['rm', '-f', '--', file]);
    }
  }
  return skipped;
}

function resolveConflicts(repo) {
  const unmerged = listFiles(repo, ['diff', '--name-only', '--diff-filter=U']);
  const blocked = unmerged.filter(file => file !== ENGINE && !isProtected(file));
  if (blocked.length) {
    throw fail('merge conflict outside the Loon serializer and protected fork files:\n' + blocked.map(file => '- ' + file).join('\n'));
  }
  if (unmerged.includes(ENGINE)) {
    git(repo, ['checkout', '--theirs', '--', ENGINE]);
    git(repo, ['add', '--', ENGINE]);
  }
}

async function repairEngine(repo) {
  const file = join(repo, ENGINE);
  let info;
  try {
    info = await lstat(file);
  } catch {
    throw fail('upstream engine.mjs is missing; Loon serializer cannot be repaired');
  }
  if (info.isSymbolicLink() || !info.isFile()) throw fail('refusing to repair a non-regular src/engine.mjs');
  const original = await readFile(file, 'utf8');
  let result;
  try {
    result = repairLoonVlessSource(original);
  } catch (error) {
    if (error instanceof RepairError) throw fail(error.message);
    throw error;
  }
  if (result.status === 'repaired') await writeFile(file, result.source);
  git(repo, ['add', '--', ENGINE]);
  return result.status;
}

function strippedTestEnv(extra) {
  const env = { ...extra };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|AUTHORIZATION/i.test(key)) delete env[key];
  }
  delete env.GITHUB_OUTPUT;
  delete env.ACTIONS_RUNTIME_TOKEN;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  env.CFNEW_TEST_CORE = env.CFNEW_TEST_CORE || './test/core-fixture.mjs';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

async function defaultTestArgs(repo) {
  const names = (await readdir(join(repo, 'src/test'))).filter(name => name.endsWith('.test.mjs')).sort();
  if (!names.length) throw fail('no tests found');
  return ['node', '--test', ...names.map(name => join('src/test', name))];
}

async function runTests(repo, testArgs) {
  const args = testArgs || await defaultTestArgs(repo);
  const result = spawnSync(args[0], args.slice(1), {
    cwd: repo,
    encoding: 'utf8',
    env: strippedTestEnv(process.env),
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  if (output) process.stderr.write(output.endsWith('\n') ? output : output + '\n');
  if (result.status !== 0) {
    throw fail('tests failed (exit ' + result.status + '). The Actions log above is the diagnostic');
  }
}

async function prepare(repo, upstreamUrl, upstreamRef, pinnedSha, allowFixture) {
  assertUpstream(upstreamUrl, allowFixture);
  const dirty = git(repo, ['status', '--porcelain']).stdout.trim();
  if (dirty) throw fail('working tree is dirty');
  const baseSha = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
  const work = await mkdtemp(join(tmpdir(), 'cfnew-sync-'));
  git(repo, ['worktree', 'add', '--detach', work, baseSha]);
  try {
    const fetchConfig = [
      '-c', 'credential.helper=',
      '-c', 'http.extraheader=',
      '-c', 'http.https://github.com/.extraheader=',
    ];
    const ref = pinnedSha || upstreamRef;
    const fetched = git(work, [...fetchConfig, 'fetch', '--no-tags', '--no-recurse-submodules', upstreamUrl, ref], { allowFail: true, config: [] });
    if (fetched.status !== 0) {
      throw fail('could not fetch upstream ' + (pinnedSha || upstreamRef) + '\n' + (fetched.stderr || '').trim());
    }
    const upstreamSha = git(work, ['rev-parse', 'FETCH_HEAD']).stdout.trim();
    if (pinnedSha && upstreamSha !== pinnedSha) throw fail('fetched upstream commit did not match the tested commit');
    const ancestor = git(work, ['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], { allowFail: true });
    let merged = false;
    if (ancestor.status !== 0) {
      const merge = git(work, ['merge', '--no-commit', '--no-ff', 'FETCH_HEAD'], { allowFail: true });
      const merging = git(work, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true });
      if (merge.status !== 0 && merging.status !== 0) {
        throw fail('merge failed before conflicts could be inspected\n' + (merge.stderr || merge.stdout || '').trim());
      }
      merged = merging.status === 0;
      if (merged) resolveConflicts(work);
    }
    const skipped = await restoreProtected(work);
    const repair = await repairEngine(work);
    for (const file of PROTECTED) {
      if (!(await pathExists(work, baseSha, file))) continue;
      const diff = git(work, ['diff', '--exit-code', baseSha, '--', file], { allowFail: true });
      if (diff.status !== 0) throw fail('protected fork file would change: ' + file);
    }
    const tree = git(work, ['write-tree']).stdout.trim();
    const baseTree = git(work, ['rev-parse', baseSha + '^{tree}']).stdout.trim();
    return { work, baseSha, upstreamSha, tree, shouldPush: tree !== baseTree, merged, repair, skipped };
  } catch (error) {
    git(repo, ['worktree', 'remove', '--force', work], { allowFail: true });
    await rm(work, { recursive: true, force: true }).catch(() => {});
    git(repo, ['worktree', 'prune'], { allowFail: true });
    throw error;
  }
}

function commitResult(work, upstreamSha, merged) {
  const short = upstreamSha.slice(0, 12);
  const message = merged
    ? 'sync upstream ' + short + '\n\nMerge byJoey/cfnew-panel ' + upstreamSha + '.\nKeep the Loon VLESS positional quoted UUID.\nDo not import upstream workflow files.\n'
    : 'fix Loon VLESS credential serialization\n\nReapply the positional quoted UUID on an up-to-date main.\n';
  git(work, [
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', message,
  ], { config: [] });
  return git(work, ['rev-parse', 'HEAD']).stdout.trim();
}

export async function runSync(options) {
  const mode = options.mode;
  if (mode !== 'validate' && mode !== 'publish') throw fail('mode must be validate or publish');
  const event = options.eventName ?? process.env.GITHUB_EVENT_NAME ?? '';
  if (mode === 'publish' && event && event !== 'schedule' && event !== 'workflow_dispatch') {
    throw fail('refusing to publish from GitHub event ' + event);
  }
  const repo = resolve(options.repo || process.cwd());
  const upstreamUrl = options.upstreamUrl || OFFICIAL_UPSTREAM;
  const upstreamRef = options.upstreamRef || OFFICIAL_REF;
  if (mode === 'publish') {
    if (!options.baseSha || !options.upstreamSha || !options.expectTree) throw fail('publish is missing the validated commit, tree, or base');
    const fetched = git(repo, ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { allowFail: true });
    if (fetched.status !== 0) throw fail('could not fetch origin/main before publishing');
    const remoteMain = git(repo, ['rev-parse', 'origin/main']).stdout.trim();
    if (remoteMain !== options.baseSha) throw fail('origin/main moved after validation (' + remoteMain + ')');
    const local = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    if (local !== options.baseSha) throw fail('checkout HEAD is not the validated base');
  }
  const prepared = await prepare(repo, upstreamUrl, upstreamRef, mode === 'publish' ? options.upstreamSha : '', Boolean(options.allowFixture));
  try {
    if (!prepared.shouldPush) {
      return { ...prepared, pushed: false };
    }
    if (mode === 'validate') {
      await runTests(prepared.work, options.testArgs);
      return { ...prepared, pushed: false };
    }
    if (prepared.tree !== options.expectTree) throw fail('rebuilt tree does not match the tested tree');
    const sha = commitResult(prepared.work, prepared.upstreamSha, prepared.merged);
    const tree = git(prepared.work, ['rev-parse', sha + '^{tree}']).stdout.trim();
    if (tree !== options.expectTree) throw fail('commit tree does not match the tested tree');
    const ancestor = git(repo, ['merge-base', '--is-ancestor', options.baseSha, sha], { allowFail: true });
    if (ancestor.status !== 0) throw fail('refusing a push that is not a fast-forward of the validated base');
    const remoteTip = git(repo, ['ls-remote', 'origin', 'refs/heads/main']).stdout.trim().split(/\s+/)[0];
    if (remoteTip !== options.baseSha) throw fail('origin/main moved before the push');
    git(repo, ['push', 'origin', sha + ':refs/heads/main']);
    return { ...prepared, commit: sha, pushed: true };
  } finally {
    git(repo, ['worktree', 'remove', '--force', prepared.work], { allowFail: true });
    await rm(prepared.work, { recursive: true, force: true }).catch(() => {});
    git(repo, ['worktree', 'prune'], { allowFail: true });
  }
}

function writeOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  if (!/^[A-Za-z0-9_-]+$/.test(key) || /[\r\n]/.test(String(value))) throw fail('refusing to write an unsafe Actions output');
  spawnSync('sh', ['-c', 'printf "%s=%s\\n" "$1" "$2" >> "$GITHUB_OUTPUT"', 'output', key, String(value)], {
    encoding: 'utf8',
    env: process.env,
  });
}

async function main() {
  const mode = process.argv[2];
  const result = await runSync({
    mode,
    repo: process.env.SYNC_REPO || process.cwd(),
    upstreamUrl: process.env.UPSTREAM_URL || OFFICIAL_UPSTREAM,
    upstreamRef: process.env.UPSTREAM_REF || OFFICIAL_REF,
    allowFixture: process.env.SYNC_ALLOW_FIXTURE === '1',
    baseSha: process.env.BASE_SHA,
    upstreamSha: process.env.UPSTREAM_SHA,
    expectTree: process.env.EXPECT_TREE,
  });
  process.stderr.write([
    'upstream ' + result.upstreamSha,
    'base ' + result.baseSha,
    'tree ' + result.tree,
    'repair ' + result.repair,
    'should_push ' + result.shouldPush,
    result.skipped && result.skipped.length ? 'skipped upstream workflows: ' + result.skipped.join(', ') : 'skipped upstream workflows: none',
    result.pushed ? 'pushed ' + result.commit : 'main was not pushed',
  ].join('\n') + '\n');
  writeOutput('should_push', result.shouldPush ? 'true' : 'false');
  writeOutput('upstream_sha', result.upstreamSha);
  writeOutput('tree', result.tree);
  writeOutput('base_sha', result.baseSha);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  main().catch(error => {
    process.stderr.write((error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = error && error.exitCode ? error.exitCode : 1;
  });
}
