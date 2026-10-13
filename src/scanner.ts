import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directory, within } from './paths.js';
import { git, readRepository } from './git.js';
import { ResolverError, type Package, type Repository, type Snapshot, type State } from './types.js';

export const DEFAULT_EXCLUDES = ['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.turbo', 'vendor', '.workspace-resolver'];
const MAX_DIRECTORIES = 100_000;

export async function scan(config: State['config'], previous?: Snapshot, storePath?: string): Promise<Snapshot> {
  // A missing configured root aborts the transaction, rather than erasing its index.
  for (const root of config.roots) await directory(root);
  await git(config.roots[0]!, ['--version']).catch(() => {
    throw new ResolverError('GIT_UNAVAILABLE', 'Git is required for scanning. Install Git and ensure it is on PATH.');
  });
  const snapshot: Snapshot = { scannedAt: new Date().toISOString(), repositories: [], packages: [], issues: [], visitedDirectories: 0 };
  const repos = new Map<string, Repository>();
  const packages = new Map<string, Package>();
  const excluded = new Set([...DEFAULT_EXCLUDES, ...config.excludes]);
  const visited = new Set<string>();
  const pending = config.roots.map(path => ({ path, depth: 0 }));
  // Scanning a package subdirectory still associates it with its containing Git repository.
  for (const root of config.roots) {
    const repo = await readRepository(root).catch(() => null);
    if (repo) repos.set(repo.path, repo);
  }
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const { path, depth } = pending[cursor]!;
    if (visited.has(path) || (storePath && within(storePath, path))) continue;
    visited.add(path);
    if (++snapshot.visitedDirectories > MAX_DIRECTORIES) {
      throw new ResolverError('SCAN_LIMIT', `Scan exceeded ${MAX_DIRECTORIES} directories. Use narrower roots or additional --exclude names.`);
    }
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch {
      snapshot.issues.push({ path, code: 'UNREADABLE_DIRECTORY', message: 'Cannot read directory; previous entries retained.', preserve: true });
      continue;
    }
    if (entries.some(entry => entry.name === '.git' && !entry.isSymbolicLink())) {
      try {
        const repo = await readRepository(path);
        // Broken nested .git markers must not silently inherit the outer repository.
        if (repo.path !== path) throw new Error('Git marker does not identify this directory');
        repos.set(path, repo);
      } catch {
        snapshot.issues.push({ path, code: 'INVALID_GIT', message: 'Cannot inspect Git metadata (check .git and Git ownership permissions).', preserve: true });
      }
    }
    const manifest = entries.find(entry => entry.name === 'package.json' && entry.isFile());
    if (manifest) {
      try {
        const data: unknown = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        const pkg = data as Record<string, unknown>;
        if (typeof pkg.name === 'string' && pkg.name.trim()) {
          const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces as { packages?: unknown } | null)?.packages;
          packages.set(path, { name: pkg.name, path, manifestPath: join(path, 'package.json'), repositoryPath: null,
            version: typeof pkg.version === 'string' ? pkg.version : null, private: pkg.private === true,
            workspaces: Array.isArray(workspaces) ? workspaces.filter((x): x is string => typeof x === 'string') : [] });
        }
      } catch {
        snapshot.issues.push({ path, code: 'INVALID_MANIFEST', message: 'Cannot parse package.json; previous entries retained.', preserve: true });
      }
    }
    const children = entries.filter(entry => entry.isDirectory() && !excluded.has(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (depth >= config.maxDepth) {
      if (children.length) snapshot.issues.push({ path, code: 'MAX_DEPTH', message: `Stopped at maxDepth=${config.maxDepth}; deeper entries are not indexed.`, preserve: false });
    } else {
      for (const child of children) pending.push({ path: join(path, child.name), depth: depth + 1 });
    }
  }
  const unreadable = snapshot.issues.filter(issue => issue.preserve);
  const retain = (path: string) => config.roots.some(root => within(root, path)) && unreadable.some(issue =>
    issue.code === 'INVALID_MANIFEST' ? issue.path === path : within(issue.path, path));
  for (const repo of previous?.repositories ?? []) if (!repos.has(repo.path) && retain(repo.path)) repos.set(repo.path, repo);
  for (const pkg of previous?.packages ?? []) if (!packages.has(pkg.path) && retain(pkg.path)) packages.set(pkg.path, pkg);
  const byDepth = [...repos.values()].sort((a, b) => b.path.length - a.path.length);
  for (const pkg of packages.values()) {
    const repo = byDepth.find(repo => within(repo.path, pkg.path));
    const blocked = repo && snapshot.issues.some(issue => issue.code === 'INVALID_GIT' && within(issue.path, pkg.path) &&
      issue.path !== repo.path && within(repo.path, issue.path));
    pkg.repositoryPath = repo && !blocked ? repo.path : null;
  }
  snapshot.repositories = [...repos.values()].sort((a, b) => a.path.localeCompare(b.path));
  snapshot.packages = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return snapshot;
}
