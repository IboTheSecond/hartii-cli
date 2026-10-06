/* eslint-disable no-control-regex -- payment memos must reject terminal controls */
import {parseAmount,formatAmount} from './amount.js';
import {assertCyprus1QuaiAddress} from './address.js';
export const HPAY_BASE='https://hartiibiome.com/pay.html';
export function exactReceiveAmount(value){
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,18})?$/.test(value))throw new Error('Receive amount must be a positive decimal QUAI amount with at most 18 decimals.');
 const parsed=parseAmount(value,{decimals:18});if(parsed.amountWei<=0n||parsed.amountWei>(1n<<256n)-1n)throw new Error('Receive amount must be positive and fit in a uint256.');return parsed.amountWei;
}
function validMemo(value){if(typeof value!=='string'||[...value].length>140||/[\x00-\x1f\x7f-\x9f]/.test(value))throw new Error('Payment memo must be at most 140 characters without control codes.');return value;}
export function buildReceiveLink({address,amount,memo='',expiresAt=null}){
 const to=assertCyprus1QuaiAddress(address);const url=new URL(HPAY_BASE);url.searchParams.set('to',to);
 if(amount!==undefined&&amount!==null)url.searchParams.set('amt',exactReceiveAmount(amount).toString());
 if(validMemo(memo))url.searchParams.set('memo',memo);
 if(expiresAt!==null){if(!Number.isSafeInteger(expiresAt)||expiresAt<=0)throw new Error('Payment expiry must be a positive Unix timestamp.');url.searchParams.set('exp',String(expiresAt));}
 url.searchParams.set('chain','9');url.searchParams.set('v','1');return url.href;
}
/** `--expires 30m|2h|7d` -> absolute Unix seconds. Bare flags, bare numbers (ms vs s is ambiguous), zero and >365d are refused. */
export function parseReceiveExpiry(input,{now=Date.now()}={}){
 const m=typeof input==='string'?input.trim().toLowerCase().match(/^([1-9]\d{0,5})([mhd])$/):null;
 if(!m)throw new Error('--expires needs an explicit duration like 30m, 2h or 7d (minutes, hours or days).');
 const seconds=Number(m[1])*{m:60,h:3600,d:86400}[m[2]];
 if(seconds>365*86400)throw new Error('--expires cannot exceed 365 days.');
 return Math.floor(now/1000)+seconds;
}
export function parseNativePaylink(input,{now=Date.now()}={}){
 let url;try{url=new URL(input);}catch{throw new Error('Invalid HPAY payment link.');}
 const origins=new Set(['https://hartiibiome.com','https://www.hartiibiome.com','https://hartiigallery.com','https://www.hartiigallery.com']);
 if(url.protocol!=='https:'||url.username||url.password||url.hash||!origins.has(url.origin)||!['/hpay','/hpay.html','/pay','/pay.html'].includes(url.pathname))throw new Error('Use an HTTPS Hartii HPAY payment link without credentials or redirects.');
 for(const key of ['to','amt','memo','exp','chain','v'])if(url.searchParams.getAll(key).length>1)throw new Error('Ambiguous duplicate fields in payment link.');
 if(url.searchParams.get('chain')!=='9'||url.searchParams.get('v')!=='1')throw new Error('Payment link must explicitly target Quai mainnet chain 9, format 1.');
 const to=assertCyprus1QuaiAddress(url.searchParams.get('to'));
 const wei=url.searchParams.get('amt');if(wei!==null&&(!/^\d+$/.test(wei)||wei.length>78||BigInt(wei)<=0n||BigInt(wei)>(1n<<256n)-1n))throw new Error('Invalid payment amount in HPAY link.');
 const memo=validMemo(url.searchParams.get('memo')||'');const exp=url.searchParams.get('exp');let expiresAt=null;
 if(exp!==null){if(!/^\d+$/.test(exp)||!Number.isSafeInteger(Number(exp)))throw new Error('Invalid payment link expiry.');expiresAt=Number(exp);if(expiresAt*1000<=now)throw new Error('Payment link expired.');}
 return {to,amount:wei===null?null:formatAmount(BigInt(wei),18),amountWei:wei===null?null:BigInt(wei),memo,expiresAt,chainId:9};
}
