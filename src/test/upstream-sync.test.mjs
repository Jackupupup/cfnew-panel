import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSync } from '../../scripts/sync-upstream.mjs';

function git(repo, args) {
  const result = spawnSync('git', [
    '-C', repo,
    '-c', 'user.name=Sync Test',
    '-c', 'user.email=sync-test@example.com',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    ...args,
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(args.join(' ') + '\n' + result.stderr + result.stdout);
  return result.stdout.trim();
}

function engineSource(ident, kind) {
  const credential = kind === 'fixed'
    ? '`"' + '${' + ident + '.uuid}"`, `udp=true`, `transport=ws`'
    : '`udp=true`, `username=' + '${' + ident + '.uuid}`, `transport=ws`';
  return [
    'export const marker = ' + JSON.stringify(kind + ':' + ident) + ';',
    'const parts = [`${' + ident + '.server}`, `${' + ident + '.port}`, ' + credential + ', `path=${' + ident + '.path}`, `over-tls=${' + ident + '.tls}`];',
    'const trojan = [`password=${' + ident + '.password}`];',
    '',
  ].join('\n');
}

function checkArgs(ident) {
  const script = [
    "import fs from 'node:fs';",
    "const text = fs.readFileSync('src/engine.mjs', 'utf8');",
    "if (text.includes('username=')) { console.error('username remains'); process.exit(2); }",
    'const needle = \'"${\' + ' + JSON.stringify(ident) + ' + \'.uuid}"\';',
    "if (!text.includes(needle)) { console.error('missing ' + needle); process.exit(3); }",
    'if (!text.includes(\'password=${\' + ' + JSON.stringify(ident) + ' + \'.password}\')) { console.error(\'trojan changed\'); process.exit(4); }',
  ].join('\n');
  return ['node', '--input-type=module', '-e', script];
}

async function writeRepoFile(repo, file, contents) {
  const path = join(repo, file);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
}

async function scene() {
  const root = await mkdtemp(join(tmpdir(), 'cfnew-sync-'));
  const upstream = join(root, 'upstream');
  const origin = join(root, 'origin.git');
  const fork = join(root, 'fork');
  await mkdir(upstream);
  git(upstream, ['init', '-b', 'main']);
  await writeRepoFile(upstream, 'src/engine.mjs', engineSource('node', 'broken'));
  await writeRepoFile(upstream, 'README.md', 'base\n');
  git(upstream, ['add', '.']);
  git(upstream, ['commit', '-m', 'base']);
  git(root, ['clone', upstream, 'fork']);
  await writeRepoFile(fork, '.github/workflows/sync-upstream.yml', 'name: Sync upstream\non: workflow_dispatch\npermissions: {}\n');
  await writeRepoFile(fork, 'scripts/sync-upstream.mjs', 'export const marker = "fork-script";\n');
  await writeRepoFile(fork, 'FORK.md', 'fork note\n');
  git(fork, ['add', '.']);
  git(fork, ['commit', '-m', 'fork files']);
  git(root, ['init', '--bare', '-b', 'main', 'origin.git']);
  git(fork, ['remote', 'set-url', 'origin', origin]);
  git(fork, ['push', '-u', 'origin', 'main']);
  return {
    root, upstream, origin, fork,
    originMain: () => git(origin, ['rev-parse', 'main']),
    show: file => git(origin, ['show', 'main:' + file]),
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

async function publish(setup, validated) {
  return runSync({
    mode: 'publish',
    repo: setup.fork,
    upstreamUrl: setup.upstream,
    allowFixture: true,
    eventName: 'workflow_dispatch',
    testArgs: checkArgs('node'),
    baseSha: validated.baseSha,
    upstreamSha: validated.upstreamSha,
    expectTree: validated.tree,
  });
}

test('sync repairs Loon credentials, drops upstream workflows, and fast-forwards only after tests', async () => {
  const setup = await scene();
  try {
    const before = setup.originMain();
    await writeRepoFile(setup.upstream, 'README.md', 'base\nupstream readme\n');
    await writeRepoFile(setup.upstream, '.github/workflows/evil.yml', 'name: evil\non:\n  pull_request_target:\npermissions:\n  contents: write\n');
    await writeRepoFile(setup.upstream, 'scripts/sync-upstream.mjs', 'export const marker = "replaced-by-upstream";\n');
    git(setup.upstream, ['add', '.']);
    git(setup.upstream, ['commit', '-m', 'upstream edit']);

    const validated = await runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('node'),
    });
    assert.equal(validated.shouldPush, true);
    assert.equal(validated.repair, 'repaired');
    assert.deepEqual(validated.skipped, ['.github/workflows/evil.yml']);
    assert.equal(setup.originMain(), before, 'validate must not push');

    const published = await publish(setup, validated);
    assert.equal(published.pushed, true);
    assert.notEqual(setup.originMain(), before);
    const engine = setup.show('src/engine.mjs');
    assert.equal(engine.includes('username='), false);
    assert.equal(engine.includes('`"${node.uuid}"`, `udp=true`, `transport=ws`'), true);
    assert.equal(engine.includes('password=${node.password}'), true);
    assert.equal(setup.show('README.md').includes('upstream readme'), true);
    assert.equal(setup.show('.github/workflows/sync-upstream.yml').includes('name: Sync upstream'), true);
    assert.equal(setup.show('scripts/sync-upstream.mjs'), 'export const marker = "fork-script";');
    assert.throws(() => setup.show('.github/workflows/evil.yml'), /does not exist/);
  } finally {
    await setup.cleanup();
  }
});

test('an engine conflict keeps upstream code and applies the credential repair once', async () => {
  const setup = await scene();
  try {
    await writeRepoFile(setup.fork, 'src/engine.mjs', engineSource('node', 'fixed'));
    git(setup.fork, ['add', '.']);
    git(setup.fork, ['commit', '-m', 'local fix']);
    git(setup.fork, ['push', 'origin', 'main']);
    await writeRepoFile(setup.upstream, 'src/engine.mjs', engineSource('nodeB', 'broken') + 'export const upstream = true;\n');
    git(setup.upstream, ['add', '.']);
    git(setup.upstream, ['commit', '-m', 'rewrite serializer']);
    const validated = await runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('nodeB'),
    });
    await publish(setup, validated);
    const engine = setup.show('src/engine.mjs');
    assert.equal(engine.includes('export const upstream = true;'), true);
    assert.equal(engine.includes('`"${nodeB.uuid}"`, `udp=true`, `transport=ws`'), true);
    assert.equal(engine.split('"${nodeB.uuid}"').length - 1, 1);
    assert.equal(engine.includes('username='), false);
    assert.equal(engine.includes('node.uuid'), false);
  } finally {
    await setup.cleanup();
  }
});

