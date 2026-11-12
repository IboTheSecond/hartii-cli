import {Interface} from 'quais';
import {runSwap} from './swap.js';
import {runBalance} from './balance.js';
import {readRuntime} from '../commandContext.js';
import {assertMarketNetwork} from '../marketApi.js';
import {assertChainId} from '../network.js';
import {createProvider} from '../signer.js';
import {hartiiSwapAddresses} from '../liveAddresses.js';
import {readGasPrice} from '../gasPrice.js';
import {WalletError} from '../keystore.js';
import {assertCyprus1QuaiAddress} from '../address.js';
import {redactUrls} from '../output.js';
import {transactionIntentDigest} from '../writePipeline.js';
import {formatAmount} from '../amount.js';
import {DeskError,captureDecision,normalizeAuthority,uint} from '../desk/model.js';
import {DeskStore,summarizeDecision} from '../desk/store.js';
import {readDecisionEvidence} from '../desk/reconcile.js';
import {makeDeskExport,renderDeskReport} from '../desk/report.js';
import {atomicPrivateWrite} from '../secureFiles.js';
import {resolve,extname} from 'node:path';

const route=new Interface(['function getAmountsOut(uint256,address[]) view returns (uint256[])']);
const requireThat=(value,message)=>{if(!value)throw new DeskError(message);};
const cleanText=value=>typeof value==='string'?value.slice(0,500):null;
const baseUnits=value=>{try{return uint(value).toString();}catch{return null;}};
function flags(opts,allowed){for(const key of Object.keys(opts.flags??{}))requireThat(allowed.includes(key),'Unsupported desk option. Run hartii help desk.');}
function limit(value){if(value===undefined)return 25;requireThat(typeof value==='string'&&/^[1-9][0-9]{0,2}$/.test(value)&&Number(value)<=100,'Journal limit must be 1–100.');return Number(value);}
function noArgs(args){requireThat(!args?.length,'Unexpected desk argument. Run hartii help desk.');}
function saveExport(out,input,home){
  requireThat(typeof out==='string'&&out.length>0,'Use --out <report.html|report.json>.');const path=resolve(out),extension=extname(path).toLowerCase();
  requireThat(['.html','.json'].includes(extension),'Desk exports use .html or .json.');
  requireThat(!/[\\/](keystore|secrets|\.[^\\/]+)([\\/]|$)/i.test(path),'Choose a report location outside protected configuration folders.');
  if(home)requireThat(!path.toLowerCase().startsWith(resolve(home,'desk').toLowerCase()+'\\')&&!path.toLowerCase().startsWith(resolve(home,'desk').toLowerCase()+'/'),'Export outside the private journal directory.');
  const data=makeDeskExport(input),body=extension==='.html'?renderDeskReport({...input,exportedAt:data.exportedAt}):JSON.stringify(data,null,2)+'\n';atomicPrivateWrite(path,body);return path;
}
async function positions(opts,deps){
  const {net}=readRuntime(opts,deps);assertMarketNetwork(net.name);await assertChainId(net.rpcUrl,9,{fetchFn:deps.fetchFn});
  const balance=await runBalance({...opts,tokens:true},{...deps});
  const holdings=balance.holdingsError?null:Array.isArray(balance.holdings)?balance.holdings:null;
  const rows=holdings?.slice(0,200).map(h=>{let address=null;try{address=assertCyprus1QuaiAddress(h.tokenAddress??h.address);}catch{}const indexedValueWei=baseUnits(h.valueQuai);return {address,symbol:cleanText(h.symbol),balanceUnits:baseUnits(h.balance),indexedValueWei,indexedValueQuai:indexedValueWei===null?null:formatAmount(indexedValueWei),priceSource:cleanText(h.priceSource),priceObservationAt:null,costBasisWei:null,realizedPnlWei:null,unrealizedPnlWei:null};})??null;
  return {ok:true,desk:{view:'positions',network:net.name,account:balance.wallet,nativeBalanceWei:balance.quaiWei,positions:rows,partial:rows===null||holdings.length>200||rows.some(h=>!h.address||h.balanceUnits===null||h.indexedValueWei===null),reason:rows===null?'Indexed token holdings are unavailable.':null,coverage:'Current wallet native balance plus at most 200 tokens returned by the Labs index; not all assets or liquidation proceeds. Indexed mark timestamps are not carried here; marks are not fresh execution quotes.',basis:'Historical lot basis and realized P&L are unknown. No personal trader was started.',observedAt:deps.clock?.()??Date.now()}};
}
function fixtureRecord(){
  const live=hartiiSwapAddresses('mainnet'),from='0x00112233445566778899AABbCCdDeeFf00112233';
  const token='0x002233445566778899AaBBccDdeEfF0011223344';
  // Addresses are normalized by the model; fixture output has no signing or network path.
  const tx={from:from.toLowerCase(),to:live.router,value:1000000000000000000n,data:new Interface(['function swapExactETHForTokens(uint256,address[],address,uint256) payable returns(uint256[])']).encodeFunctionData('swapExactETHForTokens',[97000000n,[live.wquai,token.toLowerCase()],from.toLowerCase(),2000000000]),nonce:0,chainId:9n,gasLimit:120000n,gasPrice:1000000000n,accessList:[]};
  const r=captureDecision({action:'Example QUAI → TOK',chainId:9,from:tx.from,to:tx.to,nonce:0,expectedOut:'100',minOut:'97',amountIn:'1',expectedOutUnits:'100000000',minimumOutUnits:'97000000',assetOutDecimals:'6',slippageBps:'300'},tx,{router:live.router,wquai:live.wquai,at:Date.now()});
  r.txHash='0x'+'de'.repeat(32);r.phase='observed';r.broadcastMayHaveStarted=true;r.outcome={status:'confirmed',observedAt:Date.now(),gasFeeWei:'80000000000000',gasSource:'fixture',output:{eventDerivedUnits:'99000000',balanceVerified:false,kind:'fixture',reason:'Illustrative data only.'},quoteDifferenceUnits:'-1000000',realizedPnlWei:null,reason:'Fixture; not chain evidence.'};r.observations=[r.outcome];return r;
}
async function swapWithLedger(opts,deps){
  requireThat(!opts.yes,'Desk execution does not accept --yes. Review and confirm each transaction, or use preview.');
  const {net}=readRuntime(opts,deps);assertMarketNetwork(net.name);const live=hartiiSwapAddresses(net.name);requireThat(live?.router&&live?.wquai,'Bundled HartiiSwap provenance is unavailable.');
  const store=new DeskStore(opts.home),captured=new Map(),signed=new Map(),clock=deps.clock??Date.now,startedAt=clock(),original=deps.io??{};
  let activeProvider,recordingError=null;
  const fresh=()=>{const elapsed=clock()-startedAt;if(!Number.isSafeInteger(elapsed)||elapsed<0||elapsed>300000)throw new WalletError('Desk quote operation exceeded five minutes. Review fresh terms.');};
  const sync=(fn,arg)=>{if(fn===undefined)return;requireThat(typeof fn==='function','Invalid trusted local callback.');const result=fn(arg);requireThat(!result||typeof result.then!=='function','This trusted callback must be synchronous.');};
  const io={...original,
    validateBeforeSubmit:arg=>{fresh();sync(original.validateBeforeSubmit,arg);try{const record=captureDecision(arg.summary,arg.transaction,{router:live.router,wquai:live.wquai,at:clock()});store.capture(record);captured.set(record.intentDigest,record.id);}catch(error){recordingError=error.message;throw error;}},
    onSignedTransaction:async arg=>{
      const id=captured.get(transactionIntentDigest(arg.transaction));requireThat(id,'Signed transaction has no recorded review.');store.signed(id,arg.txHash,arg.transaction);signed.set(arg.txHash,id);
      if(original.onSignedTransaction!==undefined){requireThat(typeof original.onSignedTransaction==='function','Invalid trusted signing continuation.');await original.onSignedTransaction(arg);}
      fresh();const tx=normalizeAuthority(arg.transaction),[price,estimate]=await Promise.all([readGasPrice(activeProvider,net.rpcUrl),activeProvider.estimateGas(arg.transaction)]);const currentPrice=uint(price),currentEstimate=uint(estimate),oldPrice=BigInt(tx.gasPrice),oldLimit=BigInt(tx.gasLimit),nextLimit=currentEstimate*120n/100n;
      if(currentPrice*100n>oldPrice*120n||currentPrice*100n<oldPrice*80n||nextLimit*100n>oldLimit*120n||nextLimit*100n<oldLimit*80n||currentEstimate>oldLimit)throw new WalletError('Desk gas terms moved beyond the reviewed limits. Nothing was broadcast; review fresh terms.');
      const record=store.get(id);if(record.trade.kind==='swap'){const data=route.encodeFunctionData('getAmountsOut',[record.trade.inputUnits,record.trade.path]);const quote=route.decodeFunctionResult('getAmountsOut',await activeProvider.call({to:live.router,data}))[0];if(uint(quote.at(-1))<BigInt(record.trade.minimumOutUnits))throw new WalletError('Desk fresh quote is below the reviewed minimum. Nothing was broadcast.');}
    },
    onBroadcastStarted:arg=>{fresh();sync(original.onBroadcastStarted,arg);const id=signed.get(arg.txHash);requireThat(id,'Broadcast marker has no locally verified hash.');store.broadcast(id,arg.txHash);},
  };
  let result;
  try{result=await runSwap({...opts,tokenIn:opts.args[0],tokenOut:opts.args[1],amount:opts.args[2],slippage:opts.flags?.slippage,yes:false,json:opts.json},{...deps,io,providerFactory:url=>{activeProvider=(deps.providerFactory??createProvider)(url);return activeProvider;}});}
  catch(error){result={ok:false,error:redactUrls(error?.message??'The guarded swap failed.'),txHash:typeof error.txHash==='string'?error.txHash:undefined,status:error.status??'not-completed'};}
  const decisions=[];const warnings=[];
  for(const id of captured.values()){
    try{const r=store.get(id);if(r.txHash&&r.broadcastMayHaveStarted){const outcome=await readDecisionEvidence(r,opts,deps);store.observe(id,outcome);}decisions.push(summarizeDecision(store.get(id)));}
    catch{warnings.push('A receipt observation could not be saved. Preserve the native swap result and inspect the recorded hash; do not repeat a trade to repair the report.');try{decisions.push(summarizeDecision(store.get(id)));}catch{}}
  }
  return {...result,desk:{view:'decisions',decisions,warnings,recordingError,coverage:'One bundled HartiiSwap router; approvals are separate decisions. Ledger observations do not release native spending reservations.',note:'Signed and broadcast markers are local evidence. Only a matching canonical receipt establishes the observed mined outcome.'}};
}
export async function runDesk(opts={},deps={}){
  const sub=opts.sub??'status',args=opts.args??[];
  if(opts.demo){flags(opts,['out']);const record=fixtureRecord(),output=opts.flags?.out?saveExport(opts.flags.out,{demo:true,records:[record]},opts.home):undefined;return {ok:true,demo:true,desk:{view:'journal',demo:true,records:[record],decisions:[summarizeDecision(record)],output,note:'Fixture data only; no wallet, node or local trading journal was used.'}};}
  if(sub==='positions'){flags(opts,['address','allow-insecure-rpc']);noArgs(args);return positions(opts,deps);}
  if(sub==='preview'||(sub==='swap'&&opts.dryRun)){
    flags(opts,['slippage','max-fee','allow-insecure-rpc','stdin']);requireThat(args.length===3,'Usage: hartii desk preview <in> <out> <amount>');const result=await runSwap({...opts,tokenIn:args[0],tokenOut:args[1],amount:args[2],slippage:opts.flags?.slippage,dryRun:true},deps);return {...result,desk:{view:'preview',previewScope:result.tradeSimulated===false?'approval-only':'swap',note:'Read-only preflight. No decision was signed or durably authorized; desk swap obtains a fresh quote and manual confirmation.'}};
  }
  if(sub==='swap'){flags(opts,['slippage','max-fee','allow-insecure-rpc','stdin']);requireThat(args.length===3,'Usage: hartii desk swap <in> <out> <amount>');return swapWithLedger({...opts,args},deps);}
  const store=new DeskStore(opts.home);
  if(sub==='export'){flags(opts,['day','limit','before','out']);noArgs(args);const journal=store.list({day:opts.flags?.day,limit:limit(opts.flags?.limit),before:opts.flags?.before}),records=journal.records.map(row=>store.get(row.id)),output=saveExport(opts.flags?.out,{records,coverage:journal.coverage+(journal.nextCursor?' More records exist beyond this selection.':'')},opts.home);return {ok:true,desk:{view:'export',output,count:records.length,nextCursor:journal.nextCursor,note:'Private evidence export. Existing files were not overwritten.'}};}
  if(sub==='status'||sub==='journal'){flags(opts,['day','limit','before']);noArgs(args);const journal=store.list({day:opts.flags?.day,limit:limit(opts.flags?.limit),before:opts.flags?.before});return {ok:true,desk:{view:'journal',...journal,note:'Showing only the selected UTC day '+journal.day+'. Default: today UTC. Use --day YYYY-MM-DD for earlier decisions; hartii tx pending shows native unresolved reservations.'}};}
  if(sub==='receipt'){flags(opts,['allow-insecure-rpc']);requireThat(args.length===1,'Usage: hartii desk receipt <decision-id>');const record=store.get(args[0]);const outcome=await readDecisionEvidence(record,opts,deps);store.observe(record.id,outcome);return {ok:true,desk:{view:'decisions',decisions:[summarizeDecision(store.get(record.id))],note:'Receipt observation only; native spending reservations are not changed.'}};}
  throw new DeskError('Unknown desk command. Run hartii help desk.');
}
