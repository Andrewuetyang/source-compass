import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { scan, emptyState } from '../dist/index.js';
import { resolveSource } from '../dist/resolver.js';
import { remoteKey } from '../dist/git.js';
import { temporary, repository, manifest, git } from './helpers.mjs';

test('discovers monorepo packages, nested Git repos, subdirectory roots, and linked worktrees', async t => {
  const root = await temporary(t);
  const repo = join(root, '源码 with spaces');
  await repository(repo);
  await manifest(repo, { name: '@demo/root', private: true, workspaces: ['packages/*'] });
  const shared = join(repo, 'packages', 'shared');
  await manifest(shared, { name: '@demo/shared', version: '1.2.3' });
  const nested = join(repo, 'tools', 'nested');
  await repository(nested);
  await manifest(nested, { name: 'nested-tool' });
  await git(repo, 'remote', 'add', 'origin', 'https://user:SECRET@example.com/team/project.git?token=SECRET');
  await git(repo, 'add', 'package.json', 'packages');
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const worktree = join(root, 'worktree');
  await git(repo, 'worktree', 'add', '-b', 'feature', worktree);
  await manifest(join(root, 'standalone'), { name: 'standalone' });
  const snapshot = await scan({ ...emptyState().config, roots: [root] });
  assert.equal(snapshot.repositories.length, 3);
  assert.equal(snapshot.packages.length, 6);
  assert.equal(snapshot.issues.length, 0);
  const wt = snapshot.repositories.find(r => r.path === worktree);
  assert.equal(wt.kind, 'worktree');
  assert.equal(wt.branch, 'feature');
  assert.equal(wt.commonDir, join(repo, '.git'));
  assert.equal(snapshot.packages.find(p => p.name === 'nested-tool').repositoryPath, nested);
  assert.equal(snapshot.packages.find(p => p.path === shared).repositoryPath, repo);
  assert.equal(snapshot.packages.find(p => p.name === 'standalone').repositoryPath, null);
  assert.deepEqual(snapshot.packages.find(p => p.name === '@demo/root').workspaces, ['packages/*']);
  assert.equal(JSON.stringify(snapshot).includes('SECRET'), false);
  assert.equal(remoteKey('git@example.com:team/project.git'), remoteKey('https://example.com/team/project'));
  const state = { ...emptyState(), snapshot };
  assert.equal((await resolveSource(state, '@demo/shared')).status, 'ambiguous');
  assert.equal((await resolveSource(state, 'git@example.com:team/project.git')).candidates.length, 2);
  const subdirectory = await scan({ ...emptyState().config, roots: [shared] });
  assert.equal(subdirectory.repositories[0].path, repo);
  assert.equal(subdirectory.packages[0].repositoryPath, repo);
});

test('skips dependency/build folders and symlink loops, but descends ordinary and hidden folders', async t => {
  const root = await temporary(t);
  for (const name of ['node_modules', '.git', 'dist', 'build', 'vendor', '.next', 'custom-output']) {
    await manifest(join(root, name, 'ignored'), { name: `ignore-${name}` });
  }
  await manifest(join(root, '.sources', 'valid'), { name: 'hidden-source' });
  await manifest(join(root, 'packages', 'valid'), { name: 'visible-source' });
  await manifest(join(root, 'unnamed'), { private: true });
  await mkdir(join(root, 'bad'));
  await writeFile(join(root, 'bad', 'package.json'), '{broken');
  await symlink(root, join(root, 'loop'), 'dir');
  const snapshot = await scan({ ...emptyState().config, roots: [root], excludes: ['custom-output'] });
  assert.deepEqual(snapshot.packages.map(p => p.name), ['hidden-source', 'visible-source']);
  assert.ok(snapshot.issues.some(i => i.code === 'INVALID_MANIFEST'));
  assert.ok(snapshot.visitedDirectories < 15);
});

test('maxDepth warns at pruning points and missing roots fail rather than erase a snapshot', async t => {
  const root = await temporary(t);
  await manifest(join(root, 'a', 'b'), { name: 'deep' });
  const shallow = await scan({ ...emptyState().config, roots: [root], maxDepth: 1 });
  assert.equal(shallow.packages.length, 0);
  assert.equal(shallow.issues[0].code, 'MAX_DEPTH');
  await assert.rejects(scan({ ...emptyState().config, roots: [join(root, 'missing')] }), { code: 'INVALID_DIRECTORY' });
});

test('malformed manifests retain previous records; removed packages are pruned on rescan', async t => {
  const root = await temporary(t);
  const pkg = join(root, 'pkg');
  await manifest(pkg, { name: 'retained' });
  await manifest(join(pkg, 'child'), { name: 'removed-child' });
  const config = { ...emptyState().config, roots: [root] };
  const first = await scan(config);
  await writeFile(join(pkg, 'package.json'), '[]');
  await rm(join(pkg, 'child'), { recursive: true });
  const second = await scan(config, first);
  assert.equal(second.packages.length, 1);
  assert.equal(second.packages[0].name, 'retained');
  assert.equal(second.issues[0].preserve, true);
  await rm(pkg, { recursive: true });
  const third = await scan(config, second);
  assert.equal(third.packages.length, 0);
});

test('a broken nested Git marker prevents a package from inheriting the outer repository', async t => {
  const root = await temporary(t);
  await repository(root);
  const nested = join(root, 'nested');
  await manifest(nested, { name: 'broken-nested' });
  await writeFile(join(nested, '.git'), 'gitdir: /nonexistent-workspace-resolver-gitdir');
  const snapshot = await scan({ ...emptyState().config, roots: [root] });
  assert.ok(snapshot.issues.some(i => i.code === 'INVALID_GIT'));
  assert.equal(snapshot.packages[0].repositoryPath, null);
  const result = await resolveSource({ ...emptyState(), snapshot }, 'broken-nested');
  assert.equal(result.candidates[0].repository, null);
});

test('Git submodule files identify repositories, while detached linked worktrees remain worktrees', async t => {
  const temp = await temporary(t), root = join(temp, 'sources'), upstream = join(temp, 'upstream');
  await repository(upstream);
  await manifest(upstream, { name: 'submodule-package' });
  await git(upstream, 'add', 'package.json');
  await git(upstream, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  await repository(root);
  await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'submodule');
  await git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-am', 'fixture');
  const detached = join(temp, 'detached');
  await git(root, 'worktree', 'add', '--detach', detached);
  let snapshot = await scan({ ...emptyState().config, roots: [root] });
  assert.equal(snapshot.repositories.length, 2);
  assert.equal(snapshot.repositories.find(r => r.path === join(root, 'submodule')).kind, 'repository');
  assert.equal(snapshot.packages[0].repositoryPath, join(root, 'submodule'));
  snapshot = await scan({ ...emptyState().config, roots: [detached] });
  assert.equal(snapshot.repositories[0].kind, 'worktree');
  assert.equal(snapshot.repositories[0].branch, null);
});

test('an inherited GIT_DIR does not redirect the scan to another repository', async t => {
  const root = await temporary(t);
  const a = join(root, 'a'), b = join(root, 'b');
  await repository(a); await repository(b);
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = join(a, '.git');
  try {
    const snapshot = await scan({ ...emptyState().config, roots: [b] });
    assert.equal(snapshot.repositories[0].path, b);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
});
