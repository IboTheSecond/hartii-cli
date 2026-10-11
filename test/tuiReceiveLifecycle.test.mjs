import {it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {demoState} from '../src/tui/demoData.js';
import {createReceiveQr} from '../src/qr.js';
const state=vi.hoisted(()=>({app:null,signal:null,finish:null,stop:vi.fn()}));
const address='0x0011111111111111111111111111111111111111';
vi.mock('../src/tui/data.js',()=>({createDataSource:()=>({
 initial:{...demoState(0),wallet:{name:'synthetic',address},network:'mainnet'},
 deps:{runCommand:async()=>({readOnly:true,address,network:'mainnet',qr:createReceiveQr(address),paylink:null})},
 start:app=>{state.app=app;},stop:state.stop,
})}));
vi.mock('../src/clipboard.js',()=>({copyPublicText:(_text,{signal})=>{state.signal=signal;return new Promise(resolve=>{state.finish=resolve;});}}));
import {runTui} from '../src/tui/run.js';
it('SIGTERM cleanup aborts pending receiving copy, drops details, and restores terminal state',async()=>{
 const stdin=Object.assign(new EventEmitter(),{isTTY:true,setRawMode:vi.fn(),resume:vi.fn(),pause:vi.fn()});
 const stdout=Object.assign(new EventEmitter(),{isTTY:true,columns:80,rows:24,write:vi.fn()});
 const before=new Set(process.listeners('SIGTERM'));
 const done=runTui({stdin,stdout,env:{COLORTERM:'truecolor'}});
 try{
  await state.app.openAction('Receive');
  const handler=process.listeners('SIGTERM').find(fn=>!before.has(fn));expect(handler).toBeTypeOf('function');handler();
  expect(await done).toBe(130);expect(state.stop).toHaveBeenCalledOnce();
  expect(state.signal.aborted).toBe(true);expect(state.app.ui.overlay).toBeNull();
  state.finish({ok:true});await new Promise(r=>setTimeout(r,0));expect(state.app.ui.overlay).toBeNull();
  expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);expect(stdin.pause).toHaveBeenCalled();
 }finally{state.app.quit();state.finish?.({ok:false});}
});
