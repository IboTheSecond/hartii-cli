// The ONE source of truth for the CLI version is package.json (works from the repo and from the packed tarball).
import { readFileSync } from 'node:fs';

export const PKG_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