test('an upstream serializer that is already fixed is not quoted twice', async () => {
  const setup = await scene();
  try {
    await writeRepoFile(setup.fork, 'src/engine.mjs', engineSource('node', 'fixed'));
    git(setup.fork, ['add', '.']);
    git(setup.fork, ['commit', '-m', 'local fix']);
    git(setup.fork, ['push', 'origin', 'main']);
    await writeRepoFile(setup.upstream, 'src/engine.mjs', engineSource('nodeB', 'fixed'));
    git(setup.upstream, ['add', '.']);
    git(setup.upstream, ['commit', '-m', 'upstream fixed']);
    const validated = await runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('nodeB'),
    });
    assert.equal(validated.repair, 'unchanged');
    await publish(setup, validated);
    const engine = setup.show('src/engine.mjs');
    assert.equal(engine.includes('""${'), false);
    assert.equal(engine.split('"${nodeB.uuid}"').length - 1, 1);
  } finally {
    await setup.cleanup();
  }
});

test('drift, unrelated conflicts, failed tests, and a moved main do not push', async () => {
  const setup = await scene();
  try {
    const before = setup.originMain();
    await writeRepoFile(setup.upstream, 'src/engine.mjs', 'export const format = "different";\n');
    git(setup.upstream, ['add', '.']);
    git(setup.upstream, ['commit', '-m', 'drift']);
    await assert.rejects(runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('node'),
    }), /serializer not found|refusing to guess/);
    assert.equal(setup.originMain(), before);

    git(setup.upstream, ['reset', '--hard', 'HEAD~1']);
    await writeRepoFile(setup.upstream, 'README.md', 'upstream readme\n');
    git(setup.upstream, ['add', '.']);
    git(setup.upstream, ['commit', '-m', 'readme']);
    await writeRepoFile(setup.fork, 'README.md', 'fork readme\n');
    git(setup.fork, ['add', '.']);
    git(setup.fork, ['commit', '-m', 'fork readme']);
    git(setup.fork, ['push', 'origin', 'main']);
    const conflicted = setup.originMain();
    await assert.rejects(runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('node'),
    }), /merge conflict/);
    assert.equal(setup.originMain(), conflicted);

    git(setup.fork, ['reset', '--hard', 'HEAD~1']);
    git(setup.fork, ['push', '--force', 'origin', 'main']);
    git(setup.upstream, ['reset', '--hard', 'HEAD~1']);
    await writeRepoFile(setup.upstream, 'README.md', 'base\nnotes\n');
    git(setup.upstream, ['add', '.']);
    git(setup.upstream, ['commit', '-m', 'notes']);
    const stable = setup.originMain();
    await assert.rejects(runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: ['node', '-e', 'process.exit(1)'],
    }), /tests failed/);
    assert.equal(setup.originMain(), stable);

    const validated = await runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('node'),
    });
    await assert.rejects(runSync({
      mode: 'publish',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      baseSha: validated.baseSha,
      upstreamSha: validated.upstreamSha,
      expectTree: 'a'.repeat(40),
      eventName: 'schedule',
    }), /does not match the tested tree/);
    assert.equal(setup.originMain(), stable);
    await writeRepoFile(setup.fork, 'README.md', 'moved\n');
    git(setup.fork, ['add', '.']);
    git(setup.fork, ['commit', '-m', 'move main']);
    git(setup.fork, ['push', 'origin', 'main']);
    await assert.rejects(runSync({
      mode: 'publish',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      baseSha: validated.baseSha,
      upstreamSha: validated.upstreamSha,
      expectTree: validated.tree,
      eventName: 'schedule',
    }), /origin\/main moved/);
    await assert.rejects(runSync({
      mode: 'publish',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      baseSha: validated.baseSha,
      upstreamSha: validated.upstreamSha,
      expectTree: validated.tree,
      eventName: 'pull_request_target',
    }), /refusing to publish/);
  } finally {
    await setup.cleanup();
  }
});

test('an up-to-date fork with the repair already applied does not push', async () => {
  const setup = await scene();
  try {
    await writeRepoFile(setup.fork, 'src/engine.mjs', engineSource('node', 'fixed'));
    git(setup.fork, ['add', '.']);
    git(setup.fork, ['commit', '-m', 'already fixed']);
    git(setup.fork, ['push', 'origin', 'main']);
    const before = setup.originMain();
    const validated = await runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: setup.upstream,
      allowFixture: true,
      testArgs: checkArgs('node'),
    });
    assert.equal(validated.shouldPush, false);
    assert.equal(validated.repair, 'unchanged');
    assert.equal(setup.originMain(), before);
  } finally {
    await setup.cleanup();
  }
});

test('the sync refuses a non-local upstream unless it is the official repository', async () => {
  const setup = await scene();
  try {
    await assert.rejects(runSync({
      mode: 'validate',
      repo: setup.fork,
      upstreamUrl: 'https://example.com/other.git',
      allowFixture: true,
    }), /unexpected upstream/);
  } finally {
    await setup.cleanup();
  }
});
