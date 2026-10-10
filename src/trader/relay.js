import { generateKeyPairSync, createPrivateKey, createHash, randomBytes, sign } from 'node:crypto';
import { canonicalJson } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { TraderCliError } from './storage.js';
import { TRADER_RELEASE_ID } from './release.js';

const BASE='https://hartiilabs.com';
export function createDevice() {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  return {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url'),privateKey:privateKey.export({type:'pkcs8',format:'der'}).toString('base64url')};
}
function signed(device,message) {
  const key=createPrivateKey({key:Buffer.from(device.privateKey,'base64url'),format:'der',type:'pkcs8'});
  if(key.asymmetricKeyType!=='ed25519') throw new TraderCliError('Invalid local device credential.');
  return sign(null,Buffer.from(message,'utf8'),key).toString('base64url');
}
export function signRelayRequest({device,runnerId,path,payload,time=Date.now(),nonce=randomBytes(24).toString('base64url')}) {
  if(!/^\/api\/trader\/[a-z/-]+$/.test(path)) throw new TraderCliError('Unsupported trader relay path.');
  const body=canonicalJson(payload), bodyHash=createHash('sha256').update(body).digest('hex');
  const message='hartii-trader-request:v1\n'+canonicalJson({method:'POST',path,bodyHash,time,nonce,runnerId});
  return {body,headers:{'content-type':'application/json','x-trader-runner':runnerId,'x-trader-time':String(time),'x-trader-nonce':nonce,'x-trader-signature':signed(device,message)}};
}
async function post(path,request,deps={}) {
  let response,body;
  try { response=await (deps.fetchFn || fetch)(BASE+path,{method:'POST',...request,redirect:'error',signal:AbortSignal.timeout(12000)}); body=await response.json(); }
  catch { throw new TraderCliError('Trader dashboard is unavailable; local history is retained.'); }
  if(!response.ok && (response.status ?? 200)>=400 || body?.error) throw new TraderCliError(`Trader dashboard refused the request (${response.status ?? 503}); check pairing and service configuration.`,
    {status:response.status ?? 503,code:typeof body?.error?.code==='string' && /^[a-z0-9-]{1,80}$/.test(body.error.code)?body.error.code:'trader-unavailable',retryable:body?.retryable===true});
  return body;
}
export async function redeemDevice(pairingCode,device,deps={}) {
  if(typeof pairingCode!=='string' || !/^[0-9a-f]{64}$/.test(pairingCode)) throw new TraderCliError('Enter the pairing code from your authenticated dashboard.');
  const payload={pairingCode,devicePublicKey:device.publicKey,proof:signed(device,`hartii-trader-pair:v1:${pairingCode}:${device.publicKey}`)};
  const result=await post('/api/trader/pair/redeem',{body:canonicalJson(payload),headers:{'content-type':'application/json'}},deps);
  if(!/^[A-Za-z0-9_-]{16,64}$/.test(result?.runnerId) || result.confirmationRequired!==true) throw new TraderCliError('Invalid pairing response.');
  return {runnerId:result.runnerId,confirmationRequired:true,deviceFingerprint:createHash('sha256').update(device.publicKey).digest('hex').slice(0,24)};
}
export function createRelay({device,runnerId},deps={}) {
  const send=(path,payload)=>post(path,signRelayRequest({device,runnerId,path,payload,time:deps.clock?.() ?? Date.now()}),deps);
  return {heartbeat:snapshot=>send('/api/trader/heartbeat',{snapshot}),events:events=>send('/api/trader/events',{events,releaseId:TRADER_RELEASE_ID}),
    request:send};
}
