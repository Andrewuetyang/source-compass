import { stat } from 'node:fs/promises';
import { remoteKey } from './git.js';
import { within } from './paths.js';
import type { Package, Repository, State } from './types.js';

export interface Candidate {
  path: string;
  exists: boolean;
  source: 'mapping' | 'package' | 'repository';
  package: Package | null;
  repository: Repository | null;
  note?: string;
}

export interface Resolution {
  query: string;
  status: 'resolved' | 'ambiguous' | 'not_found' | 'stale';
  candidates: Candidate[];
  scannedAt: string | null;
  issues: State['snapshot']['issues'];
}

async function candidate(state: State, path: string, source: Candidate['source'], pkg?: Package, note?: string): Promise<Candidate> {
  const sourcePackage = pkg ?? state.snapshot.packages.find(p => p.path === path) ?? null;
  let repository = sourcePackage ? state.snapshot.repositories.find(repo => repo.path === sourcePackage.repositoryPath) ?? null :
    [...state.snapshot.repositories].sort((a, b) => b.path.length - a.path.length).find(repo => within(repo.path, path)) ?? null;
  if (repository && state.snapshot.issues.some(issue => issue.code === 'INVALID_GIT' && within(issue.path, path) &&
      issue.path !== repository!.path && within(repository!.path, issue.path))) repository = null;
  const exists = await stat(path).then(info => info.isDirectory()).catch(() => false);
  return { path, exists, source, package: sourcePackage, repository, ...(note ? { note } : {}) };
}

export async function resolveSource(state: State, query: string): Promise<Resolution> {
  const mapping = state.mappings.find(m => m.name === query);
  let candidates: Candidate[];
  if (mapping) candidates = [await candidate(state, mapping.path, 'mapping', undefined, mapping.note)];
  else {
    const pkgs = state.snapshot.packages.filter(p => p.name === query || p.path === query);
    // npm package names take precedence over repository basenames.
    if (pkgs.length) candidates = await Promise.all(pkgs.map(p => candidate(state, p.path, 'package', p)));
    else {
      const repos = state.snapshot.repositories.filter(r => r.name === query || r.path === query || r.remotes.some(remote => remoteKey(remote.url) === remoteKey(query)));
      candidates = await Promise.all(repos.map(r => candidate(state, r.path, 'repository')));
    }
  }
  const status = !candidates.length ? 'not_found' : candidates.length > 1 ? 'ambiguous' : candidates[0]!.exists ? 'resolved' : 'stale';
  return { query, status, candidates, scannedAt: state.snapshot.scannedAt, issues: state.snapshot.issues };
}

export function search(state: State, query: string) {
  const lower = query.toLowerCase();
  return {
    packages: state.snapshot.packages.filter(p => `${p.name}\n${p.path}`.toLowerCase().includes(lower)),
    repositories: state.snapshot.repositories.filter(r => `${r.name}\n${r.path}\n${r.remotes.map(x => x.url).join('\n')}`.toLowerCase().includes(lower)),
    mappings: state.mappings.filter(m => `${m.name}\n${m.path}\n${m.note}`.toLowerCase().includes(lower))
  };
}
