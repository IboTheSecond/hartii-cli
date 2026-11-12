import {createHash} from 'node:crypto';
import {Interface,accessListify} from 'quais';
import {CliError} from '../errors.js';
import {assertCyprus1QuaiAddress} from '../address.js';
import {transactionIntentDigest} from '../writePipeline.js';
import {HARTIISWAP_ROUTER_ABI} from '../abi/hartiiSwapRouter.js';

export class DeskError extends CliError {}
const check=(ok,message)=>{if(!ok)throw new DeskError(message);};
export function uint(value,label='amount'){
  check((typeof value==='bigint'&&value>=0n)||(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)||(typeof value==='string'&&/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)&&value.length<=80),'Invalid '+label+'.');
  const n=BigInt(value);check(n<2n**256n,label+' exceeds uint256.');return n;
}
export function hash(value){check(typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value),'Invalid transaction or block hash.');return value.toLowerCase();}
const bytes=value=>{check(typeof value==='string'&&/^0x(?:[0-9a-fA-F]{2})*$/.test(value)&&value.length<=262146,'Invalid or oversized transaction data.');return value.toLowerCase();};
const addr=value=>{const a=assertCyprus1QuaiAddress(value);check(!/^0x0{40}$/i.test(a),'Zero addresses are unsupported.');return a;};
const sameAddress=(a,b)=>typeof a==='string'&&typeof b==='string'&&addr(a)===addr(b);
const swap=new Interface(HARTIISWAP_ROUTER_ABI),tokenAbi=new Interface(['function approve(address spender,uint256 value)','event Transfer(address indexed from,address indexed to,uint256 value)']);
export function normalizeAuthority(tx){
  check(tx&&typeof tx==='object','Reviewed transaction is missing.');
  const chainId=uint(tx.chainId,'chain ID');check(chainId===9n,'Constraint Desk supports mainnet chain 9 only.');
  const nonce=uint(tx.nonce,'nonce');check(nonce<=BigInt(Number.MAX_SAFE_INTEGER),'Nonce exceeds the SDK range.');
  if(tx.type!==undefined&&tx.type!==null)check(uint(tx.type,'transaction type')===0n,'Only Quai account transactions are supported.');
  const list=accessListify(tx.accessList??[]);check(list.length<=100&&list.every(row=>row.storageKeys.length<=100),'Oversized access list.');
  const result={from:addr(tx.from),to:addr(tx.to),data:bytes(tx.data??tx.input),value:uint(tx.value).toString(),nonce:Number(nonce),chainId:chainId.toString(),gasLimit:uint(tx.gasLimit??tx.gas,'gas limit').toString(),gasPrice:uint(tx.gasPrice,'gas price').toString(),accessList:list.map(row=>({address:addr(row.address),storageKeys:row.storageKeys.map(hash)}))};
  check(BigInt(result.gasLimit)>0n&&BigInt(result.gasPrice)>0n,'Gas terms must be positive.');return result;
}
const text=value=>typeof value==='string'?value.slice(0,500):null;
export function captureDecision(summary,transaction,{router,wquai,at=Date.now()}={}){
  const tx=normalizeAuthority(transaction),r=addr(router),w=addr(wquai);
  check(Number.isSafeInteger(at)&&at>=0,'Invalid capture time.');
  check(summary&&sameAddress(summary.from,tx.from)&&sameAddress(summary.to,tx.to)&&uint(summary.chainId)===9n&&uint(summary.nonce)===BigInt(tx.nonce),'Summary and reviewed authority disagree.');
  if(summary.dataDigest!==undefined)check(summary.dataDigest==='0x'+createHash('sha256').update(tx.data).digest('hex'),'Summary calldata digest disagrees.');
  if(summary.gasLimit!==undefined)check(uint(summary.gasLimit)===BigInt(tx.gasLimit),'Summary gas limit disagrees.');
  if(summary.gasPriceWei!==undefined)check(uint(summary.gasPriceWei)===BigInt(tx.gasPrice),'Summary gas price disagrees.');
  let trade;
  if(tx.to===r){
    let parsed;try{parsed=swap.parseTransaction({data:tx.data,value:BigInt(tx.value)});}catch{throw new DeskError('Unsupported router transaction.');}
    check(parsed&&['swapExactETHForTokens','swapExactTokensForETH','swapExactTokensForTokens'].includes(parsed.name),'Desk records supported exact-input router swaps only.');
    const a=parsed.args,nativeIn=parsed.name==='swapExactETHForTokens',nativeOut=parsed.name==='swapExactTokensForETH';
    const path=Array.from(nativeIn?a[1]:a[2],addr),recipient=addr(nativeIn?a[2]:a[3]);
    check(path.length===2&&path[0]!==path[1],'Desk first slice supports a direct two-token route.');
    check(recipient===tx.from,'Reviewed output recipient differs from the sender.');
    check(!nativeIn||path[0]===w,'Native input path is not the bundled WQUAI.');check(!nativeOut||path[1]===w,'Native output path is not the bundled WQUAI.');
    check(nativeIn?BigInt(tx.value)>0n:BigInt(tx.value)===0n,'Native value disagrees with the decoded swap.');
    trade={kind:'swap',method:parsed.name,path,recipient,inputKind:nativeIn?'native':'erc20',outputKind:nativeOut?'native':'erc20',inputUnits:(nativeIn?BigInt(tx.value):uint(a[0])).toString(),minimumOutUnits:uint(nativeIn?a[0]:a[1]).toString(),deadline:uint(nativeIn?a[3]:a[4]).toString()};
  }else{
    let approval;try{approval=tokenAbi.parseTransaction({data:tx.data});}catch{throw new DeskError('Desk supports router swaps and their exact allowance approvals; wrapping is not captured.');}
    check(approval?.name==='approve'&&addr(approval.args[0])===r&&BigInt(tx.value)===0n,'Approval does not target the bundled router.');
    trade={kind:'approval',method:'approve',token:tx.to,spender:r,approvedUnits:uint(approval.args[1]).toString(),recipient:null,inputKind:null,outputKind:null,minimumOutUnits:null,path:[]};
  }
  const intentDigest=transactionIntentDigest(transaction);
  const rawQuote={expectedOutUnits:null,assetOutDecimals:null};
  if(trade.kind==='swap'){
    if(summary.amountInUnits!==undefined)check(uint(summary.amountInUnits).toString()===trade.inputUnits,'Raw quote input differs from calldata.');
    if(summary.minimumOutUnits!==undefined)check(uint(summary.minimumOutUnits).toString()===trade.minimumOutUnits,'Raw quote minimum differs from calldata.');
    if(summary.assetOutAddress!==undefined)check(trade.outputKind==='native'?summary.assetOutAddress==='native':addr(summary.assetOutAddress)===trade.path.at(-1),'Raw quote output asset differs from calldata.');
    if(summary.expectedOutUnits!==undefined){rawQuote.expectedOutUnits=uint(summary.expectedOutUnits).toString();if(summary.slippageBps!==undefined){const bps=uint(summary.slippageBps);check(bps<=10000n&&(BigInt(rawQuote.expectedOutUnits)*(10000n-bps)/10000n).toString()===trade.minimumOutUnits,'Quote floor differs from the reviewed slippage terms.');}}
    if(summary.assetOutDecimals!==undefined){const decimals=uint(summary.assetOutDecimals);check(decimals<=255n,'Invalid token decimals.');rawQuote.assetOutDecimals=Number(decimals);}
  }
  return {schemaVersion:1,id:new Date(at).toISOString().slice(0,10).replaceAll('-','')+'-'+intentDigest.slice(2),intentDigest,createdAt:at,network:'mainnet',chainId:9,venue:{router:r,wquai:w},transaction:tx,trade,quote:{...rawQuote,action:text(summary.action),amountInText:text(summary.amountIn),expectedOutText:text(summary.expectedOut),minimumOutText:text(summary.minOut),tokenInLabel:text(summary.tokenIn),tokenOutLabel:text(summary.tokenOut),feeBps:text(summary.feeBps),feeIncludedInQuote:summary.feeIncludedInQuote===true,slippageBps:text(summary.slippageBps),gasCeilingWei:(BigInt(tx.gasLimit)*BigInt(tx.gasPrice)).toString(),provenance:'Captured from the existing CLI review; not independently authenticated historical market data.'},phase:'reviewed',txHash:null,broadcastMayHaveStarted:false,outcome:null,observations:[]};
}
const statusOf=receipt=>[1,1n,'1','0x1'].includes(receipt?.status)?'confirmed':[0,0n,'0','0x0'].includes(receipt?.status)?'reverted':'unresolved';
const hashesMatch=(value,expected,fields)=>{const present=fields.map(k=>value?.[k]).filter(x=>x!==undefined&&x!==null);return present.length>0&&present.every(x=>hash(x)===expected);};
function observedFee(receipt,tx){
  try{
    if(receipt.fee!==undefined&&receipt.fee!==null){const fee=uint(receipt.fee,'receipt fee');check(fee<=BigInt(tx.gasLimit)*BigInt(tx.gasPrice),'Receipt fee exceeds signed ceiling.');return {gasFeeWei:fee.toString(),gasSource:'receipt-fee'};}
    if(receipt.gasUsed===undefined||receipt.gasUsed===null)return {gasFeeWei:null,gasSource:'unavailable'};
    const price=receipt.gasPrice??receipt.effectiveGasPrice;
    if(price===undefined||price===null)return {gasFeeWei:null,gasSource:'unavailable'};
    const used=uint(receipt.gasUsed),actualPrice=uint(price);check(used>0n&&used<=BigInt(tx.gasLimit)&&actualPrice>0n&&actualPrice<=BigInt(tx.gasPrice),'Invalid actual gas evidence.');
    return {gasFeeWei:(used*actualPrice).toString(),gasSource:'receipt-gas-used-times-price'};
  }catch{return {gasFeeWei:null,gasSource:'unavailable'};}
}
function outputEvidence(record,receipt,status,expectedPair){
  const unknown=reason=>({eventDerivedUnits:null,balanceVerified:false,kind:'unavailable',reason});
  if(record.trade.kind==='approval')return unknown('Allowance approval is not a trade output.');
  if(status==='reverted')return {eventDerivedUnits:'0',balanceVerified:false,kind:'reverted',reason:'Reverted execution has no swap output.'};
  if(record.trade.outputKind==='native')return unknown('Native recipient proceeds are not proven by this receipt-only slice.');
  if(!expectedPair)return unknown('Canonical factory-pair provenance is unavailable.');
  try{
    const emitter=record.trade.path.at(-1),counterparty=addr(expectedPair),transferTopic=tokenAbi.getEvent('Transfer').topicHash.toLowerCase();
    check(Array.isArray(receipt.logs)&&receipt.logs.length<=2000,'Missing or oversized receipt log set.');const matches=[];
    for(const log of receipt.logs){
      if(!sameAddress(log.address,emitter)||String(log.topics?.[0]).toLowerCase()!==transferTopic)continue;
      check(log.removed!==true&&log.topics.length===3&&/^0x[0-9a-fA-F]{64}$/.test(log.data),'Malformed output-token Transfer evidence.');
      if(log.transactionHash!==undefined)check(hash(log.transactionHash)===record.txHash,'Log belongs to another transaction.');
      if(log.blockHash!==undefined)check(hash(log.blockHash)===hash(receipt.blockHash),'Log belongs to another block.');
      const parsed=tokenAbi.parseLog({topics:log.topics,data:log.data});
      if(addr(parsed.args.to)!==record.trade.recipient)continue;
      check(addr(parsed.args.from)===counterparty,'Output Transfer is not from the canonical final pair.');
      matches.push({units:uint(parsed.args.value).toString(),logIndex:log.index??log.logIndex??null});
    }
    check(matches.length===1&&BigInt(matches[0].units)>0n,'Output Transfer evidence is missing or ambiguous.');
    return {eventDerivedUnits:matches[0].units,logIndex:matches[0].logIndex,balanceVerified:false,kind:'erc20-transfer-event',reason:'One canonical-pair output Transfer event. Nonstandard tokens can emit misleading events; this is not universal balance or P&L proof.'};
  }catch{return unknown('Output Transfer evidence is malformed, unverified or ambiguous.');}
}
export function reconcileEvidence(record,{transaction,receipt,block,expectedPair,observedAt=Date.now()}={}){
  const unresolved=reason=>({status:'unresolved',txHash:record.txHash??null,observedAt,reason,gasFeeWei:null,gasSource:'unavailable',output:{eventDerivedUnits:null,balanceVerified:false,kind:'unavailable',reason},realizedPnlWei:null});
  try{
    const txHash=hash(record.txHash);check(transaction&&receipt,'Transaction or receipt unavailable.');
    check(hashesMatch(transaction,txHash,['hash','transactionHash'])&&hashesMatch(receipt,txHash,['hash','transactionHash']),'Transaction/receipt identity mismatch.');
    const actual=normalizeAuthority(transaction),expected=normalizeAuthority(record.transaction);
    check(transactionIntentDigest(actual)===transactionIntentDigest(expected),'On-chain authority differs from the captured review.');
    check(sameAddress(receipt.from,expected.from)&&sameAddress(receipt.to,expected.to),'Receipt parties differ from the captured review.');
    const status=statusOf(receipt);check(status!=='unresolved','Receipt has no canonical final status.');
    const number=uint(receipt.blockNumber,'receipt block');check(number<=BigInt(Number.MAX_SAFE_INTEGER),'Receipt block exceeds safe range.');
    const bh=hash(receipt.blockHash);check(block&&hash(block.hash)===bh&&uint(block.woHeader?.number)===number,'Receipt block is not canonical.');
    check(hash(transaction.blockHash)===bh&&uint(transaction.blockNumber)===number,'Transaction and receipt blocks disagree.');
    let timestamp=null;try{timestamp=uint(block.woHeader?.timestamp,'Quai block timestamp').toString();}catch{}
    const output=outputEvidence(record,receipt,status,expectedPair);
    const quoteDifferenceUnits=status==='confirmed'&&output.eventDerivedUnits!==null&&record.quote.expectedOutUnits!==null?(BigInt(output.eventDerivedUnits)-BigInt(record.quote.expectedOutUnits)).toString():null;
    return {status,txHash,observedAt,blockNumber:Number(number),blockHash:bh,blockTimestamp:timestamp,...observedFee(receipt,expected),output,quoteDifferenceUnits,realizedPnlWei:null,reason:'Matching receipt observed in a canonical block; subsequent reorganizations remain possible.'};
  }catch(error){return unresolved(error instanceof DeskError?error.message:'Receipt evidence is incomplete or invalid.');}
}
