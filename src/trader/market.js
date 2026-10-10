import { Interface, Zone } from 'quais';
import { TraderError, HBOME_TOKEN, closedCandles, validatePolicy } from '../../vendor/packages/hartii-trader/src/index.mjs';
import { assertCyprus1QuaiAddress } from '../address.js';
import { readRuntime } from '../commandContext.js';
import { createProvider } from '../signer.js';
import { fetchTokens, fetchToken, API_BASE } from '../marketApi.js';
import { assertFactoryCurve, assertCurveToken, readCurveMeta } from '../curveState.js';
import { quoteAndBuildBuy, quoteAndBuildSell } from '../trade.js';
import { hartiiSwapAddresses, loadLiveAddresses, launchFactories } from '../liveAddresses.js';
import { HARTIISWAP_ROUTER_ABI } from '../abi/hartiiSwapRouter.js';
import { ERC20_ABI } from '../abi/erc20.js';

const erc=new Interface(ERC20_ABI), router=new Interface(HARTIISWAP_ROUTER_ABI);
const factory=new Interface(['function getPair(address,address) view returns(address)']);
const pair=new Interface(['function token0() view returns(address)','function token1() view returns(address)','function factory() view returns(address)']);
const snipe=new Interface(['function launchBlock() view returns(uint256)','function snipeWindowBlocks() view returns(uint256)','function SNIPE_WINDOW_BLOCKS() view returns(uint256)']);
const same=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const uint=(value)=>{if(!/^(0|[1-9][0-9]*)$/.test(String(value)))throw new TraderError('invalid-market-money');return BigInt(value);};
const ceil=(a,b)=>(a+b-1n)/b;
/** A declared maximum monetary fee, never a claim about estimated gas units. */
export function createPolicyFeeReserve(policy,{clock=Date.now}={}) {
  validatePolicy(policy,{now:policy.issuedAt});
  return async({approvalTransaction})=>({basis:'policy-fee-ceiling',gasWei:policy.maxFeeWei,...(approvalTransaction?{approvalGasWei:policy.maxFeeWei}:{}),
    checkedAt:clock(),evidence:`Policy nonce ${policy.nonce}: at most ${policy.maxFeeWei} wei per native transaction. Actual execution must fit this ceiling.`});
}
async function call(provider,to,abi,method,args=[]) {
  const raw=await provider.call({to:assertCyprus1QuaiAddress(to),data:abi.encodeFunctionData(method,args)});
  return abi.decodeFunctionResult(method,raw)[0];
}
export function decodeCandles(body,token,now) {
  if(!body || !same(body.address,token) || body.note || !Array.isArray(body.items)) throw new TraderError('candles-unavailable');
  const at=Date.parse(body.at);
  if(!Number.isSafeInteger(at) || at>now+1000 || now-at>30000) throw new TraderError('feed-stale');
  const candles=body.items.map(c=>{
    if(c.tf!=='1m' || !Number.isSafeInteger(c.bucketStart)) throw new TraderError('invalid-candle-window');
    return {openTime:c.bucketStart*1000,closeTime:(c.bucketStart+60)*1000,closeWei:uint(c.close).toString(),volumeWei:uint(c.volumeQuai).toString()};
  });
  return closedCandles(candles,now); // Never fill missing minutes or treat an open candle as closed.
}
/** API addresses are hints only; each usable route is bound by the bundled on-chain factory. */
export async function readVerifiedRoute(provider,info,now,preferredVenue) {
  const token=assertCyprus1QuaiAddress(info.address);
  if(same(token,HBOME_TOKEN)) throw new TraderError('hbome-excluded');
  if(info.network && info.network!=='mainnet') throw new TraderError('unverified-route');
  if(typeof provider.getCode!=='function' || await provider.getCode(token)==='0x') throw new TraderError('token-code-unavailable');
  let launchEvidence;
  if(info.curveAddress) {
    const target=assertCyprus1QuaiAddress(info.curveAddress);
    const verifiedFactory=await assertFactoryCurve(provider,target,token,'mainnet');
    await assertCurveToken(provider,target,token);
    const meta=await readCurveMeta(provider,target), addresses=loadLiveAddresses().data.mainnet;
    let version=1;
    for(const [key,address] of Object.entries(addresses)) if(/^launchFactoryV[234]$/.test(key) && same(address,verifiedFactory)) version=Number(key.at(-1));
    if(meta.isV3 !== (version>=3) && !same(verifiedFactory,launchFactories()[0])) throw new TraderError('curve-generation-mismatch');
    const [launch,window,head]=await Promise.all([call(provider,target,snipe,'launchBlock'),call(provider,target,snipe,version>=3?'snipeWindowBlocks':'SNIPE_WINDOW_BLOCKS'),provider.getBlockNumber(Zone.Cyprus1)]);
    const complete=uint(head)>=uint(launch)+uint(window);
    launchEvidence={token,target,venue:`curve-v${version}`,snipeEndsAt:complete?now:now+60000,meta};
    if(preferredVenue!=='hartii-swap')return launchEvidence;
  }
  const addresses=hartiiSwapAddresses();
  if(!addresses?.factory || !addresses.router || !addresses.wquai) throw new TraderError('swap-unconfigured');
  const target=assertCyprus1QuaiAddress(addresses.router), wrapped=assertCyprus1QuaiAddress(addresses.wquai), origin=assertCyprus1QuaiAddress(addresses.factory);
  const found=await call(provider,origin,factory,'getPair',[token,wrapped]);
  if(/^0x0{40}$/i.test(found)) throw new TraderError('direct-pair-missing');
  const [a,b,f,r,w]=await Promise.all([call(provider,found,pair,'token0'),call(provider,found,pair,'token1'),call(provider,found,pair,'factory'),call(provider,target,router,'factory'),call(provider,target,router,'WETH')]);
  if(!same(f,origin) || !same(r,origin) || !same(w,wrapped) || !([a,b].some(v=>same(v,token)) && [a,b].some(v=>same(v,wrapped)))) throw new TraderError('direct-pair-binding');
  // An external token's unknown launch/snipe history is never inferred from API timestamps.
  if(!launchEvidence)throw new TraderError('external-token-launch-evidence-unavailable');
  if(await provider.getCode(found)==='0x')throw new TraderError('pair-code-unavailable');
  return {token,target,venue:'hartii-swap',pair:found,wrapped,snipeEndsAt:launchEvidence.snipeEndsAt};
}
export function createRealMarket({profile,policy,...opts},deps={}) {
  const runtime=readRuntime({...opts,network:opts.network || 'mainnet'},deps);
  if(runtime.net.chainId!==9) throw new TraderError('invalid-market-network');
  const provider=(deps.providerFactory || createProvider)(runtime.net.rpcUrl);
  const fetchFn=deps.fetchFn || fetch, from=assertCyprus1QuaiAddress(profile.tradingWallet);
  const futureExitReserve=deps.estimateFutureExit || createPolicyFeeReserve(policy,{clock:deps.clock || Date.now});
  const checkChain=async()=>{if(BigInt((await provider.getNetwork()).chainId)!==9n)throw new TraderError('invalid-market-network');};
  async function getRoute(token,now,venue) {
    const {token:info}=await fetchToken(token,{fetchFn,network:'mainnet'});
    const route=await readVerifiedRoute(provider,info,now,venue); return {...route,symbol:String(info.symbol || '').slice(0,32)};
  }
  async function gas(tx) {
    try {
      const accessList=await provider.createAccessList(tx);
      if(!Array.isArray(accessList)) throw Error();
      const complete={...tx,accessList};
      const [estimate,fees]=await Promise.all([provider.estimateGas(complete),provider.getFeeData(Zone.Cyprus1)]);
      const result=ceil(uint(estimate)*120n,100n)*uint(fees.gasPrice);
      if(result===0n)throw Error(); return result;
    } catch { throw new TraderError('complete-gas-estimate-unavailable'); }
  }
  async function quote({action,candidate,position,amountWei,units,now,mode='live',approvals=[]}) {
    await checkChain();
    const route=await getRoute(candidate.token,now,candidate.venue), tokenDecimals=Number(await call(provider,route.token,erc,'decimals'));
    if(!Number.isSafeInteger(tokenDecimals) || tokenDecimals<0 || tokenDecimals>36) throw new TraderError('unsupported-token-decimals');
    if(route.venue!==candidate.venue)throw new TraderError('route-changed');
    const amount=uint(amountWei), scale=10n**BigInt(tokenDecimals);
    const swapBuy=async(value,slippage)=>{
      const path=[route.wrapped,route.token],out=await call(provider,route.target,router,'getAmountsOut',[value,path]);
      if(out.length!==2 || BigInt(out[0])!==value)throw new TraderError('invalid-swap-quote');
      const expectedOut=BigInt(out[1]),minTokensOut=expectedOut*BigInt(10000-slippage)/10000n;
      return {valueWei:value,expectedOut,minTokensOut,data:router.encodeFunctionData('swapExactETHForTokens',[minTokensOut,path,from,Math.floor(now/1000)+300])};
    };
    const swapSell=async(value)=>{
      const path=[route.token,route.wrapped],out=await call(provider,route.target,router,'getAmountsOut',[value,path]);
      if(out.length!==2 || BigInt(out[0])!==value)throw new TraderError('invalid-swap-quote');
      const expectedOut=BigInt(out[1]),minQuaiOut=expectedOut*BigInt(10000-policy.slippageBps)/10000n;
      return {expectedOut,minQuaiOut,data:router.encodeFunctionData('swapExactTokensForETH',[value,minQuaiOut,path,from,Math.floor(now/1000)+300])};
    };
    const buy=action==='buy' ? await (route.venue==='hartii-swap'?swapBuy(amount,policy.slippageBps):quoteAndBuildBuy(provider,route.target,amount,policy.slippageBps)) : null;
    if(buy?.finishing || buy && buy.valueWei!==amount)throw new TraderError('finishing-buy-not-supported');
    const tokenUnits=buy ? buy.expectedOut : uint(units || position?.units);
    const sell=await (route.venue==='hartii-swap'?swapSell(tokenUnits):quoteAndBuildSell(provider,route.target,tokenUnits,policy.slippageBps));
    if(tokenUnits===0n || sell.expectedOut===0n)throw new TraderError('empty-quote');
    const allowance=uint(await call(provider,route.token,erc,'allowance',[from,route.target]));
    const simulatedApproval=mode==='paper' && position && approvals.some(a=>a.simulated===true && a.positionId===position.id && same(a.token,route.token) && same(a.spender,route.target) && a.units===tokenUnits.toString());
    const needsApproval=allowance<tokenUnits && !simulatedApproval;
    const approvalTransaction=needsApproval?{from,to:route.token,data:erc.encodeFunctionData('approve',[route.target,tokenUnits]),value:0n}:null;
    let approvalGas=0n,approvalEstimateFailed=false,approvalGasBasis=needsApproval?'complete-estimate':null;
    if(approvalTransaction){try {approvalGas=await gas(approvalTransaction);}catch {approvalEstimateFailed=true;}}
    // Estimates must cover the actual calldata, access list, sender and value. A node that
    // cannot estimate a future exit (e.g. allowance absent) blocks entries; no invented floor.
    const exitTransaction={from,to:route.target,data:sell.data,value:0n};
    let exitGas,exitGasBasis='complete-estimate',exitGasEvidence='Fresh complete transaction estimate with access list and gas price.';
    if(buy || needsApproval || mode==='paper') {
      const price=uint((await provider.getFeeData(Zone.Cyprus1)).gasPrice);
      const reserve=await futureExitReserve({provider,route:structuredClone(route),from,tokenUnits:tokenUnits.toString(),transaction:exitTransaction,approvalTransaction,gasPrice:price.toString()});
      const checkedNow=deps.clock?.() ?? Date.now();
      if(!['verified-generation-bound','rpc-state-override','policy-fee-ceiling'].includes(reserve?.basis) || !reserve.evidence || typeof reserve.evidence!=='string' || !Number.isSafeInteger(reserve.checkedAt) || reserve.checkedAt>checkedNow || checkedNow-reserve.checkedAt>30000)throw new TraderError('exit-gas-evidence-unavailable');
      exitGas=uint(reserve.gasWei);if(exitGas===0n)throw new TraderError('exit-gas-evidence-unavailable');
      exitGasBasis=reserve.basis;exitGasEvidence=reserve.evidence;
      if(reserve.basis==='policy-fee-ceiling' && exitGas!==uint(policy.maxFeeWei))throw new TraderError('policy-fee-reserve-mismatch');
      if(approvalEstimateFailed){approvalGas=uint(reserve.approvalGasWei);approvalGasBasis=reserve.basis;if(approvalGas===0n || reserve.basis==='policy-fee-ceiling' && approvalGas!==uint(policy.maxFeeWei))throw new TraderError('approval-gas-evidence-unavailable');}
    } else exitGas=await gas(exitTransaction);
    if(approvalEstimateFailed && approvalGas===0n)throw new TraderError('complete-approval-gas-estimate-unavailable');
    if(approvalGas>uint(policy.maxFeeWei) || exitGas>uint(policy.maxFeeWei))throw new TraderError('exit-or-approval-fee-cap');
    let entryGas=exitGas,gasBasis=exitGasBasis;
    if(buy){try {entryGas=await gas({from,to:route.target,data:buy.data,value:amount});gasBasis='complete-estimate';}
      catch(error){if(mode!=='paper')throw error;entryGas=uint(policy.maxFeeWei);gasBasis='policy-fee-ceiling';}}
    if(entryGas>uint(policy.maxFeeWei))throw new TraderError('transaction-fee-cap');
    const referenceUnits=tokenUnits/1000n || 1n;
    const reference=buy ? await (route.venue==='hartii-swap'?swapBuy(10n**16n,0):quoteAndBuildBuy(provider,route.target,10n**16n,0)):
      await (route.venue==='hartii-swap'?swapSell(referenceUnits):quoteAndBuildSell(provider,route.target,referenceUnits,0));
    const referencePrice=buy?ceil((10n**16n)*scale,reference.expectedOut):reference.expectedOut*scale/referenceUnits;
    if(referencePrice===0n)throw new TraderError('reference-price-unavailable');
    const price=buy ? ceil(amount*scale,tokenUnits) : sell.expectedOut*scale/tokenUnits;
    const delta=buy ? (price>referencePrice?price-referencePrice:0n) : (referencePrice>price?referencePrice-price:0n);
    const impactBps=Number(ceil(delta*10000n,referencePrice));
    const principal=buy ? amount : sell.expectedOut;
    const roundTripLoss=buy ? (amount>sell.expectedOut?amount-sell.expectedOut:0n) : 0n;
    const totalCost=buy?roundTripLoss+entryGas+exitGas+approvalGas:exitGas+approvalGas;
    const roundTripCostBps=Number(ceil(totalCost*10000n,principal));
    // The on-chain output already includes protocol fees and price impact. Undo only the
    // simulator's explicit impact factor in its base price, so Paper does not charge it twice.
    const impactFactor=10000n-BigInt(Math.min(impactBps,9999));
    const paperPrice=buy?ceil(amount*scale*impactFactor,tokenUnits*10000n):sell.expectedOut*scale*10000n/(tokenUnits*impactFactor);
    return {at:deps.clock?.() ?? now,impactBps,roundTripCostBps,gasWei:entryGas.toString(),exitGasWei:(exitGas+(buy?approvalGas:0n)).toString(),executionTarget:route.target,
      gasBasis,exitGasBasis,approvalGasBasis,gasEvidence:gasBasis==='complete-estimate'?'Fresh complete transaction estimate.':`Conservative monetary reserve from policy maxFeeWei=${policy.maxFeeWei}.`,exitGasEvidence,
      ...(!buy && needsApproval?{approval:{required:true,token:route.token,spender:route.target,units:tokenUnits.toString(),gasWei:approvalGas.toString()}}:{approval:{required:false}}),
      minOutputWei:(buy?buy.minTokensOut:sell.minQuaiOut).toString(),unitPriceWei:paperPrice.toString(),tokenDecimals,feeBps:0,
      expectedOutputWei:(buy?buy.expectedOut:sell.expectedOut).toString(),authority:{to:route.target,token:route.token,venue:route.venue,tokenDecimals,...(route.pair?{pair:route.pair}:{})}};
  }
  return {provider,quote,close:()=>provider.destroy?.(),async snapshot({now,positions,mode,approvals=[]}) {
    await checkChain();
    const {items}=await fetchTokens({sort:'volume',limit:25},{fetchFn,network:'mainnet'});
    const tokens=[...new Set([...positions.map(p=>p.token),...items.filter(t=>!same(t.address,HBOME_TOKEN)).map(t=>t.address)])].slice(0,50);
    const candidates=[], marks=[],quarantined=[],balances=new Map(); let unavailable=null;
    for(const token of tokens) for(const preferredVenue of [undefined,'hartii-swap']) {
      try {
        const route=await getRoute(token,deps.clock?.() ?? Date.now(),preferredVenue);
        if(!balances.has(token.toLowerCase()))balances.set(token.toLowerCase(),uint(await call(provider,route.token,erc,'balanceOf',[from])));
        const held=balances.get(token.toLowerCase()),managed=positions.filter(p=>same(p.token,token)).reduce((sum,p)=>sum+uint(p.units),0n);
        if(mode!=='paper' && held<managed)throw new TraderError('managed-token-balance-changed');
        if(mode!=='paper' && held>managed && !quarantined.some(l=>same(l.token,token)))quarantined.push({token:route.token,units:(held-managed).toString(),at:now});
        const response=await fetchFn(`${API_BASE}/api/token/${route.token}/candles?tf=1m&limit=60`,{redirect:'error',signal:AbortSignal.timeout(12000)});
        if((response.status ?? 200)>=400)throw new TraderError('candles-unavailable');
        const candles=decodeCandles(await response.json(),token,deps.clock?.() ?? Date.now());
        const candidate={id:route.token.toLowerCase()+'-'+route.venue,token:route.token,symbol:route.symbol,chainId:9,venue:route.venue,verified:true,direct:true,snipeEndsAt:route.snipeEndsAt,candles,entryQuote:null,exitQuote:null};
        const position=positions.find(p=>same(p.token,token) && p.venue===route.venue);
        if(positions.some(p=>same(p.token,token)) && !position)continue;
        const q=await quote({action:position?'sell':'buy',candidate,position,amountWei:position?.exitValueWei || (uint(policy.capitalWei)*BigInt(policy.maxEntryBps)/10000n).toString(),units:position?.units,now:deps.clock?.() ?? Date.now(),mode,approvals});
        candidate.entryQuote=q; candidate.exitQuote=q; candidates.push(candidate);
        if(position)marks.push({id:position.id,exitValueWei:q.expectedOutputWei,exitGasWei:(uint(q.exitGasWei)+(q.approval?.required?uint(q.approval.gasWei):0n)).toString()});
      } catch(error) { unavailable=error instanceof TraderError?error.code:'market-read-unavailable'; }
    }
    for(const position of positions)if(!marks.some(p=>p.id===position.id))marks.push({id:position.id,exitValueWei:null,exitGasWei:null});
    if(tokens.length && !candidates.length && unavailable)throw new TraderError(unavailable);
    const funding=typeof deps.readFunding==='function'?await deps.readFunding({provider,wallet:from,now,positions:structuredClone(positions)}):[];
    return {at:deps.clock?.() ?? Date.now(),cashWei:String(await provider.getBalance(from)),positions:marks,candidates,quarantined,funding};
  }};
}
