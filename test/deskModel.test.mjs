import {describe,it,expect} from 'vitest';
import {getAddress,Interface} from 'quais';
import * as model from '../src/desk/model.js';
import {HARTIISWAP_ROUTER_ABI} from '../src/abi/hartiiSwapRouter.js';
import {transactionIntentDigest} from '../src/writePipeline.js';
const addr=n=>getAddress('0x00'+n.toString(16).padStart(38,'0'));
const from=addr(1),router=addr(2),wquai=addr(3),token=addr(4),pair=addr(5),blockHash='0x'+'ab'.repeat(32),txHash='0x'+'cd'.repeat(32);
const iface=new Interface(HARTIISWAP_ROUTER_ABI),erc20=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const authority={from,to:router,value:100n,data:iface.encodeFunctionData('swapExactETHForTokens',[90n,[wquai,token],from,2000000000]),nonce:0,chainId:9n,gasLimit:50000n,gasPrice:10n,accessList:[]};
const summary={action:'Swap QUAI -> TOK',network:'mainnet',chainId:9,from,to:router,valueQuai:'0.0000000000000001',gasLimit:'50000',gasPriceWei:'10',nonce:0,expectedOut:'100',minOut:'90',slippageBps:'1000'};
const make=()=>model.captureDecision(summary,authority,{router,wquai,at:1800000000000});
const chainTx=()=>({...authority,hash:txHash,blockHash,blockNumber:100});
const receipt=(status=1)=>({hash:txHash,transactionHash:txHash,from,to:router,blockHash,blockNumber:100,status,gasUsed:40000n,gasPrice:10n,logs:[]});
function event(units,overrides={}){const encoded=erc20.encodeEventLog(erc20.getEvent('Transfer'),[pair,from,units]);return {address:token,...encoded,index:0,transactionHash:txHash,blockHash,removed:false,...overrides};}
describe('Fill Ledger evidence model',()=>{
  it('captures the exact reviewed authority and decoded route without retaining unrelated summary fields',()=>{
    expect(typeof model.captureDecision).toBe('function');const r=model.captureDecision({...summary,privateKey:'must-not-retain'},authority,{router,wquai,at:1800000000000});
    expect(r.intentDigest).toBe(transactionIntentDigest(authority));expect(r.transaction.nonce).toBe(0);expect(r.transaction.chainId).toBe('9');expect(r.trade.minimumOutUnits).toBe('90');expect(r.trade.inputUnits).toBe('100');expect(r.trade.recipient).toBe(from);expect(r.quote.expectedOutText).toBe('100');expect(JSON.stringify(r)).not.toContain('must-not-retain');
  });
  it('refuses another router, network, recipient, malformed money or selector',()=>{
    expect(typeof model.captureDecision).toBe('function');
    for(const tx of [{...authority,to:addr(6)},{...authority,chainId:15000n},{...authority,value:-1n},{...authority,data:'0x1234'},{...authority,data:iface.encodeFunctionData('swapExactETHForTokens',[90n,[wquai,token],addr(7),2000000000])}])expect(()=>model.captureDecision(summary,tx,{router,wquai,at:1800000000000})).toThrow();
  });
  it('requires every transaction/receipt hash alias, authority and canonical block to match',()=>{
    expect(typeof model.reconcileEvidence).toBe('function');const record={...make(),txHash};
    for(const patch of [{transactionHash:'0x'+'ef'.repeat(32)},{from:addr(8)},{to:addr(8)},{blockHash:'0x'+'ef'.repeat(32)},{status:true}]){
      const result=model.reconcileEvidence(record,{transaction:chainTx(),receipt:{...receipt(),...patch},block:{hash:blockHash,woHeader:{number:100,timestamp:'1700000000'}}});expect(result.status).toBe('unresolved');
    }
    expect(model.reconcileEvidence(record,{transaction:{...chainTx(),nonce:1},receipt:receipt(),block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}}}).status).toBe('unresolved');
  });
  it('reports actual gas and one well-formed output event without claiming universal balance proof',()=>{
    expect(typeof model.reconcileEvidence).toBe('function');const result=model.reconcileEvidence({...make(),txHash},{transaction:chainTx(),receipt:{...receipt(),logs:[event(97n)]},block:{hash:blockHash,woHeader:{number:100,timestamp:'1700000000'}},expectedPair:pair});
    expect(result.status).toBe('confirmed');expect(result.gasFeeWei).toBe('400000');expect(result.gasSource).toBe('receipt-gas-used-times-price');expect(result.output.eventDerivedUnits).toBe('97');expect(result.output.balanceVerified).toBe(false);expect(result.realizedPnlWei).toBeNull();
  });
  it('leaves missing gas unknown rather than replacing it with the signed ceiling',()=>{
    expect(typeof model.reconcileEvidence).toBe('function');const result=model.reconcileEvidence({...make(),txHash},{transaction:chainTx(),receipt:{...receipt(),gasUsed:undefined,gasPrice:undefined},block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}}});expect(result.gasFeeWei).toBeNull();expect(result.gasSource).toBe('unavailable');
  });
  it('does not invent output on a revert, duplicate events, missing pair proof or wrong emitters',()=>{
    expect(typeof model.reconcileEvidence).toBe('function');const record={...make(),txHash};
    for(const logs of [[event(97n),event(97n,{index:1})],[event(97n,{address:addr(9)})],[event(97n,{removed:true})]])expect(model.reconcileEvidence(record,{transaction:chainTx(),receipt:{...receipt(),logs},block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}},expectedPair:pair}).output.eventDerivedUnits).toBeNull();
    expect(model.reconcileEvidence(record,{transaction:chainTx(),receipt:{...receipt(),logs:[event(97n)]},block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}}}).output.eventDerivedUnits).toBeNull();
    const reverted=model.reconcileEvidence(record,{transaction:chainTx(),receipt:{...receipt(0),logs:[event(97n)]},block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}},expectedPair:pair});expect(reverted.status).toBe('reverted');expect(reverted.output.eventDerivedUnits).toBe('0');expect(reverted.gasFeeWei).toBe('400000');
  });
  it('treats pending, unavailable or malformed receipt evidence as unresolved',()=>{
    expect(typeof model.reconcileEvidence).toBe('function');for(const rec of [null,{...receipt(),status:'0x2'},{...receipt(),blockNumber:null}])expect(model.reconcileEvidence({...make(),txHash},{transaction:chainTx(),receipt:rec,block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}}}).status).toBe('unresolved');
  });
  it('binds exact quote units to calldata and compares only like-unit event evidence',()=>{
    const quoted={...summary,amountInUnits:'100',expectedOutUnits:'100',minimumOutUnits:'90',assetOutDecimals:'0',assetOutAddress:token};
    const r=model.captureDecision(quoted,authority,{router,wquai,at:1800000000000});expect(r.quote.expectedOutUnits).toBe('100');
    expect(()=>model.captureDecision({...quoted,minimumOutUnits:'89'},authority,{router,wquai,at:1800000000000})).toThrow();
    const outcome=model.reconcileEvidence({...r,txHash},{transaction:chainTx(),receipt:{...receipt(),logs:[event(97n)]},block:{hash:blockHash,woHeader:{number:100,timestamp:1700000000}},expectedPair:pair});expect(outcome.quoteDifferenceUnits).toBe('-3');
  });
});
