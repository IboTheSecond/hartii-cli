// Renders the guided setup screens and the home screen to ANSI files plus one HTML preview, for the screenshot gate.
//   node packages/hartii-cli/tools/render-setup-snapshots.mjs
// Output: packages/hartii-cli/test/__snapshots__/setup/{name}.ansi and index.html (fixtures only, no wallet data).
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { allScreens } from '../test/setupFixtures.mjs';
import { htmlPage } from './ansi-html.mjs';

const dir = fileURLToPath(new URL('../test/__snapshots__/setup/', import.meta.url));
mkdirSync(dir, { recursive: true });
const sections = [];
for (const { name, screen } of await allScreens()) {
  const ansi = screen.toAnsiRows('truecolor').join('\n') + '\n';
  writeFileSync(join(dir, `${name}.ansi`), ansi);
  sections.push({ name, ansi });
}
writeFileSync(join(dir, 'index.html'), htmlPage('Hartii CLI: guided setup and home (fixtures)', sections));
console.log(`wrote ${sections.length} screens to ${dir}`);
