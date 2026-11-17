// The dashboard must support the SAFETY lane's new-payee check: review first (scrolled to the end),
// then type the last 4 characters of the address. Without it, a dashboard send to a new payee fails closed.
import { describe, it, expect } from 'vitest';
import { TuiApp } from '../src/tui/app.js';
import { demoState } from '../src/tui/demoData.js';

const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);
const QUESTION = 'New recipient. To confirm, type the last 4 characters of 0x0011111111111111111111111111111111110D04: ';
const open = () => {
  const app = new TuiApp({ data: demoState(NOW), size: { cols: 100, rows: 40 }, deps: { now: () => NOW } });
  const io = app.makeIo(['You send 1 QUAI to 0x0011 1111 … 0D04.', 'Warning: You have never paid this address from this computer.']);
  return { app, io };
};
const type = (app, s) => { for (const ch of s) app.key({ str: ch, name: ch }); };

describe('dashboard new-payee confirmation', () => {
  it('offers a typed confirmation to the pipeline', () => {
    const { io } = open();
    expect(typeof io.typedConfirmFn).toBe('function');
  });

  it('review first, then the typed check; resolves with exactly what was typed', async () => {
    const { app, io } = open();
    const answer = io.typedConfirmFn(QUESTION);
    expect(app.ui.overlay.type).toBe('confirm');
    expect(app.frame().toPlain()).toMatch(/never paid this address/);
    app.key({ name: 'end' });
    app.key({ str: 'y', name: 'y' });
    expect(app.ui.overlay.type).toBe('prompt');
    expect(app.frame().toPlain()).toMatch(/last 4 characters/);
    type(app, '0d04');
    app.key({ name: 'return' });
    await expect(answer).resolves.toBe('0d04');
  });

  it('cancelling at the review or at the typed step resolves empty, so nothing is sent', async () => {
    const a = open();
    const first = a.io.typedConfirmFn(QUESTION);
    a.app.key({ str: 'n', name: 'n' });
    await expect(first).resolves.toBe('');
    const b = open();
    const second = b.io.typedConfirmFn(QUESTION);
    b.app.key({ name: 'end' });
    b.app.key({ str: 'y', name: 'y' });
    b.app.key({ name: 'escape' });
    await expect(second).resolves.toBe('');
  });
});
