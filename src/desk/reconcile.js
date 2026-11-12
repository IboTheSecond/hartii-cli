import {Interface,Zone} from 'quais';
import {readRuntime,withProviderCleanup} from '../commandContext.js';
import {createProvider} from '../signer.js';
import {assertMarketNetwork} from '../marketApi.js';
import {assertChainId} from '../network.js';
import {hartiiSwapAddresses} from '../liveAddresses.js';
import {assertCyprus1QuaiAddress} from '../address.js';
import {DeskError,hash,uint,reconcileEvidence} from './model.js';
const factory=new Interface(['function getPair(address,address) view returns (address)']);
const router=new Interface(['function factory() view returns (address)']);
export async function readDecisionEvidence(record,opts={},deps={}){
  return withProviderCleanup(deps,async current=>{
    const {net}=readRuntime(opts,current);assertMarketNetwork(net.name);await assertChainId(net.rpcUrl,9,{fetchFn:current.fetchFn});
    const p=(current.providerFactory||createProvider)(net.rpcUrl);
    if(BigInt((await p.getNetwork()).chainId)!==9n)throw new DeskError('Desk receipt reader is on the wrong chain.');
    const evidence={observedAt:deps.clock?.()??Date.now()};
    try{
      if(!record.txHash)return reconcileEvidence(record,evidence);
      const h=hash(record.txHash);
      evidence.transaction=await p.getTransaction(h);
      try{evidence.receipt=await p.getTransactionReceipt(h);}catch(error){if(error?.code==='CALL_EXCEPTION'&&error.receipt)evidence.receipt=error.receipt;else throw error;}
      if(evidence.receipt){
        const n=uint(evidence.receipt.blockNumber);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new DeskError('Receipt block is outside the SDK range.');
        evidence.block=await p.getBlock(Zone.Cyprus1,Number(n));
        const live=hartiiSwapAddresses(net.name);
        if(record.trade.kind==='swap'&&record.trade.outputKind==='erc20'&&live?.factory&&live.router.toLowerCase()===record.venue.router.toLowerCase()){
          try{
            const blockTag='0x'+n.toString(16),to=assertCyprus1QuaiAddress(live.router);
            const factoryAddress=router.decodeFunctionResult('factory',await p.call({to,data:router.encodeFunctionData('factory',[]),blockTag}))[0];
            if(factoryAddress.toLowerCase()!==live.factory.toLowerCase())throw new DeskError('Router factory differs from bundled provenance.');
            const pair=factory.decodeFunctionResult('getPair',await p.call({to:assertCyprus1QuaiAddress(factoryAddress),data:factory.encodeFunctionData('getPair',record.trade.path),blockTag}))[0];
            evidence.expectedPair=assertCyprus1QuaiAddress(pair);
          }catch{/* Missing historical pair proof makes output evidence unavailable, not fabricated. */}
        }
        const after=await p.getBlock(Zone.Cyprus1,Number(n));
        if(!after||hash(after.hash)!==hash(evidence.block?.hash))evidence.block=null;
      }
    }catch{/* Transport failure or incomplete state remains unresolved. No send or reservation change. */}
    return reconcileEvidence(record,evidence);
  });
}
