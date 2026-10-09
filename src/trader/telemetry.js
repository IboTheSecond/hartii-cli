/** One serialized telemetry task. Event wakes are coalesced; stop waits for the last task. */
export function createTelemetryPump({ flush, intervalMs = 15000, onError = () => {}, timers = globalThis }) {
  let timer, active = null, stopped = false, dirty = false;
  function schedule(ms) {
    if (stopped || timer !== undefined) return;
    timer = timers.setTimeout(() => { timer = undefined; void tick(); }, ms);
  }
  async function tick() {
    if (stopped || active) return;
    dirty = false;
    let failed = false;
    active = Promise.resolve().then(flush).catch(error => { failed = true; onError(error); });
    await active; active = null;
    schedule(dirty ? (failed ? 1000 : 50) : intervalMs);
  }
  return {
    start() { schedule(0); },
    notify() { dirty = true; if (!active) { timers.clearTimeout(timer); timer = undefined; schedule(50); } },
    async stop() { stopped = true; timers.clearTimeout(timer); timer = undefined; await active; },
  };
}
