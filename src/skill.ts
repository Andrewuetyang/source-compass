import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { expandPath, within } from './paths.js';
import { ResolverError } from './types.js';
import { PACKAGE_NAME, VERSION } from './metadata.js';

export async function installSkill(target?: string): Promise<{ path: string; runtimeBundled: true }> {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(project, 'skills', 'source-compass');
  const destination = target ? expandPath(target) : join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills', 'source-compass');
  if (within(source, destination) || within(join(project, 'dist'), destination)) {
    throw new ResolverError('INVALID_SKILL_TARGET', 'Install the skill outside its source and compiled runtime directories.');
  }
  await mkdir(dirname(destination), { recursive: true });
  try { await mkdir(destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ResolverError('SKILL_EXISTS', `Skill destination already exists: ${destination}. Use a different --target or remove the old installation deliberately.`);
    throw error;
  }
  try {
    await cp(source, destination, { recursive: true });
    await cp(join(project, 'dist'), join(destination, 'scripts', 'runtime'), { recursive: true });
    await writeFile(join(destination, 'scripts', 'runtime', 'package.json'), `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION, type: 'module', license: 'MIT' })}\n`);
    await cp(join(project, 'LICENSE'), join(destination, 'LICENSE'));
    // Confirm the entrypoint was packaged. The skill no longer depends on this checkout.
    await readFile(join(destination, 'scripts', 'runtime', 'cli.js'));
    return { path: destination, runtimeBundled: true };
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}
