import { it, expect, vi, afterEach } from 'vitest';
import { createTelemetryPump } from '../src/trader/telemetry.js';
afterEach(() => vi.useRealTimers());
it('publishes phase changes during an awaited operation without overlapping flushes', async () => {
  vi.useFakeTimers(); const seen=[]; let state='observing', release;
  const held=new Promise(resolve=>{release=resolve;}); let calls=0, concurrent=0, maximum=0;
  const pump=createTelemetryPump({intervalMs:15000,flush:async()=>{concurrent++;maximum=Math.max(maximum,concurrent);seen.push(state);if(++calls===1)await held;concurrent--;}});
  pump.start(); await vi.advanceTimersByTimeAsync(0); state='analyzing'; pump.notify();
  await vi.advanceTimersByTimeAsync(10000); expect(seen).toEqual(['observing']);
  release(); await vi.advanceTimersByTimeAsync(50); expect(seen).toEqual(['observing','analyzing']);expect(maximum).toBe(1);
  await pump.stop(); await vi.advanceTimersByTimeAsync(30000); expect(seen).toHaveLength(2);
});
it('continues heartbeat ticks after a failed flush and waits for the active task on stop',async()=>{
  vi.useFakeTimers(); const errors=[]; let release,finished=false;
  const flush=vi.fn().mockRejectedValueOnce(Error('offline')).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const pump=createTelemetryPump({flush,onError:error=>errors.push(error.message)});pump.start();
  await vi.advanceTimersByTimeAsync(15000);expect(flush).toHaveBeenCalledTimes(2);expect(errors).toEqual(['offline']);
  const stopped=pump.stop().then(()=>{finished=true;});await Promise.resolve();expect(finished).toBe(false);
  release();await stopped;expect(finished).toBe(true);
});
