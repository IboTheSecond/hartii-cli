import {dirname,resolve,extname} from 'node:path';
import {walletAddress} from './walletCmd.js';
import {getHartiiHome,loadConfig} from '../config.js';
import {resolveRuntimeNetwork} from '../network.js';
import {assertCyprus1QuaiAddress} from '../address.js';
import {createReceiveQr} from '../qr.js';
import {buildReceiveLink} from '../paylinks.js';
import {atomicPrivateWrite,secureDirectory} from '../secureFiles.js';
import {DEMO_ADDRESS,DEMO_NETWORK} from '../demoFixtures.js';
export async function runReceive(opts={}){
 const home=opts.home||getHartiiHome();const config=opts.demo?{network:DEMO_NETWORK}:loadConfig(home);
 const net=resolveRuntimeNetwork({network:opts.network||config.network,rpc:opts.rpc,allowInsecureRpc:opts.allowInsecureRpc});
 if(net.chainId!==9&&!opts.addressQr)throw new Error('HPAY links target mainnet only. For Orchard use --address-qr and verify the payer selects Orchard.');
 if(opts.addressQr&&(opts.amount!==undefined||opts.memo))throw new Error('An address QR has no amount or memo. Use the default HPAY QR for a payment request.');
 const wallet=opts.demo?{name:'Demo',address:DEMO_ADDRESS}:walletAddress(home,opts.wallet);
 const address=assertCyprus1QuaiAddress(wallet.address);
 const paylink=net.chainId===9?buildReceiveLink({address,amount:opts.amount,memo:opts.memo||'',expiresAt:opts.expiresAt??null}):null;
 const qr=createReceiveQr(opts.addressQr?address:paylink);
 const result={readOnly:true,demo:Boolean(opts.demo),wallet:wallet.name,address,network:net.name,chainId:net.chainId,paylink,qr,note:opts.addressQr?'Raw address QR does not encode a network. Verify the payer chooses the displayed network.':'HPAY link and QR use the same public address, amount and network. No wallet unlock or network request was made.'};
 if(opts.out){const target=resolve(opts.out);if(extname(target).toLowerCase()!=='.svg')throw new Error('Receive QR output must be an .svg file.');secureDirectory(dirname(target));atomicPrivateWrite(target,qr.svg);result.savedTo=target;}
 return result;
}
