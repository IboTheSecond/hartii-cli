import {it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {getAddress,Interface} from 'quais';
import {saveConfig} from '../src/config.js';
import {runSwap} from '../src/commands/swap.js';
import {ERC20_ABI} from '../src/abi/erc20.js';
import {HARTIISWAP_ROUTER_ABI} from '../src/abi/hartiiSwapRouter.js';
const from=getAddress('0x00112233445566778899aabbccddeeff00112233'),token=getAddress('0x002233445566778899aabbccddeeff0011223344'),erc=new Interface(ERC20_ABI),router=new Interface(HARTIISWAP_ROUTER_ABI);
it('swap preflight exposes exact raw quote units alongside display values without unlocking a signer',async()=>{
  const home=mkdtempSync(join(tmpdir(),'hartii-desk-raw-'));mkdirSync(join(home,'keystore'));writeFileSync(join(home,'keystore','watch.json'),JSON.stringify({address:from.slice(2)}));saveConfig(home,{network:'mainnet',currentWallet:'watch',limits:{perTxQuai:'100',dailyQuai:'500'}});
  const provider={getNetwork:async()=>({chainId:9n}),getBalance:async()=>100n*10n**18n,getTransactionCount:async()=>0,createAccessList:async()=>[],estimateGas:async()=>100000n,getFeeData:async()=>({gasPrice:1000000000n}),call:async tx=>{expect(tx.to).toBe(getAddress(tx.to));for(const iface of[erc,router]){let p;try{p=iface.parseTransaction(tx);}catch{}if(!p)continue;if(p.name==='symbol')return erc.encodeFunctionResult('symbol',['TOK']);if(p.name==='decimals')return erc.encodeFunctionResult('decimals',[6]);if(p.name==='balanceOf')return erc.encodeFunctionResult('balanceOf',[100000000n]);if(p.name==='getAmountsOut')return router.encodeFunctionResult('getAmountsOut',[[p.args[0],1234567n]]);}return '0x';}};
  const walletFactory=vi.fn(()=>{throw Error('No signer permitted');});
  const r=await runSwap({home,tokenIn:'QUAI',tokenOut:token,amount:'1',dryRun:true,json:true},{providerFactory:()=>provider,walletFactory,fetchFn:async()=>({json:async()=>({result:'0x9'})}),io:{write:()=>{},writeErr:()=>{}}});
  expect(r.summary.expectedOutUnits).toBe('1234567');expect(r.summary.amountInUnits).toBe('1000000000000000000');expect(r.summary.minimumOutUnits).toBe('1197529');expect(r.summary.assetOutDecimals).toBe('6');expect(r.summary.assetOutAddress).toBe(token);expect(walletFactory).not.toHaveBeenCalled();
});
