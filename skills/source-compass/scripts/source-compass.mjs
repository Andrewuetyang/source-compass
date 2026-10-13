#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const bundled = fileURLToPath(new URL('./runtime/cli.js', import.meta.url));
const development = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const entry = existsSync(bundled) ? bundled : development;
if (!existsSync(entry)) {
  console.error('SourceCompass runtime is missing. Build the project and run skill install.');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
