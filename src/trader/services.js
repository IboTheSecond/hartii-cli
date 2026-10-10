import { createHash } from 'node:crypto';
import { Wallet,verifyMessage } from 'quais';
import { canonicalPolicyMessage,TraderError } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { readKeystoreFile,decryptAccount } from '../keystore.js';
import { resolveWalletAddress } from '../commands/balance.js';
import { resolvePassword } from '../prompt.js';
import { readPrivateJson,writePrivateJson,decryptCredentials,TraderCliError } from './storage.js';
import { createRelay } from './relay.js';
import { TRADER_RELEASE_ID } from './release.js';

export const policyHash=policy=>createHash('sha256').update(canonicalPolicyMessage(policy),'utf8').digest('hex');
export async function unlockDevice(paths,profile,deps={}) {
  if(!profile.pairing)throw new TraderCliError('Pair this trader with your dashboard before proposing a hosted policy.');
  const password=await resolvePassword({...deps.passwordDeps,...deps.io?.passwordDeps,env:deps.passwordDeps?.env || deps.io?.passwordDeps?.env || deps.env || deps.io?.env,label:'Trader credential password: ',writeErr:deps.io?.writeErr});
  const credentials=decryptCredentials(readPrivateJson(paths.credentials),password);
  if(!credentials.device)throw new TraderCliError('Local device credential is missing.');
  return createRelay({runnerId:profile.runnerId,device:credentials.device},deps);
}
/** A narrowly scoped offline ownership proof. It cannot broadcast a transaction. */
export async function signTradingPolicy(policy,{home,wallet},deps={}) {
  if(!wallet)throw new TraderCliError('Select the dedicated encrypted trading wallet with --wallet <name>.');
  const selected=resolveWalletAddress(home,wallet);
  if(selected.address.toLowerCase()!==policy.tradingWallet.toLowerCase())throw new TraderCliError('Selected wallet differs from the policy trading wallet.');
  const password=await resolvePassword({...deps.passwordDeps,...deps.io?.passwordDeps,env:deps.passwordDeps?.env || deps.io?.passwordDeps?.env || deps.env || deps.io?.env,label:'Dedicated trading-wallet password: ',writeErr:deps.io?.writeErr});
  const account=await decryptAccount(readKeystoreFile(home,selected.name),password);
  if(account.address.toLowerCase()!==policy.tradingWallet.toLowerCase())throw new TraderCliError('Encrypted signing account differs from policy metadata.');
  const message=canonicalPolicyMessage(policy),signature=await new Wallet(account.privateKey).signMessage(message);
  if(verifyMessage(message,signature).toLowerCase()!==policy.tradingWallet.toLowerCase())throw new TraderCliError('Trading-wallet proof did not verify.');
  return signature;
}
export function createHostedServices({relay,policy,paths},deps={}) {
  const request=async(path,payload)=>{try{return await relay.request(`/api/trader/${path}`,payload);}catch(error){
    throw new TraderError(typeof error?.code==='string' && /^[a-z0-9-]{1,80}$/.test(error.code)?`hosted-${error.code}`:'hosted-service-unavailable');
  }};
  const pending=()=>paths?readPrivateJson(paths.hostedPending,{optional:true}) || []:[];
  async function settle(hash) {const result=await request('authority/reconcile',{txHash:hash});return result.settled===true && result.txHash?.toLowerCase()===hash.toLowerCase();}
  async function reconcileHosted() {
    const rows=pending();
    for(const row of rows) {
      let settled=false;try {settled=await settle(row.txHash);}catch { /* public receipt remains locally settled, hosted authority remains pending */ }
      if(!settled)throw new TraderError('hosted-reconciliation-pending');
      writePrivateJson(paths.hostedPending,pending().filter(r=>r.txHash!==row.txHash));
    }
    return {settled:true};
  }
  return {
    currentPolicy:()=>request('policy/current',{}),
    propose:({policy,tradingWalletSignature,ownerSignature})=>request('policy/propose',{policy,tradingWalletSignature,releaseId:TRADER_RELEASE_ID,...(ownerSignature?{ownerSignature}:{})}),
    claim:()=>request('authority/claim',{policyHash:policyHash(policy)}),
    qualification:()=>request('qualification/read',{releaseId:TRADER_RELEASE_ID}),
    observe:eventSeq=>request('qualification/observe',{releaseId:TRADER_RELEASE_ID,eventSeq}),
    async membership({owner}) {
      let response,body;
      try {response=await (deps.fetchFn || fetch)(`https://hartiilabs.com/api/hbome/tier?address=${encodeURIComponent(owner)}`,{redirect:'error',signal:AbortSignal.timeout(12000)});body=await response.json();}
      catch {throw new TraderError('membership-unavailable');}
      if((response.status ?? 200)>=400 || body?.error)throw new TraderError('membership-unavailable');
      return body;
    },
    reconcileHosted,hasHostedPending:()=>pending().length>0,
    async authority({intent}) {
      await reconcileHosted();
      if(intent)return request('authority/reserve',{intentId:intent.id,txHash:null,to:null,nonce:null});
      return request('authority/read',{});
    },
    onPrepared:({intent,txHash,transaction})=>request('authority/reserve',{intentId:intent.id,txHash,to:transaction.to,nonce:transaction.nonce}),
    async onReconciled({receipt}) {
      if(!paths){if(!(await settle(receipt.txHash)))throw new TraderError('hosted-reconciliation-pending');return;}
      const rows=pending();
      if(!rows.some(r=>r.txHash===receipt.txHash))writePrivateJson(paths.hostedPending,[...rows,{txHash:receipt.txHash,id:receipt.id,status:receipt.status,at:receipt.at}]);
      try {await reconcileHosted();}catch { /* A known native receipt is retained even while the hosted 20-block gate lags. */ }
    },
  };
}
