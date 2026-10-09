import { Interface } from 'quais';
import { TraderError, validatePolicy, HBOME_TOKEN,canonicalJson } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { runBuy } from '../commands/buy.js';
import { runSell } from '../commands/sell.js';
import { runSwap } from '../commands/swap.js';
import { formatAmount } from '../amount.js';
import { BONDING_CURVE_ABI, BONDING_CURVE_V3_TRADE_ABI } from '../abi/bondingCurve.js';
import { HARTIISWAP_ROUTER_ABI } from '../abi/hartiiSwapRouter.js';
import { ERC20_ABI } from '../abi/erc20.js';
import { hartiiSwapAddresses } from '../liveAddresses.js';
import { assertVerifiedCurve } from '../curveState.js';
import { assertCyprus1QuaiAddress } from '../address.js';
import { readRuntime, withProviderCleanup, marketRuntime, writeVia } from '../commandContext.js';
import { createProvider } from '../signer.js';
import { listSpendReservations, settleSpend, withSpendLock } from '../spendingGuard.js';
import { createHash } from 'node:crypto';
const dataDigest = data => '0x' + createHash('sha256').update(String(data).toLowerCase()).digest('hex');

const curveV1=new Interface(BONDING_CURVE_ABI),curveV3=new Interface(BONDING_CURVE_V3_TRADE_ABI),swap=new Interface(HARTIISWAP_ROUTER_ABI);
const events=new Interface(['event Buy(address indexed buyer,uint256 quaiIn,uint256 tokensOut,uint256 fee)','event Sell(address indexed seller,uint256 tokensIn,uint256 quaiOut,uint256 fee)']);
const pairAbi=new Interface(['function getPair(address,address) view returns(address)','function token0() view returns(address)','function token1() view returns(address)', 'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)']);
const transfers=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const tokenAbi=new Interface([...ERC20_ABI,'event Approval(address indexed owner,address indexed spender,uint256 value)']);
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const reject=code=>{throw new TraderError(code);};
const deferred=()=>{let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

export function validateTraderTransaction({transaction:tx,intent,quote,policy,now=Date.now(),paused=false}) {
  validatePolicy(policy,{now});
  if(paused)reject('runner-paused');
  if(!policy.allowedActions.includes(intent.action==='approve'?'sell':intent.action) || !policy.allowedVenues.includes(intent.venue))reject('policy-action-denied');
  if(!Number.isSafeInteger(quote.at) || quote.at>now || now-quote.at>30000 || intent.action!=='approve' && BigInt(quote.minOutputWei)<=0n)reject('transaction-quote-expired-or-invalid');
  if(same(intent.token,HBOME_TOKEN) || !same(tx.from,policy.tradingWallet) || BigInt(tx.chainId)!==9n || !same(quote.authority?.token,intent.token))reject('transaction-authority-mismatch');
  if(BigInt(tx.gasLimit)*BigInt(tx.gasPrice)>BigInt(intent.gasWei) || BigInt(tx.gasLimit)*BigInt(tx.gasPrice)>BigInt(policy.maxFeeWei))reject('transaction-gas-changed');
  if(intent.action==='approve') {
    const approval=quote.approval,decoded=tokenAbi.parseTransaction({data:tx.data});
    if(approval?.required!==true || !same(tx.to,intent.token) || !same(approval.token,intent.token) || !same(approval.spender,intent.spender) || !same(intent.spender,quote.executionTarget) ||
      !same(intent.spender,quote.authority?.to) || decoded?.name!=='approve' || !same(decoded.args[0],intent.spender) || BigInt(decoded.args[1])!==BigInt(intent.units) || approval.units!==intent.units ||
      BigInt(intent.units)<=0n || BigInt(tx.value)!==0n || intent.amountWei!=='0' || typeof intent.positionId!=='string')reject('approval-authority-mismatch');
    return;
  }
  if(!same(tx.to,quote.authority?.to))reject('transaction-authority-mismatch');
  let decoded;
  if(intent.venue==='hartii-swap') {
    decoded=swap.parseTransaction({data:tx.data});
    const expected=intent.action==='buy'?'swapExactETHForTokens':'swapExactTokensForETH';
    if(decoded?.name!==expected)reject('approval-or-route-not-authorized');
    const addresses=hartiiSwapAddresses(),path=decoded.args.path;
    if(!same(tx.to,addresses.router) || path.length!==2 || !same(decoded.args.to,policy.tradingWallet) ||
      !same(path[0],intent.action==='buy'?addresses.wquai:intent.token) || !same(path[1],intent.action==='buy'?intent.token:addresses.wquai))reject('transaction-authority-mismatch');
    if(BigInt(decoded.args.amountOutMin)<BigInt(quote.minOutputWei) || Number(decoded.args.deadline)*1000<=now)reject('transaction-floor-or-expiry');
    if(intent.action==='sell' && BigInt(decoded.args.amountIn)!==BigInt(intent.units))reject('transaction-amount-changed');
  } else {
    try {decoded=(['curve-v3','curve-v4'].includes(intent.venue)?curveV3:curveV1).parseTransaction({data:tx.data});}catch {reject('approval-or-route-not-authorized');}
    if(decoded?.name!==intent.action)reject('approval-or-route-not-authorized');
    const floor=decoded.args[intent.action==='buy'?0:1];
    if(BigInt(floor)<BigInt(quote.minOutputWei))reject('transaction-minimum-output-reduced');
    if(intent.action==='sell' && BigInt(decoded.args[0])!==BigInt(intent.units))reject('transaction-amount-changed');
    if(['curve-v3','curve-v4'].includes(intent.venue) && Number(decoded.args.at(-1))*1000<=now)reject('transaction-expired');
  }
  if(BigInt(tx.value)!==(intent.action==='buy'?BigInt(intent.amountWei):0n))reject('transaction-value-changed');
}

async function runApproval(opts,deps,intent) {
  return withProviderCleanup(deps,async runtimeDeps=>{
    const ctx=await marketRuntime(opts,runtimeDeps);
    const token=assertCyprus1QuaiAddress(intent.token),spender=assertCyprus1QuaiAddress(intent.spender);
    if(intent.venue==='hartii-swap') {if(!same(spender,hartiiSwapAddresses()?.router))reject('approval-route-mismatch');}
    else await assertVerifiedCurve(ctx.provider,spender,token,'mainnet');
    return writeVia(ctx,{to:token,data:tokenAbi.encodeFunctionData('approve',[spender,BigInt(intent.units)]),value:0n,spendWei:0n,action:'Approve exact managed-position exit',
      extraSummary:{tokenAddress:token,spender,approvedUnits:intent.units,positionId:intent.positionId},
      validateSimulation:raw=>{if(raw!=='0x' && tokenAbi.decodeFunctionResult('approve',raw)[0]!==true)reject('approval-simulation-failed');}});
  });
}

/** Bridge the existing guarded buy/sell/swap commands. No second signing or spend pipeline. */
export function createLiveExecutor(opts={},deps={}) {
  const active=new WeakMap(),failedPreparations=new WeakMap(),clock=deps.clock || Date.now;
  async function readReceipt(pending,transaction) {
    const runtime=readRuntime(opts,deps),provider=(deps.providerFactory || createProvider)(runtime.net.rpcUrl);
    try {
      if(BigInt((await provider.getNetwork()).chainId)!==9n)reject('invalid-market-network');
      const receipt=await provider.getTransactionReceipt(pending.txHash);
      if(!receipt)return null;
      const tx=transaction || await provider.getTransaction(pending.txHash);
      if(!tx || !same(tx.hash || pending.txHash,pending.txHash) || !same(tx.from,opts.tradingWallet) ||
        !same(receipt.hash || receipt.transactionHash,pending.txHash) || receipt.from && !same(receipt.from,tx.from) || receipt.to && !same(receipt.to,tx.to) || BigInt(tx.chainId)!==9n)reject('receipt-identity-mismatch');
      const status=[1,1n,'0x1','1'].includes(receipt.status)?1:[0,0n,'0x0','0'].includes(receipt.status)?0:null;
      if(status===null)return null;
      const fee=receipt.fee ?? (receipt.gasUsed!=null && (receipt.gasPrice ?? receipt.effectiveGasPrice)!=null ? BigInt(receipt.gasUsed)*BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice):null);
      if(fee===null || BigInt(fee)<0n)reject('receipt-gas-unavailable');
      let amount=0n,units=0n;
      if(status===1) {
        if(pending.action==='approve') {
          if(!same(tx.to,pending.token))reject('receipt-approval-token-mismatch');
          const decoded=tokenAbi.parseTransaction({data:tx.data});
          if(decoded?.name!=='approve' || !same(decoded.args[0],pending.spender) || BigInt(decoded.args[1])!==BigInt(pending.units) || BigInt(tx.value)!==0n)reject('receipt-approval-authority-mismatch');
          if(pending.venue==='hartii-swap') {if(!same(pending.spender,hartiiSwapAddresses()?.router))reject('receipt-approval-route-mismatch');}
          else await assertVerifiedCurve(provider,pending.spender,pending.token,'mainnet');
          const approvals=(receipt.logs || []).filter(log=>same(log.address,pending.token)).flatMap(log=>{try{return [tokenAbi.parseLog(log)];}catch{return [];}})
            .filter(log=>log?.name==='Approval' && same(log.args.owner,opts.tradingWallet) && same(log.args.spender,pending.spender) && BigInt(log.args.value)===BigInt(pending.units));
          if(approvals.length!==1)reject('receipt-approval-event-unavailable');
        } else if(pending.venue==='hartii-swap') {
          const addresses=hartiiSwapAddresses();
          if(!same(tx.to,addresses.router))reject('receipt-route-mismatch');
          const read=async(to,fn,args=[])=>pairAbi.decodeFunctionResult(fn,await provider.call({to:assertCyprus1QuaiAddress(to),data:pairAbi.encodeFunctionData(fn,args)}))[0];
          const bound=await read(addresses.factory,'getPair',[pending.token,addresses.wquai]);
          const [a,b]=await Promise.all([read(bound,'token0'),read(bound,'token1')]);
          if(![a,b].some(v=>same(v,pending.token)) || ![a,b].some(v=>same(v,addresses.wquai)))reject('receipt-route-mismatch');
          const swaps=(receipt.logs || []).filter(l=>same(l.address,bound)).flatMap(l=>{try{return [pairAbi.parseLog(l)];}catch{return [];}}).filter(l=>l?.name==='Swap' && same(l.args.sender,addresses.router));
          if(swaps.length!==1)reject('receipt-trade-event-unavailable');
          const e=swaps[0].args,native0=same(a,addresses.wquai);
          amount=BigInt(pending.action==='buy'?(native0?e.amount0In:e.amount1In):(native0?e.amount0Out:e.amount1Out));
          units=BigInt(pending.action==='buy'?(native0?e.amount1Out:e.amount0Out):(native0?e.amount1In:e.amount0In));
          const logs=(receipt.logs || []).filter(l=>same(l.address,pending.token)).flatMap(l=>{try{return [transfers.parseLog(l)];}catch{return [];}}).filter(l=>l?.name==='Transfer');
          const delta=logs.reduce((n,l)=>n+(same(l.args.to,opts.tradingWallet)?BigInt(l.args.value):0n)-(same(l.args.from,opts.tradingWallet)?BigInt(l.args.value):0n),0n);
          if(delta!==(pending.action==='buy'?units:-units))reject('receipt-token-delta-mismatch');
        } else {
        await assertVerifiedCurve(provider,tx.to,pending.token,'mainnet');
        const matches=(receipt.logs || []).filter(log=>same(log.address,tx.to)).flatMap(log=>{try{return [events.parseLog(log)];}catch{return [];}}).filter(log=>log?.name===(pending.action==='buy'?'Buy':'Sell') && same(log.args[0],opts.tradingWallet));
        if(matches.length!==1)reject('receipt-trade-event-unavailable');
        const args=matches[0].args;
        amount=BigInt(args[pending.action==='buy'?1:2]); units=BigInt(args[pending.action==='buy'?2:1]);
        }
        if(pending.action==='buy' && BigInt(tx.value)!==amount || pending.action==='sell' && units!==BigInt(pending.units))reject('receipt-trade-mismatch');
      }
      // The original CLI reservation also remains durable through unknown outcomes. Settle
      // it only against this exact signed transaction and complete, final receipt evidence.
      await withSpendLock(runtime.home,opts.tradingWallet,async()=>{
        const rows=listSpendReservations(runtime.home,opts.tradingWallet).filter(r=>same(r.txHash,pending.txHash));
        if(rows.length>1)reject('duplicate-spend-reservation');
        if(rows.length) {
          const r=rows[0];
          if(r.legacy || r.chainId!=='9' || r.nonce!==tx.nonce || !same(r.to,tx.to) || BigInt(r.valueWei)!==BigInt(tx.value) || r.dataDigest!==dataDigest(tx.data))reject('reservation-authority-mismatch');
          settleSpend(runtime.home,opts.tradingWallet,r.id,{confirmed:status===1,chargedWei:BigInt(fee)+(status===1?BigInt(r.guardedValueWei):0n)});
        }
      });
      const normalized={id:pending.id,txHash:pending.txHash,status,gasWei:String(fee),amountWei:String(amount),units:String(units),at:clock()};
      if(deps.onReconciled)await deps.onReconciled({intent:structuredClone(pending),receipt:normalized});
      return normalized;
    } finally {provider.destroy?.();}
  }
  return {
    async prepare({intent,quote,policy}) {
      intent=structuredClone(intent);quote=structuredClone(quote);policy=structuredClone(policy);
      validatePolicy(policy,{now:clock(),tradingWallet:opts.tradingWallet});
      if(!opts.wallet)reject('encrypted-trading-wallet-required');
      const ready=deferred(),permit=deferred(),opaque=Object.freeze({}),state={permit,intent:structuredClone(intent),policy:structuredClone(policy),intentId:intent.id,hookReached:false,txHash:null,transaction:null,permitReleased:false,broadcastStarted:false,cancelled:false,completed:false};
      active.set(opaque,state);
      const validate=({transaction})=>validateTraderTransaction({transaction,intent,quote,policy,now:clock(),paused:deps.isPaused?.()===true});
      const io={...deps.io,write:()=>{},writeErr:()=>{},maxFeeWei:policy.maxFeeWei,validateBeforeSubmit:validate,
        onBroadcastStarted:({txHash})=>{if(!same(txHash,state.txHash) || !state.permitReleased || state.cancelled)reject('invalid-native-dispatch');state.broadcastStarted=true;},
        managedExitBudget:intent.action==='sell'?details=>{
          validatePolicy(policy,{now:clock()});
          if(details.action!=='sell' || details.chainId!==9 || !same(details.from,policy.tradingWallet) || !same(details.token,intent.token) || !same(details.spender,quote.authority?.to) ||
            details.units!==intent.units || !policy.allowedActions.includes('sell') || !policy.allowedVenues.includes(intent.venue))reject('managed-exit-budget-mismatch');
          return 0n;
        }:undefined,
        onSignedTransaction:async({txHash,transaction})=>{
          state.hookReached=true;
          if(state.txHash)reject('multiple-transactions-refused');
          validate({transaction});state.txHash=txHash;state.transaction=transaction;
          ready.resolve({txHash,prepared:opaque});
          await permit.promise;
        }};
      const base={home:opts.home,wallet:opts.wallet,network:'mainnet',rpc:opts.rpc,allowInsecureRpc:opts.allowInsecureRpc,yes:true,json:true,slippage:String(policy.slippageBps/100)};
      const run=intent.action==='approve'?(o,d)=>runApproval(o,d,intent):intent.venue==='hartii-swap'?runSwap:intent.action==='buy'?runBuy:runSell;
      const params=intent.action==='approve'?{}:intent.venue==='hartii-swap'?{tokenIn:intent.action==='buy'?'QUAI':intent.token,tokenOut:intent.action==='buy'?intent.token:'QUAI',amount:formatAmount(BigInt(intent.action==='buy'?intent.amountWei:intent.units),intent.action==='buy'?18:quote.tokenDecimals)}:
        intent.action==='buy'?{token:intent.token,quai:formatAmount(BigInt(intent.amountWei))}:{token:intent.token,amount:formatAmount(BigInt(intent.units),quote.tokenDecimals)};
      const nativeOutflow=BigInt(intent.gasWei)+(intent.action==='buy'?BigInt(intent.amountWei):0n);
      state.operation=Promise.resolve().then(()=>run({...base,...params},{...deps,io,limits:{perTxQuai:formatAmount(nativeOutflow),dailyQuai:formatAmount(BigInt(policy.maxPerDayWei))}}))
        .then(result=>{state.completed=true; if(!state.txHash)ready.reject(new TraderError('transaction-not-prepared'));return {result};},error=>{state.completed=true;if(error && typeof error==='object')failedPreparations.set(error,state);ready.reject(error);return {error};});
      return ready.promise;
    },
    async broadcast({prepared,intent,txHash}) {
      const state=active.get(prepared);
      if(!state || state.cancelled || state.permitReleased || state.broadcastStarted || !same(txHash,state.txHash) || canonicalJson(intent)!==canonicalJson(state.intent))reject('invalid-prepared-transaction');
      if(deps.onPrepared)await deps.onPrepared({intent:structuredClone(state.intent),policy:structuredClone(state.policy),txHash,transaction:structuredClone(state.transaction)});
      state.permitReleased=true;state.permit.resolve();
      const outcome=await state.operation;
      if(outcome.error && outcome.error.status!=='reverted')throw outcome.error;
      return readReceipt({...intent,txHash},state.transaction);
    },
    async discard(prepared) {
      const state=active.get(prepared);
      if(!state || state.broadcastStarted || !state.txHash)reject('cancellation-not-proven');
      state.cancelled=true;if(!state.permitReleased)state.permit.reject(new TraderError('local-prepared-cancellation'));
      await state.operation;
      if(!state.completed || state.broadcastStarted)reject('cancellation-not-proven');
      return {cancelled:true,broadcastStarted:false,completed:true,intentId:state.intentId,txHash:state.txHash};
    },
    async discardFailedPrepare({error,intentId}) {
      const state=error && typeof error==='object'?failedPreparations.get(error):null;
      if(!state || !state.completed || state.hookReached || state.broadcastStarted || state.txHash!==null || state.intentId!==intentId)reject('failed-prepare-cancellation-not-proven');
      state.cancelled=true;return {cancelled:true,broadcastStarted:false,completed:true,intentId,txHash:null};
    },
    receipt:pending=>readReceipt(pending),
  };
}
