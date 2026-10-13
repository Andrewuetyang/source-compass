#!/usr/bin/env node
import { expandPath, directory, compactRoots, within } from './paths.js';
import { Store, record } from './store.js';
import { scan } from './scanner.js';
import { resolveSource, search } from './resolver.js';
import { installSkill } from './skill.js';
import { ResolverError, type State } from './types.js';
import { VERSION } from './metadata.js';

const HELP = `SourceCompass ${VERSION} — locate local source code for AI agents

Usage: source-compass <command> [arguments] [--json] [--store <directory>]
Alias: workspace-resolver

  init <root...>          Register roots and scan (repeatable; retains mappings)
  scan                   Rescan every registered root
  roots list             Show scan configuration
  roots add <root...>     Add roots and rescan
  roots remove <root...>  Remove roots and rescan
  list [packages|repos]   List indexed packages or repositories
  search <text>          Search names, paths, and remote URLs
  resolve <name|url|path> Resolve exact npm name, repository name, URL, or path
  map list               Show manual mappings
  map set <name> <path>   Override source location; optional --note <text>
  map unset <name>        Remove an override
  history                Show recorded changes
  status                 Show roots, counts, duplicates, and scan issues
  skill install          Install a self-contained Codex skill
                         --target <folder> supports other skill directories

Scan options (init/scan): --max-depth <0..100> (default 12), --exclude <directory-name>
                         --exclude is repeatable; settings persist in state.json
Store: --store > WORKSPACE_RESOLVER_HOME > ~/.workspace-resolver
Query exit codes: 0 resolved; 2 not found; 3 ambiguous; 4 stale; 1 command error.
Use -- before positional arguments that start with a dash.
`;

interface Arguments {
  words: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
}

function parse(argv: string[]): Arguments {
  const words: string[] = [], flags = new Set<string>(), values = new Map<string, string[]>();
  const boolean = new Set(['--json', '--help', '-h', '--version', '-v']);
  const valued = new Set(['--store', '--max-depth', '--exclude', '--note', '--target']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') { words.push(...argv.slice(i + 1)); break; }
    if (boolean.has(token)) flags.add(token);
    else if (valued.has(token)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new ResolverError('USAGE', `Expected a value after ${token}.`);
      const current = values.get(token) ?? [];
      if (current.length && token !== '--exclude') throw new ResolverError('USAGE', `${token} may only be specified once.`);
      current.push(value); values.set(token, current);
    } else if (token.startsWith('-')) throw new ResolverError('USAGE', `Unknown option: ${token}`);
    else words.push(token);
  }
  return { words, flags, values };
}

function count(args: string[], min: number, max = min) {
  if (args.length < min || args.length > max) throw new ResolverError('USAGE', 'Incorrect arguments. Run source-compass --help for usage.');
}

function allowOptions(parsed: Arguments, allowed: string[]) {
  for (const name of parsed.values.keys()) if (name !== '--store' && !allowed.includes(name)) throw new ResolverError('USAGE', `${name} is not supported for this command.`);
}

function configure(state: State, parsed: Arguments) {
  const depth = parsed.values.get('--max-depth')?.[0];
  if (depth !== undefined) {
    if (!/^\d+$/.test(depth) || Number(depth) > 100) throw new ResolverError('USAGE', '--max-depth must be an integer from 0 to 100.');
    state.config.maxDepth = Number(depth);
  }
  for (const name of parsed.values.get('--exclude') ?? []) {
    if (!name || /[\\/]/.test(name)) throw new ResolverError('USAGE', '--exclude accepts directory basenames, not paths or glob patterns.');
    if (!state.config.excludes.includes(name)) state.config.excludes.push(name);
  }
}

async function rescan(state: State, canonicalStore: string) {
  if (!state.config.roots.length) throw new ResolverError('NO_ROOTS', 'At least one scan root is required. Run init <root>.');
  if (state.config.roots.some(root => within(canonicalStore, root))) throw new ResolverError('STORE_OVERLAP', 'A scan root cannot be inside the state directory. Choose a separate --store directory.');
  const before = { repositories: state.snapshot.repositories.length, packages: state.snapshot.packages.length };
  state.snapshot = await scan(state.config, state.snapshot, canonicalStore);
  const result = { roots: state.config.roots, scannedAt: state.snapshot.scannedAt, repositories: state.snapshot.repositories.length,
    packages: state.snapshot.packages.length, visitedDirectories: state.snapshot.visitedDirectories, issues: state.snapshot.issues };
  record(state, 'scan', { before, ...result });
  return result;
}

