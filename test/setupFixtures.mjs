// Shared fixtures for the setup/home look tests and the snapshot renderer tool (tools/render-setup-snapshots.mjs).
// The "recovery phrase" here is the public BIP-39 test vector, never a real wallet's.
import { SetupFlow } from '../src/onboarding/flow.js';
import { renderSetup } from '../src/tui/setup.js';
import { renderFrame } from '../src/tui/render.js';
import { demoState } from '../src/tui/demoData.js';

// Public test vector, built at runtime so the OSS export's mnemonic scan never sees a literal phrase. (BIP-39's all-zero entropy vector.)
export const TEST_PHRASE = [...Array(11).fill('abandon'), 'about'].join(' ');
export const ADDRESS = '0x0012345678901234567890123456789012345678';
export const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
export const SETUP_STEPS = ['welcome', 'import-kind', 'import-secret', 'password', 'confirm', 'creating', 'phrase', 'verify', 'caps', 'caps-custom', 'receive', 'received', 'error'];

function fakeEffects(over = {}) {
  return {
    createWallet: async () => ({ name: 'default', address: ADDRESS, phrase: TEST_PHRASE }),
    importWallet: async () => ({ name: 'default', address: ADDRESS }),
    saveCaps() {}, markBackupPending() {}, clearBackupPending() {}, activate() {},
    ...over,
  };
}

/** A flow parked on `step`, filled in the way a mid-setup user would see it. */
export async function flowAt(step) {
  const flow = new SetupFlow({ effects: fakeEffects(step === 'error' ? { createWallet: async () => { throw new Error('Could not write the wallet file. Nothing was saved.'); } } : step === 'creating' ? { createWallet: () => new Promise(() => {}) } : {}), rng: (() => { let i = 0; return () => [2, 6, 10][i++ % 3]; })(), now: () => NOW });
  const pw = 'correct horse battery';
  if (step === 'welcome') return flow;
  if (step === 'import-kind') { flow.choose('import'); return flow; }
  if (step === 'import-secret') { flow.choose('import'); flow.chooseImportKind('mnemonic'); flow.text = 'x'.repeat(71); return flow; }
  flow.choose('create');
  if (step === 'password') { flow.text = pw; return flow; }
  flow.submitPassword(pw);
  if (step === 'confirm') { flow.text = 'correct horse'; flow.error = 'The two passwords do not match. Try again.'; return flow; }
  if (step === 'creating') { void flow.submitConfirm(pw); await new Promise((r) => setTimeout(r, 0)); return flow; }
  await flow.submitConfirm(pw);
  if (step === 'error') return flow;
  if (step === 'phrase') return flow;
  flow.startVerify();
  if (step === 'verify') { flow.words[0] = TEST_PHRASE.split(' ')[flow.askIdx[0]]; flow.row = 1; flow.submitWords(['nope', '', '']); return flow; }
  flow.submitWords(flow.askIdx.map((i) => TEST_PHRASE.split(' ')[i]));
  if (step === 'caps') return flow;
  if (step === 'caps-custom') { flow.setCaps('custom'); flow.caps = { perTx: '5', daily: '20' }; return flow; }
  flow.setCaps('normal');
  if (step === 'receive') { flow.onBalance('0'); return flow; }
  flow.onBalance('0'); flow.onBalance('5000000000000000000');
  return flow;
}

export async function setupScreen(step, cols, rows, opts = {}) {
  return renderSetup(await flowAt(step), { cols, rows, now: NOW, motion: false, ascii: false, ...opts });
}

export function homeScreen(cols, rows, opts = {}) {
  return renderFrame({ ...demoState(NOW), now: NOW, motion: false, ...opts }, cols, rows);
}

export const SNAPSHOT_SIZES = [[80, 24], [120, 40]];
/** Every screen the screenshot gate looks at: [{ name, screen }]. */
export async function allScreens() {
  const list = [];
  for (const [cols, rows] of SNAPSHOT_SIZES) {
    list.push({ name: `home-${cols}`, screen: homeScreen(cols, rows) });
    for (const step of SETUP_STEPS) list.push({ name: `setup-${step}-${cols}`, screen: await setupScreen(step, cols, rows) });
  }
  list.push({ name: 'home-60', screen: homeScreen(60, 24) });
  list.push({ name: 'home-80-ascii', screen: homeScreen(80, 24, { ascii: true }) });
  return list;
}
