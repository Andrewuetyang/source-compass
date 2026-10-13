import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import type { Repository } from './types.js';

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  // Ignore inherited repository overrides: queries must describe cwd, not the agent's shell repo.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT' && key !== 'GIT_OPTIONAL_LOCKS') delete env[key as keyof typeof env];
  }
  const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 1024 * 1024, env });
  return stdout.trim();
}

export function redactRemote(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw.replace(/^[^/@\s]+@(?=[^:]+:)/, '').replace(/[?#].*$/, '');
  }
}

export function remoteKey(raw: string): string {
  const normalized = redactRemote(raw).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^([^/]+):(?=[^/])/, '$1/')
    .replace(/\/+$/, '').replace(/\.git$/, '');
  // Hostnames are case-insensitive; repository paths need not be.
  return normalized.replace(/^[^/]+/, host => host.toLowerCase());
}

export async function readRepository(cwd: string): Promise<Repository> {
  const output = await git(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  const [root, gitDir, common] = output.split('\n');
  if (!root || !gitDir || !common) throw new Error('Invalid git rev-parse response');
  const commonDir = resolve(cwd, common);
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  const remoteNames = (await git(cwd, ['remote'])).split('\n').filter(Boolean);
  const remotes = [];
  for (const name of remoteNames) {
    const url = await git(cwd, ['config', '--get', `remote.${name}.url`]).catch(() => '');
    if (url) remotes.push({ name, url: redactRemote(url) });
  }
  return { path: root, name: basename(root), gitDir, commonDir, kind: resolve(gitDir) === commonDir ? 'repository' : 'worktree', branch, remotes };
}
