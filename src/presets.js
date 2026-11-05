// Cap presets for live mode (`--preset conservative|normal|degen`). A preset implies the per-tx and per-day
// caps (and an MCP slippage ceiling); explicit caps may only LOWER a preset value. All money math is BigInt wei.
const E18 = 10n ** 18n;
export const PRESETS = Object.freeze({
  conservative: Object.freeze({ perTxWei: 10n * E18, dailyWei: 50n * E18, maxSlippageBps: 100 }),
  normal: Object.freeze({ perTxWei: 50n * E18, dailyWei: 250n * E18, maxSlippageBps: 200 }),
  degen: Object.freeze({ perTxWei: 250n * E18, dailyWei: 1000n * E18, maxSlippageBps: 500 }),
});
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));
const DEC = /^(?:0|[1-9]\d{0,77})(?:\.\d{1,18})?$/;

export function quaiToWei(s) {
  const [a, b = ''] = String(s).split('.');
  return BigInt(a) * E18 + BigInt(b.padEnd(18, '0'));
}
export function weiToQuai(w) {
  const a = w / E18, b = (w % E18).toString().padStart(18, '0').replace(/0+$/, '');
  return b ? `${a}.${b}` : String(a);
}

/**
 * @param {{preset?:string, maxPerTx?:string, maxPerDay?:string}} o
 * @returns {null | {preset:string, perTxQuai:string, dailyQuai:string, perTxWei:string, dailyWei:string, maxSlippageBps:number}}
 */
export function resolvePreset({ preset, maxPerTx, maxPerDay, slippageBps } = {}) {
  if (preset === undefined || preset === null || preset === false) return null;
  const name = String(preset).toLowerCase();
  if (!Object.hasOwn(PRESETS, name)) throw new Error(`Unknown --preset "${String(preset).slice(0, 32)}": use ${PRESET_NAMES.join(', ')}.`);
  const p = PRESETS[name];
  const lower = (value, cap, flag) => {
    if (value === undefined || value === null || value === false) return cap;
    if (!DEC.test(String(value)) || !/[1-9]/.test(String(value))) throw new Error(`--${flag} must be a bounded positive QUAI amount like 5 or 0.5.`);
    const w = quaiToWei(value);
    if (w > cap) throw new Error(`--${flag} ${value} is above the ${name} preset limit of ${weiToQuai(cap)} QUAI; an explicit cap may only lower a preset.`);
    return w;
  };
  const perTx = lower(maxPerTx, p.perTxWei, 'max-per-tx'), daily = lower(maxPerDay, p.dailyWei, 'max-per-day');
  let slip = p.maxSlippageBps;
  if (slippageBps !== undefined && slippageBps !== null && slippageBps !== false) {
    if (!/^[1-9]\d{0,4}$/.test(String(slippageBps))) throw new Error('--slippage-bps must be a positive whole number of basis points like 50.');
    slip = Number(slippageBps);
    if (slip > p.maxSlippageBps) throw new Error(`--slippage-bps ${slippageBps} is above the ${name} preset limit of ${p.maxSlippageBps}; an explicit slippage may only lower a preset.`);
  }
  return { preset: name, slippageBps: slip, perTxQuai: weiToQuai(perTx), dailyQuai: weiToQuai(daily), perTxWei: perTx.toString(), dailyWei: daily.toString(), maxSlippageBps: p.maxSlippageBps };
}
