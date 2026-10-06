// packages/hartii-cli/src/tui/forms.js
//
// Form definitions for the Actions menu. Pure data + validators (no I/O): the TUI controller renders
// them, validates inline, then maps the values onto the SAME command functions the CLI uses, so a TUI
// action has exactly the CLI's simulation, confirmation summary, spending-guard and receipt behaviour.
import { assertCyprus1QuaiAddress } from '../address.js';
import {exactReceiveAmount,parseNativePaylink} from '../paylinks.js';
import { parseSlippageBps } from '../trade.js';
import { validateMessage, hexToColor } from '../../vendor/src/utils/wallCurve.js';

const err = (fn) => (v) => { try { fn(v); return ''; } catch (e) { return e.message.replace(/\s+/g, ' ').slice(0, 120); } };

export const v = {
  required: (label) => (val) => (String(val ?? '').trim() ? '' : `${label} is required.`),
  address: err((val) => { assertCyprus1QuaiAddress(String(val).trim()); }),
  tokenRef: (val) => {
    const s = String(val ?? '').trim();
    if (!s) return 'Token is required (address or ticker).';
    if (/^0x/i.test(s)) return v.address(s);
    return /^[A-Za-z0-9$_.-]{1,24}$/.test(s) ? '' : 'Use a 0x address or a ticker like DEMO.';
  },
  optionalTokenRef: (val) => (String(val ?? '').trim() ? v.tokenRef(val) : ''),
  optionalAddress: (val) => (String(val ?? '').trim() ? v.address(val) : ''),
  amount: (val) => {
    const s = String(val ?? '').trim();
    if (!s) return 'Amount is required.';
    if (/^all$/i.test(s)) return '';
    const pct = s.match(/^(\d+(?:\.\d+)?)%$/);
    if (pct) return Number(pct[1]) > 0 && Number(pct[1]) <= 100 ? '' : 'Percent must be above 0 and at most 100.';
    if (!/^\d+(\.\d+)?$/.test(s)) return 'Use a plain decimal like 1.5, a percent like 50%, or all.';
    return Number(s) > 0 ? '' : 'Amount must be above zero.';
  },
  plainAmount: (val) => {
    const s = String(val ?? '').trim();
    if (!s) return 'Amount is required.';
    return /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? '' : 'Use a plain positive decimal like 12.5.';
  },
  optionalPlainAmount: (val) => (String(val ?? '').trim() ? v.plainAmount(val) : ''),
  slippage: err((val) => { parseSlippageBps(String(val ?? '').trim() || undefined); }),
  path: (val) => (String(val ?? '').trim() ? '' : 'A file path is required.'),
  id: (val) => (/^(\d{1,78}|0x[0-9a-fA-F]{1,64})$/.test(String(val ?? '').trim()) ? '' : 'Use the numeric id (decimal or 0x hex).'),
  expiry: (val) => (!String(val ?? '').trim() || /^(none|\d+[dhm])$/i.test(String(val).trim()) ? '' : 'Use 7d, 12h, 90m or none.'),
  color: (val) => (!String(val ?? '').trim() || hexToColor(String(val).trim()) !== null ? '' : 'Colour must be a 6-digit hex like #7c3aed.'),
  message: (val) => { const r = validateMessage(String(val ?? '')); return r.ok ? '' : r.error; },
  limit: (val) => (/^\d+(\.\d{1,18})?$/.test(String(val ?? '').trim()) && Number(val) > 0 ? '' : 'Use a positive QUAI amount.'),
  count: (val) => (!String(val ?? '').trim() || /^\d{1,2}$/.test(String(val).trim()) ? '' : 'A small whole number.'),
};

const f = (key, label, validate, extra = {}) => ({ key, label, validate, ...extra });

