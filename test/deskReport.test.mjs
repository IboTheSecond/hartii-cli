import {it,expect} from 'vitest';
import {getAddress,Interface} from 'quais';
import * as report from '../src/desk/report.js';
import {captureDecision} from '../src/desk/model.js';
import {HARTIISWAP_ROUTER_ABI} from '../src/abi/hartiiSwapRouter.js';
const addr=n=>getAddress('0x00'+n.toString(16).padStart(38,'0'));
function fixture(){const from=addr(1),router=addr(2),wquai=addr(3),token=addr(4),data=new Interface(HARTIISWAP_ROUTER_ABI).encodeFunctionData('swapExactETHForTokens',[90n,[wquai,token],from,2000000000]);return captureDecision({action:'Swap',chainId:9,from,to:router,nonce:0},{from,to:router,value:100n,data,nonce:0,chainId:9n,gasLimit:100000n,gasPrice:1n,accessList:[]},{router,wquai,at:1800000000000});}
it('renders a self-contained labeled report and keeps hostile names inert in emitted HTML bytes',()=>{
  expect(typeof report.renderDeskReport).toBe('function');const r=fixture();r.quote.action='</script><img src=x onerror=alert(1)>';r.privateKey='must-not-export';
  const html=report.renderDeskReport({demo:true,records:[r],exportedAt:'2026-11-12T00:00:00Z'});
  expect(html).toContain('FIXTURE');expect(html).toContain("connect-src 'none'");expect(html).not.toContain('<img');expect(html).not.toContain('must-not-export');expect((html.match(/<\/script>/g)||[]).length).toBe(2);
  const serialized=html.match(/<script id="desk-data" type="application\/json">([\s\S]*?)<\/script>/)[1];expect(JSON.parse(serialized).records[0].quote.action).toBe(r.quote.action);
});
it('caps report size and exports only allowlisted public transaction evidence',()=>{
  expect(typeof report.makeDeskExport).toBe('function');const r=fixture();r.password='must-not-export';const value=report.makeDeskExport({records:[r]});expect(value.format).toBe('hartii-fill-ledger/v1');expect(JSON.stringify(value)).not.toContain('must-not-export');expect(()=>report.makeDeskExport({records:Array(101).fill(r)})).toThrow();
});
it('labels planned trade context on an approval instead of implying that approval itself has swap proceeds',()=>{
  const base=fixture(),to=base.trade.path[1],data=new Interface(['function approve(address,uint256)']).encodeFunctionData('approve',[base.venue.router,100n]);
  const r=captureDecision({action:'Approve TOK',chainId:9,from:base.transaction.from,to,nonce:0,expectedOut:'100'}, {...base.transaction,to,data,value:'0'}, {router:base.venue.router,wquai:base.venue.wquai,at:1800000000000});
  expect(report.renderDeskReport({records:[r]})).toContain('Planned next-swap quote');
});
