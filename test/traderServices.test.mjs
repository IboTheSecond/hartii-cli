import { it,expect,vi,beforeAll } from 'vitest';
import { mkdtempSync,existsSync,readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet,verifyMessage } from 'quais';
import { main } from '../src/cli.js';
import { generateMnemonicAccount,encryptAccount,writeKeystoreFile } from '../src/keystore.js';
import { canonicalPolicyMessage } from '../vendor/packages/hartii-trader/src/index.mjs';
import { createHostedServices,policyHash } from '../src/trader/services.js';
import { profilePaths } from '../src/trader/storage.js';
import { TRADER_RELEASE_ID } from '../src/trader/release.js';
let owner,trading,encrypted;
const PASSWORD='synthetic-trader-password',RUNNER='12345678-1234-1234-1234-123456789012';
beforeAll(async()=>{owner=generateMnemonicAccount();trading=generateMnemonicAccount();encrypted=await encryptAccount(trading,PASSWORD,{scrypt:{N:1024,r:8,p:1}});},120000);
it('proposes with only the trading-wallet proof, then requires browser signature and local ARM before claiming',async()=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-trader-hosted-arm-'));writeKeystoreFile(home,'trading',encrypted);
  let proposal=null,envelope=null,claims=0;const requests=[];
  const deps={env:{HARTII_HOME:home,HARTII_TRADER_RELEASE_ID:'cannot-override'},write:vi.fn(),writeErr:vi.fn(),passwordDeps:{env:{HARTII_PASSWORD:PASSWORD}},secretPromptFn:async()=>'a'.repeat(64),confirmTypedFn:async()=>'ARM',
    walletFactory:vi.fn(()=>{throw Error('No transaction signer permitted');}),fetchFn:async(url,request)=>{
      const body=JSON.parse(request.body);requests.push({url,body});let result;
      if(url.endsWith('/pair/redeem'))result={runnerId:RUNNER,confirmationRequired:true};
      else if(url.endsWith('/policy/current'))result={envelope,localArmRequired:true,releaseId:TRADER_RELEASE_ID};
      else if(url.endsWith('/policy/propose')){
        expect(body.releaseId).toBe(TRADER_RELEASE_ID);expect(verifyMessage(canonicalPolicyMessage(body.policy),body.tradingWalletSignature).toLowerCase()).toBe(trading.address.toLowerCase());
        expect(body.ownerSignature).toBeUndefined();proposal=body.policy;result={policyHash:policyHash(proposal),message:canonicalPolicyMessage(proposal),expiresAt:proposal.expiresAt,approvalRequired:true};
      }else if(url.endsWith('/authority/claim')){claims++;expect(body.policyHash).toBe(policyHash(proposal));result={exclusive:true};}
      else if(url.endsWith('/events'))result={accepted:body.events.length,lastSeq:body.events.at(-1).seq};
      else if(url.endsWith('/heartbeat'))result={ok:true,controls:{paused:false}};
      else throw Error('Unexpected endpoint');
      return {ok:true,status:200,json:async()=>result};
    }};
  expect(await main(['trader','init','--pair','--owner',owner.address,'--wallet','trading','--capital','100','--max-per-tx','10','--max-per-day','30','--max-fee','1','--json'],deps)).toBe(0);
  expect(await main(['trader','arm','--json'],deps)).toBe(0);
  expect(JSON.parse(deps.write.mock.calls.at(-1)[0])).toMatchObject({armed:false,state:'awaiting-owner-signature'});
  expect(claims).toBe(0);expect(existsSync(join(home,'trader/default/armed-policy.json'))).toBe(false);
  envelope={policy:proposal,signature:await new Wallet(owner.privateKey).signMessage(canonicalPolicyMessage(proposal)),policyHash:policyHash(proposal),releaseId:TRADER_RELEASE_ID};
  expect(await main(['trader','arm','--json'],{...deps,confirmTypedFn:async()=>''})).toBe(1);expect(claims).toBe(0);
  expect(await main(['trader','arm','--json'],deps)).toBe(0);expect(claims).toBe(1);
  expect(JSON.parse(readFileSync(join(home,'trader/default/armed-policy.json'),'utf8')).policy).toEqual(proposal);
  const profilePath=join(home,'trader/default/profile.json'),profile=JSON.parse(readFileSync(profilePath,'utf8'));delete profile.wallet;writeFileSync(profilePath,JSON.stringify(profile));
  const market={snapshot:async({now})=>({at:now,cashWei:'0',positions:[],candidates:[]})};
  expect(await main(['trader','run','--once','--json'],{...deps,market})).toBe(1);
  expect(await main(['trader','run','--once','--wallet','trading','--json'],{...deps,market})).toBe(0);
  expect(deps.walletFactory).not.toHaveBeenCalled();
  expect(JSON.stringify(requests)).not.toContain(owner.privateKey);expect(JSON.stringify(requests)).not.toContain(trading.privateKey);
  envelope={...envelope,releaseId:'different-release'};
  expect(await main(['trader','arm','--json'],deps)).toBe(1);expect(claims).toBe(1);
},120000);
it('keeps a known receipt locally settled while durable hosted pending prevents new signatures',async()=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-trader-hosted-settle-')),paths=profilePaths({home});let mature=false;
  const hash='0x'+'ab'.repeat(32),calls=[];
  const relay={request:async(path,body)=>{calls.push({path,body});if(path.endsWith('/reconcile')){if(!mature)throw Object.assign(Error('Not final'),{code:'receipt-not-final'});return {settled:true,txHash:hash};}return {exclusive:true};}};
  const services=createHostedServices({relay,paths});
  await expect(services.onReconciled({receipt:{id:'trade',txHash:hash,status:1,at:Date.now()}})).resolves.toBeUndefined();
  expect(services.hasHostedPending()).toBe(true);
  await expect(services.authority({intent:null})).rejects.toThrow(/hosted-reconciliation-pending/);
  expect(calls.some(c=>c.path.endsWith('/read'))).toBe(false);
  const restarted=createHostedServices({relay,paths});expect(restarted.hasHostedPending()).toBe(true);
  mature=true;await restarted.reconcileHosted();expect(restarted.hasHostedPending()).toBe(false);
  expect(await restarted.authority({intent:null})).toEqual({exclusive:true});
});
