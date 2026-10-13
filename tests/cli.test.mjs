import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../dist/index.js';
import { temporary, manifest, cli, exec } from './helpers.mjs';

test('CLI resolves duplicates, persists overrides and history, refreshes scans, and reports stale overrides', async t => {
  const temp = await temporary(t);
  const root = join(temp, 'sources'), store = join(temp, 'index');
  const a = join(root, 'a with spaces'), b = join(root, 'b');
  await manifest(a, { name: '@demo/shared' });
  await manifest(b, { name: '@demo/shared' });
  const initialized = await cli(store, ['init', root]);
  assert.equal(initialized.data.packages, 2);
  const ambiguous = await cli(store, ['resolve', '@demo/shared'], 3);
  assert.equal(ambiguous.data.status, 'ambiguous');
  await cli(store, ['map', 'set', '@demo/shared', b, '--note', 'Use the current checkout']);
  const resolved = await cli(store, ['resolve', '@demo/shared']);
  assert.equal(resolved.data.candidates[0].path, b);
  assert.equal(resolved.data.candidates[0].source, 'mapping');
  await cli(store, ['scan']);
  await cli(store, ['init', root]);
  assert.equal((await cli(store, ['map', 'list'])).data.length, 1);
  const history = (await cli(store, ['history'])).data;
  assert.ok(history.some(h => h.action === 'map.set' && h.details.after.note === 'Use the current checkout'));
  assert.equal((await cli(store, ['search', 'shared'])).data.packages.length, 2);
  await rm(b, { recursive: true });
  assert.equal((await cli(store, ['resolve', '@demo/shared'], 4)).data.status, 'stale');
  await cli(store, ['scan']);
  assert.equal((await cli(store, ['resolve', '@demo/shared'], 4)).data.status, 'stale');
  await cli(store, ['map', 'unset', '@demo/shared']);
  assert.equal((await cli(store, ['resolve', '@demo/shared'])).data.candidates[0].path, a);
  assert.equal((await cli(store, ['resolve', 'missing'], 2)).data.status, 'not_found');
  assert.equal((await cli(store, ['status'])).data.duplicates.length, 0);
});

test('roots are canonicalized and compacted; remove reindexes without changing mappings', async t => {
  const temp = await temporary(t), store = join(temp, 'index');
  const a = join(temp, 'a'), b = join(temp, 'b');
  await manifest(join(a, 'pkg'), { name: 'a' });
  await manifest(b, { name: 'b' });
  await cli(store, ['init', join(a, 'pkg')]);
  await cli(store, ['roots', 'add', a, b]);
  const roots = (await cli(store, ['roots', 'list'])).data.roots;
  assert.deepEqual(roots, [a, b]);
  await cli(store, ['map', 'set', 'alias', b]);
  await cli(store, ['roots', 'remove', b]);
  assert.equal((await cli(store, ['list'])).data.length, 1);
  assert.equal((await cli(store, ['resolve', 'alias'])).data.candidates[0].path, b);
  const before = await readFile(join(store, 'state.json'), 'utf8');
  assert.equal((await cli(store, ['roots', 'remove', a], 1)).error.code, 'NO_ROOTS');
  assert.equal(await readFile(join(store, 'state.json'), 'utf8'), before);
});

test('failed scans roll back changes; malformed state is not overwritten; backups contain the previous revision', async t => {
  const temp = await temporary(t), store = join(temp, 'index'), root = join(temp, 'sources');
  await manifest(root, { name: 'fixture' });
  await cli(store, ['init', root]);
  const original = await readFile(join(store, 'state.json'), 'utf8');
  await cli(store, ['map', 'set', 'alias', root]);
  assert.equal(await readFile(join(store, 'state.json.bak'), 'utf8'), original);
  const beforeMissing = await readFile(join(store, 'state.json'), 'utf8');
  await rm(root, { recursive: true });
  assert.equal((await cli(store, ['scan', '--max-depth', '3'], 1)).error.code, 'INVALID_DIRECTORY');
  assert.equal(await readFile(join(store, 'state.json'), 'utf8'), beforeMissing);
  await writeFile(join(store, 'state.json'), '{broken');
  assert.equal((await cli(store, ['scan'], 1)).error.code, 'INVALID_STATE');
  assert.equal(await readFile(join(store, 'state.json'), 'utf8'), '{broken');
  const bad = JSON.parse(original); bad.config.maxDepth = -1;
  await writeFile(join(store, 'state.json'), JSON.stringify(bad));
  assert.equal((await cli(store, ['status'], 1)).error.code, 'INVALID_STATE');
  bad.schemaVersion = 2;
  await writeFile(join(store, 'state.json'), JSON.stringify(bad));
  assert.equal((await cli(store, ['status'], 1)).error.code, 'SCHEMA_VERSION');
});