/** Per-action field lists. `select` fields drive which other fields show (see fieldsFor). */
export const ACTIONS = {
  Receive: {title:'Receive QUAI',command:'receive',select:{key:'kind',label:'QR type',options:['payment link','address']},fields:(values)=>[
    ...(values.kind==='address'?[]:[
    f('amount','Request amount',(value)=>String(value||'').trim()?err(exactReceiveAmount)(value):'',{optional:true,hint:'Blank lets the payer choose the amount.'}),
    f('memo','Memo',(value)=>[...String(value||'')].length<=140?'':'At most 140 characters.',{optional:true}),
    ]),
    f('out','QR SVG file',v.required('SVG file'),{value:`hartii-receive-${Date.now()}.svg`,hint:'Offline QR image; public address only.'}),
  ]},
  Send: { title: 'Send', command: 'send', fields: (values) => [
    f('to', 'Recipient', err(value=>{const input=String(value||'').trim();if(/^https?:\/\//i.test(input))parseNativePaylink(input);else assertCyprus1QuaiAddress(input);}), { placeholder: 'Quai address or HPAY payment link' }),
    f('amount', 'Amount', value=>{if(!String(value||'').trim()&&/^https?:\/\//i.test(values.to||'')){try{if(parseNativePaylink(values.to).amountWei!==null)return '';}catch{/* recipient validation explains the error */}}return v.amount(value);}, { hint: 'Blank uses a fixed HPAY amount. Otherwise: 1.5 · 50% · all' }),
    f('token', 'Token', v.optionalTokenRef, { optional: true, hint: 'address or ticker; blank = QUAI' }),
  ] },
  Buy: { title: 'Buy', command: 'buy', fields: () => [
    f('token', 'Token', v.tokenRef, { placeholder: 'ticker or 0x address' }),
    f('quai', 'QUAI to spend', v.amount, { hint: '1.5 · 25% · all' }),
    f('slippage', 'Slippage %', v.slippage, { value: '3', hint: 'minimum received is set from this' }),
  ] },
  Sell: { title: 'Sell', command: 'sell', fields: () => [
    f('token', 'Token', v.tokenRef, { placeholder: 'ticker or 0x address' }),
    f('amount', 'Amount', v.amount, { hint: '1000 · 50% · all' }),
    f('slippage', 'Slippage %', v.slippage, { value: '3' }),
  ] },
  Swap: { title: 'Swap (HartiiSwap)', command: 'swap', fields: () => [
    f('tokenIn', 'Pay', v.tokenRef, { placeholder: 'QUAI, WQUAI, ticker or 0x' }),
    f('tokenOut', 'Receive', v.tokenRef, { placeholder: 'QUAI, WQUAI, ticker or 0x' }),
    f('amount', 'Amount in', v.amount, { hint: '1.5 · 50% · all' }),
    f('slippage', 'Slippage %', v.slippage, { value: '3' }),
  ] },
  Airdrop: { title: 'Airdrop', command: 'airdrop', fields: () => [
    f('csv', 'CSV file', v.path, { placeholder: 'recipients.csv  (address,amount)' }),
    f('token', 'Token', v.optionalTokenRef, { optional: true, hint: 'blank = QUAI' }),
    f('amount', 'Same amount', v.optionalPlainAmount, { optional: true, hint: 'only for address-only rows' }),
  ] },
  OTC: { title: 'OTC Link', command: 'otc', select: { key: 'sub', label: 'Action', options: ['list', 'create', 'fill', 'cancel'] }, fields: (vals) => {
    const sub = vals.sub || 'list';
    if (sub === 'create') return [
      f('token', 'Token to sell', v.tokenRef, { placeholder: 'ticker or 0x' }),
      f('amount', 'Token amount', v.amount),
      f('quai', 'QUAI wanted', v.plainAmount, { hint: 'the contract has a minimum notional' }),
      f('taker', 'Only this taker', v.optionalAddress, { optional: true }),
      f('expiry', 'Expiry', v.expiry, { value: '7d', hint: '7d · 12h · none (max 30d)' }),
    ];
    if (sub === 'fill' || sub === 'cancel') return [f('id', 'Offer id', v.id)];
    return [];
  } },
  Claim: { title: 'Claim', command: 'claim', select: { key: 'sub', label: 'Action', options: ['check', 'claim', 'list'] }, fields: (vals) => ((vals.sub || 'check') === 'list' ? [] : [f('id', 'Campaign id', v.id, { hint: 'decimal or 0x' })]) },
  Wall: { title: 'Wall of Blocks', command: 'wall', select: { key: 'sub', label: 'Action', options: ['engrave', 'stats', 'recent'] }, fields: (vals) => {
    const sub = vals.sub || 'engrave';
    if (sub === 'engrave') return [
      f('message', 'Message', v.message, { placeholder: 'up to 280 bytes' }),
      f('color', 'Colour', v.color, { optional: true, value: '#7c3aed' }),
      f('token', 'Promote token', v.optionalTokenRef, { optional: true }),
    ];
    if (sub === 'recent') return [f('n', 'How many', v.count, { optional: true, value: '5' })];
    return [];
  } },
  Settings: { title: 'Settings', command: 'settings', select: { key: 'network', label: 'Network', options: ['mainnet', 'orchard'] }, fields: () => [
    f('perTxQuai', 'Per-tx limit (QUAI)', v.limit),
    f('dailyQuai', 'Daily limit (QUAI)', v.limit),
  ] },
};

/** Field list for an action given the select value(s) typed so far. */
export function fieldsFor(action, values = {}) {
  const def = ACTIONS[action];
  if (!def) return [];
  return def.fields(values);
}

/** Validates every field; returns { errors:{key:msg}, ok }. */
export function validateAll(action, values) {
  const errors = {};
  for (const fld of fieldsFor(action, values)) {
    const msg = fld.validate ? fld.validate(values[fld.key]) : '';
    if (msg) errors[fld.key] = msg;
  }
  return { errors, ok: Object.keys(errors).length === 0 };
}

/** Maps an action + values onto { fn, opts } for the command layer (opts merged with globals by the app). */
export function commandFor(action, values) {
  const t = (k) => (String(values[k] ?? '').trim() || undefined);
  switch (action) {
    case 'Receive':return {fn:'receive',opts:{...(values.kind==='address'?{addressQr:true}:{amount:t('amount'),memo:t('memo')}),out:t('out')}};
    case 'Send': return { fn: 'send', opts: { to: t('to'), amount: t('amount'), token: t('token') } };
    case 'Buy': return { fn: 'buy', opts: { token: t('token'), quai: t('quai'), slippage: t('slippage') } };
    case 'Sell': return { fn: 'sell', opts: { token: t('token'), amount: t('amount'), slippage: t('slippage') } };
    case 'Swap': return { fn: 'swap', opts: { tokenIn: t('tokenIn'), tokenOut: t('tokenOut'), amount: t('amount'), slippage: t('slippage') } };
    case 'Airdrop': return { fn: 'airdrop', opts: { csv: t('csv'), token: t('token'), amount: t('amount') } };
    case 'OTC': {
      const sub = values.sub || 'list';
      const o = { sub };
      if (sub === 'create') Object.assign(o, { token: t('token'), amount: t('amount'), quai: t('quai'), taker: t('taker'), expiry: t('expiry') });
      if (sub === 'fill' || sub === 'cancel') o.id = t('id');
      if (sub === 'list') o.mine = false;
      return { fn: 'otc', opts: o };
    }
    case 'Claim': {
      const sub = values.sub || 'check';
      if (sub === 'list') return { fn: 'claim', opts: { sub: 'list', mine: true } };
      return { fn: 'claim', opts: { sub: 'claim', id: t('id'), check: sub === 'check' } };
    }
    case 'Wall': {
      const sub = values.sub || 'engrave';
      if (sub === 'engrave') return { fn: 'wall', opts: { sub, message: String(values.message ?? ''), color: t('color'), token: t('token') } };
      return { fn: 'wall', opts: { sub, n: t('n') } };
    }
    default: return null;
  }
}
