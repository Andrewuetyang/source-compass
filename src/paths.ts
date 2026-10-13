import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { ResolverError } from './types.js';

export function expandPath(input: string): string {
  return resolve(input === '~' ? homedir() : input.startsWith('~/') ? resolve(homedir(), input.slice(2)) : input);
}

export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function directory(input: string): Promise<string> {
  const full = expandPath(input);
  try {
    const canonical = await realpath(full);
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new ResolverError('INVALID_DIRECTORY', `Directory does not exist or cannot be read: ${full}`);
  }
}

export function compactRoots(roots: string[]): string[] {
  return [...new Set(roots)].sort().filter((root, _, all) => !all.some(other => other !== root && within(other, root)));
}