test('concurrent JSON writers fail clearly and leave a valid index', async t => {
  const temp = await temporary(t), dir = join(temp, 'index');
  const store = new Store(dir);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const first = store.transaction(async state => { entered(); await gate; state.history.push({ at: 'now', action: 'fixture', details: null }); }, true);
  await ready;
  try {
    await assert.rejects(new Store(dir).transaction(async () => {}, true), { code: 'STORE_LOCKED' });
  } finally { release(); }
  await first;
  assert.equal((await store.read()).revision, 1);
});

test('JSON command errors and option validation are deterministic', async t => {
  const temp = await temporary(t), root = join(temp, 'sources'), store = join(temp, 'index');
  await mkdir(root);
  assert.equal((await cli(store, ['status'], 1)).error.code, 'NOT_INITIALIZED');
  for (const args of [['init', root, '--max-depth', '2x'], ['init', root, '--max-depth', '101'], ['init', root, '--exclude', 'a/b'], ['resolve', 'x', '--max-depth', '1'], ['map', 'set', 'x'], ['unknown']]) {
    assert.equal((await cli(store, args, 1)).error.code, 'USAGE');
  }
  assert.equal((await cli(store, ['init', store], 1)).error.code, 'STORE_OVERLAP');
});

test('installed skill runs from any cwd with a bundled runtime and refuses to overwrite an existing skill', async t => {
  const temp = await temporary(t), root = join(temp, 'sources'), store = join(temp, 'index');
  await manifest(root, { name: 'from-skill' });
  await cli(store, ['init', root]);
  const target = join(temp, 'skills', 'source-compass');
  const installed = await cli(store, ['skill', 'install', '--target', target]);
  assert.equal(installed.data.runtimeBundled, true);
  const codexHome = join(temp, 'codex-home');
  const defaultInstall = await cli(store, ['skill', 'install'], 0, { env: { ...process.env, CODEX_HOME: codexHome } });
  assert.equal(defaultInstall.data.path, join(codexHome, 'skills', 'source-compass'));
  // Move the installed skill to ensure no baked-in paths to its installation are required.
  const moved = join(temp, 'moved-skill');
  await cp(target, moved, { recursive: true });
  const result = await exec(process.execPath, [join(moved, 'scripts', 'source-compass.mjs'), 'resolve', 'from-skill', '--json'], {
    cwd: temp, env: { ...process.env, WORKSPACE_RESOLVER_HOME: store }
  });
  assert.equal(JSON.parse(result.stdout).data.candidates[0].path, root);
  const defaultResult = await exec(process.execPath, [join(defaultInstall.data.path, 'scripts', 'source-compass.mjs'), 'resolve', 'from-skill', '--store', store, '--json'], { cwd: temp });
  assert.equal(JSON.parse(defaultResult.stdout).data.candidates[0].path, root);
  assert.equal((await cli(store, ['skill', 'install', '--target', target], 1)).error.code, 'SKILL_EXISTS');
});

test('release metadata follows the package version in the CLI and the bundled skill', async t => {
  const temp = await temporary(t), project = join(temp, 'package');
  await manifest(project, { name: 'source-compass', version: '9.8.7', type: 'module' });
  await cp(new URL('../dist', import.meta.url), join(project, 'dist'), { recursive: true });
  await cp(new URL('../skills', import.meta.url), join(project, 'skills'), { recursive: true });
  await cp(new URL('../LICENSE', import.meta.url), join(project, 'LICENSE'));
  const entry = join(project, 'dist', 'cli.js');
  const version = await exec(process.execPath, [entry, '--version', '--json']);
  assert.equal(JSON.parse(version.stdout).data.version, '9.8.7');
  const help = await exec(process.execPath, [entry, '--help']);
  assert.ok(help.stdout.includes('SourceCompass 9.8.7'));
  const target = join(temp, 'installed-skill');
  await exec(process.execPath, [entry, 'skill', 'install', '--target', target]);
  const skillVersion = await exec(process.execPath, [join(target, 'scripts', 'source-compass.mjs'), '--version', '--json']);
  assert.equal(JSON.parse(skillVersion.stdout).data.version, '9.8.7');
  assert.equal(await readFile(join(target, 'LICENSE'), 'utf8'), await readFile(new URL('../LICENSE', import.meta.url), 'utf8'));
});
