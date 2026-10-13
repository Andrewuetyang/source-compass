import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const exec = promisify(execFile);
export const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

export async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'workspace-resolver-'));
  // macOS /var is a symlink; fixtures should use canonical paths like the scanner.
  const { realpath } = await import('node:fs/promises');
  const canonical = await realpath(path);
  t.after(() => rm(canonical, { recursive: true, force: true }));
  return canonical;
}

export async function manifest(path, data) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'package.json'), JSON.stringify(data));
}

export async function git(path, ...args) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return (await exec('git', ['-C', path, ...args], { env })).stdout.trim();
}

export async function repository(path) {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-b', 'main');
}

export async function cli(store, args, expected = 0, options = {}) {
  let result;
  try { result = await exec(process.execPath, [cliPath, ...args, '--store', store, '--json'], options); }
  catch (error) { result = error; }
  const { default: assert } = await import('node:assert/strict');
  assert.equal(result.code ?? 0, expected, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}
