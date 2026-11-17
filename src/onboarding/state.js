// packages/hartii-cli/src/onboarding/state.js
//
// The persistent "back up your recovery phrase" reminder. A wallet whose backup was not verified (the user chose
// "back up later", or quit mid-setup) is listed in <home>/onboarding.json so the home screen can keep a banner up
// until the backup is verified or `hartii wallet export` is completed. Public data only: wallet NAMES, never a phrase.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateWrite } from '../secureFiles.js';

const file = (home) => join(home, 'onboarding.json');

export function readBackupPending(home) {
  try {
    if (!existsSync(file(home))) return [];
    const j = JSON.parse(readFileSync(file(home), 'utf8'));
    return Array.isArray(j.backupPending) ? j.backupPending.filter((n) => typeof n === 'string').slice(0, 50) : [];
  } catch { return []; }
}

function write(home, names) {
  atomicPrivateWrite(file(home), JSON.stringify({ backupPending: names }, null, 2) + '\n', { replace: true });
}

export function markBackupPending(home, name) {
  const names = readBackupPending(home);
  if (!names.includes(name)) write(home, [...names, name]);
}

export function clearBackupPending(home, name) {
  const names = readBackupPending(home);
  if (names.includes(name)) write(home, names.filter((n) => n !== name));
}