async function execute(parsed: Arguments): Promise<{ data: unknown; exitCode?: number }> {
  const [command, ...args] = parsed.words;
  const store = new Store(parsed.values.get('--store')?.[0]);
  if (command === 'init' || command === 'scan') {
    allowOptions(parsed, ['--exclude', '--max-depth']);
    count(args, command === 'init' ? 1 : 0, command === 'init' ? Infinity : 0);
    return { data: await store.transaction(async (state, canonicalStore) => {
      if (command === 'init') {
        state.config.roots = compactRoots([...state.config.roots, ...await Promise.all(args.map(directory))]);
        record(state, 'init', { roots: state.config.roots });
      }
      configure(state, parsed);
      return rescan(state, canonicalStore);
    }, command === 'init') };
  }
  if (command === 'skill') {
    allowOptions(parsed, ['--target']);
    count(args, 1);
    if (args[0] !== 'install') throw new ResolverError('USAGE', 'Use skill install [--target <folder>].');
    return { data: await installSkill(parsed.values.get('--target')?.[0]) };
  }
  if (command === 'roots') {
    allowOptions(parsed, []);
    const [action, ...roots] = args;
    if (action === 'list') { count(roots, 0); return { data: (await store.read()).config }; }
    if (action !== 'add' && action !== 'remove') throw new ResolverError('USAGE', 'Use roots list|add|remove.');
    count(roots, 1, Infinity);
    return { data: await store.transaction(async (state, canonicalStore) => {
      if (action === 'add') state.config.roots = compactRoots([...state.config.roots, ...await Promise.all(roots.map(directory))]);
      else {
        const removing = await Promise.all(roots.map(root => directory(root).catch(() => expandPath(root))));
        for (const root of removing) if (!state.config.roots.includes(root)) throw new ResolverError('ROOT_NOT_FOUND', `Not a registered root: ${root}`);
        state.config.roots = state.config.roots.filter(root => !removing.includes(root));
      }
      record(state, `roots.${action}`, { roots, remaining: state.config.roots });
      return rescan(state, canonicalStore);
    }) };
  }
  if (command === 'map') {
    allowOptions(parsed, args[0] === 'set' ? ['--note'] : []);
    const [action, ...params] = args;
    if (action === 'list') { count(params, 0); return { data: (await store.read()).mappings }; }
    if (action === 'set') {
      count(params, 2);
      const [name, input] = params as [string, string];
      if (!name.trim()) throw new ResolverError('USAGE', 'Mapping name cannot be empty.');
      const path = await directory(input);
      return { data: await store.transaction(async state => {
        const previous = state.mappings.find(m => m.name === name) ?? null;
        const mapping = { name, path, note: parsed.values.get('--note')?.[0] ?? '', updatedAt: new Date().toISOString() };
        state.mappings = [...state.mappings.filter(m => m.name !== name), mapping].sort((a, b) => a.name.localeCompare(b.name));
        record(state, 'map.set', { before: previous, after: mapping });
        return mapping;
      }) };
    }
    if (action === 'unset') {
      count(params, 1);
      return { data: await store.transaction(async state => {
        const previous = state.mappings.find(m => m.name === params[0]);
        if (!previous) throw new ResolverError('MAPPING_NOT_FOUND', `No manual mapping for ${params[0]}.`);
        state.mappings = state.mappings.filter(m => m !== previous);
        record(state, 'map.unset', { before: previous });
        return previous;
      }) };
    }
    throw new ResolverError('USAGE', 'Use map list|set|unset.');
  }
  allowOptions(parsed, []);
  if (command === 'list') {
    count(args, 0, 1);
    if (args[0] && !['packages', 'repos'].includes(args[0])) throw new ResolverError('USAGE', 'Use list packages|repos.');
    const state = await store.read();
    return { data: args[0] === 'repos' ? state.snapshot.repositories : state.snapshot.packages };
  }
  if (command === 'resolve') {
    count(args, 1);
    const data = await resolveSource(await store.read(), args[0]!);
    return { data, exitCode: { resolved: 0, not_found: 2, ambiguous: 3, stale: 4 }[data.status] };
  }
  if (command === 'search') { count(args, 1); return { data: search(await store.read(), args[0]!) }; }
  if (command === 'history') { count(args, 0); return { data: (await store.read()).history }; }
  if (command === 'status') {
    count(args, 0);
    const state = await store.read();
    const names = new Map<string, string[]>();
    for (const pkg of state.snapshot.packages) names.set(pkg.name, [...(names.get(pkg.name) ?? []), pkg.path]);
    return { data: { store: store.file, revision: state.revision, config: state.config, scannedAt: state.snapshot.scannedAt,
      repositories: state.snapshot.repositories.length, packages: state.snapshot.packages.length, mappings: state.mappings.length,
      duplicates: [...names].filter(([, paths]) => paths.length > 1).map(([name, paths]) => ({ name, paths })), issues: state.snapshot.issues } };
  }
  throw new ResolverError('USAGE', `Unknown command: ${command ?? '(none)'}. Run source-compass --help.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  try {
    const parsed = parse(argv);
    if (parsed.flags.has('--help') || parsed.flags.has('-h') || !argv.length) { console.log(json ? JSON.stringify({ ok: true, data: { help: HELP } }) : HELP); return; }
    if (parsed.flags.has('--version') || parsed.flags.has('-v')) { console.log(json ? JSON.stringify({ ok: true, data: { version: VERSION } }) : VERSION); return; }
    const result = await execute(parsed);
    // JSON is the stable machine interface. Human output retains all fields too.
    console.log(JSON.stringify({ ok: true, data: result.data }, null, json ? undefined : 2));
    process.exitCode = result.exitCode ?? 0;
  } catch (error) {
    const known = error instanceof ResolverError ? error : new ResolverError('IO_ERROR', error instanceof Error ? error.message : 'Unexpected error');
    const payload = { ok: false, error: { code: known.code, message: known.message, ...(known.details !== undefined ? { details: known.details } : {}) } };
    if (json) console.log(JSON.stringify(payload));
    else console.error(`${known.code}: ${known.message}`);
    process.exitCode = known.exitCode;
  }
}

await main();
