import { existsSync, readFileSync } from 'node:fs';

// A bundled skill carries its own manifest next to the runtime. npm installs
// and source checkouts use the package manifest one directory above dist/.
const bundled = new URL('./package.json', import.meta.url);
const manifest = existsSync(bundled) ? bundled : new URL('../package.json', import.meta.url);
const metadata: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
if (!metadata || typeof metadata !== 'object' || !('name' in metadata) || !('version' in metadata) ||
    typeof metadata.name !== 'string' || typeof metadata.version !== 'string') {
  throw new Error('SourceCompass package metadata is missing its name or version.');
}

export const PACKAGE_NAME = metadata.name;
export const VERSION = metadata.version;
