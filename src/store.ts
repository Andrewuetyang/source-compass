import { mkdir, open, readFile, rename, rm, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { expandPath } from './paths.js';
import { DEFAULT_EXCLUDES } from './scanner.js';
import { ResolverError, type State } from './types.js';

export function emptyState(): State {
  return { schemaVersion: 1, revision: 0, config: { roots: [], excludes: [...DEFAULT_EXCLUDES], maxDepth: 12 },
    snapshot: { scannedAt: null, repositories: [], packages: [], issues: [], visitedDirectories: 0 }, mappings: [], history: [] };
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every(y => typeof y === 'string');
const absolute = (x: unknown): x is string => typeof x === 'string' && isAbsolute(x);
const nullableString = (x: unknown) => x === null || typeof x === 'string';
const unique = (items: { path: string }[]) => new Set(items.map(x => x.path)).size === items.length;

/** Validate all fields used by the CLI before accepting a manually edited JSON file. */
export function validateState(value: unknown): asserts value is State {
  if (object(value) && value.schemaVersion !== 1) throw new ResolverError('SCHEMA_VERSION', `Unsupported state schemaVersion: ${String(value.schemaVersion)}. Expected 1.`);
  const bad = () => { throw new ResolverError('INVALID_STATE', 'State JSON has an invalid structure. Restore state.json.bak or correct the fields; it has not been overwritten.'); };
  if (!object(value)) return bad();
  const { config, snapshot, mappings, history } = value;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !object(config) || !object(snapshot)) return bad();
  if (!strings(config.roots) || !config.roots.every(absolute) || !strings(config.excludes) || config.excludes.some(x => !x || /[\\/]/.test(x)) ||
      !Number.isInteger(config.maxDepth) || (config.maxDepth as number) < 0 || (config.maxDepth as number) > 100) return bad();
  if (!nullableString(snapshot.scannedAt) || !Number.isInteger(snapshot.visitedDirectories) || (snapshot.visitedDirectories as number) < 0) return bad();
  if (!Array.isArray(snapshot.repositories) || !snapshot.repositories.every(r => object(r) && absolute(r.path) && absolute(r.gitDir) && absolute(r.commonDir) &&
      typeof r.name === 'string' && ['repository', 'worktree'].includes(r.kind as string) && nullableString(r.branch) &&
      Array.isArray(r.remotes) && r.remotes.every(m => object(m) && typeof m.name === 'string' && typeof m.url === 'string'))) return bad();
  if (!Array.isArray(snapshot.packages) || !snapshot.packages.every(p => object(p) && typeof p.name === 'string' && p.name.trim() && absolute(p.path) &&
      absolute(p.manifestPath) && (p.repositoryPath === null || absolute(p.repositoryPath)) && nullableString(p.version) && typeof p.private === 'boolean' && strings(p.workspaces))) return bad();
  if (!Array.isArray(snapshot.issues) || !snapshot.issues.every(i => object(i) && absolute(i.path) && typeof i.code === 'string' && typeof i.message === 'string' && typeof i.preserve === 'boolean')) return bad();
  if (!Array.isArray(mappings) || !mappings.every(m => object(m) && typeof m.name === 'string' && m.name.trim() && absolute(m.path) && typeof m.note === 'string' && typeof m.updatedAt === 'string')) return bad();
  if (!Array.isArray(history) || !history.every(h => object(h) && typeof h.at === 'string' && typeof h.action === 'string' && 'details' in h)) return bad();
  if (!unique(snapshot.repositories as State['snapshot']['repositories']) || !unique(snapshot.packages as State['snapshot']['packages']) ||
      new Set(mappings.map(m => m.name)).size !== mappings.length) return bad();
}

export class Store {
  readonly dir: string;
  readonly file: string;
  constructor(input = process.env.WORKSPACE_RESOLVER_HOME || join(homedir(), '.workspace-resolver')) {
    this.dir = expandPath(input);
    this.file = join(this.dir, 'state.json');
  }

  async read(optional = false): Promise<State> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (optional) return emptyState();
        throw new ResolverError('NOT_INITIALIZED', `No index at ${this.file}. Run init <scan-root> first.`);
      }
      throw new ResolverError('STATE_READ_FAILED', `Cannot read ${this.file}.`);
    }
    let state: unknown;
    try { state = JSON.parse(raw); }
    catch { throw new ResolverError('INVALID_STATE', `Invalid JSON in ${this.file}. Restore state.json.bak or fix the JSON; it has not been overwritten.`); }
    validateState(state);
    return state;
  }

  async transaction<T>(change: (state: State, canonicalDir: string) => Promise<T>, optional = false): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, '.lock');
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ResolverError('STORE_LOCKED', `Another writer holds ${lock}. Retry when it finishes. After a crashed process, inspect .lock/owner.json and remove .lock only after confirming that process has stopped.`);
      throw error;
    }
    try {
      await atomicWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const state = await this.read(optional);
      const result = await change(state, await realpath(this.dir));
      state.revision++;
      validateState(state);
      const previous = await readFile(this.file, 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return null;
      });
      if (previous !== null) await atomicWrite(`${this.file}.bak`, previous);
      await atomicWrite(this.file, `${JSON.stringify(state, null, 2)}\n`);
      return result;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
  } finally { await rm(temp, { force: true }); }
}

export function record(state: State, action: string, details: unknown): void {
  state.history.push({ at: new Date().toISOString(), action, details });
}
