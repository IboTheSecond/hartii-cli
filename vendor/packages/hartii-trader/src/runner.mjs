import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { address, bps, exactObject, hash, invariant, max, min, TraderError, uint } from './validation.mjs';
import { canonicalPolicyMessage, validatePolicy } from './policy.mjs';
import { TraderLedger } from './ledger.mjs';
import { qualifyCandidate, exitSignal, validateQuote } from './strategy.mjs';
import { PaperExecutor } from './paper.mjs';
import { validateDecision } from './providers.mjs';
import { buildModelCandidate } from './model-features.mjs';

const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
function fresh(at, now, age = 30000) { return Number.isSafeInteger(at) && at <= now && now - at <= age; }
function errorCode(error) { return error instanceof TraderError ? error.code : 'dependency-unavailable'; }
function nativeCancellation(proof, intentId, txHash) {
  exactObject(proof, ['cancelled', 'broadcastStarted', 'completed', 'intentId', 'txHash'], 'invalid-cancellation-proof');
  invariant(proof.cancelled === true && proof.broadcastStarted === false && proof.completed === true && proof.intentId === intentId &&
    (txHash === null ? proof.txHash === null : typeof proof.txHash === 'string' && proof.txHash.toLowerCase() === txHash.toLowerCase()), 'invalid-cancellation-proof');
  return { kind: 'native-undispatched', ...proof };
}
/** No signer implementation is supplied by this package. */
export class TraderRunner {
  #options; #ledger; #state = 'idle'; #blockers = []; #seq = 0; #latest = null; #updated = null; #heartbeat = null;
  #membership = null; #qualification = { days: 0, requiredDays: 7, liveEnabled: false }; #authority = null; #busy = false; #initialized = false;
  constructor(options) {
    invariant(options && ['observe', 'paper', 'live'].includes(options.mode), 'invalid-mode');
    invariant(options.journal && options.market && typeof options.market.snapshot === 'function', 'runner-dependencies-required');
    validatePolicy(options.policy, { now: options.policy?.issuedAt });
    const budgets = [options.decisionProvider?.budget, options.critiqueProvider?.budget].filter(Boolean);
    invariant(budgets.every(b => b === budgets[0]), 'shared-model-budget-required');
    for (const budget of budgets) invariant(budget.limits && uint(budget.limits.cycleCapMicrousd) <= uint(options.policy.modelCycleMicrousd) &&
      uint(budget.limits.dailyCapMicrousd) <= uint(options.policy.modelDailyMicrousd), 'model-policy-budget-exceeded');
    this.#options = { ...options, policy: structuredClone(options.policy), clock: options.clock ?? Date.now };
  }
  async initialize() {
    if (this.#initialized) return this.snapshot();
    const o = this.#options;
    this.#ledger = await TraderLedger.open({ journal: o.journal, policy: o.policy, mode: o.mode, clock: o.clock, now: o.clock(),
      initialBalanceWei: o.mode === 'paper' ? o.initialBalanceWei ?? null : null });
    const events = (await o.journal.read()).filter(r => r.type === 'runner.event');
    this.#seq = events.at(-1)?.data.seq ?? 0;
    this.#latest = events.filter(r => r.data.type === 'decision').at(-1)?.data.data ?? null;
    this.#state = this.#ledger.state.pauseLatch ? 'paused' : this.#ledger.state.pending ? 'pending' : 'idle';
    this.#initialized = true; return this.snapshot();
  }
  get ledger() { invariant(this.#initialized, 'runner-not-initialized'); return this.#ledger; }
  snapshot() {
    const o = this.#options, s = this.#ledger?.state;
    const unknown = { equityWei: null, availableQuaiWei: null, exposureWei: null, realizedPnlWei: null, unrealizedPnlWei: null, gasWei: null, modelCostMicrousd: null };
    const finances = this.#ledger ? this.#ledger.finances() : unknown;
    const budgets = [o.decisionProvider?.budget, o.critiqueProvider?.budget].filter((b, i, arr) => b && arr.indexOf(b) === i);
    if (budgets.length) {
      const values = budgets.map(b => b.snapshot().actualMicrousd);
      finances.modelCostMicrousd = values.some(v => v === null) ? null : values.reduce((n, v) => n + uint(v), 0n).toString();
    }
    return { schemaVersion: 1, runnerId: o.policy.runnerId, owner: o.policy.owner, tradingWallet: o.policy.tradingWallet, chainId: 9,
      mode: o.mode, state: this.#state, updatedAt: this.#updated, heartbeatAt: this.#heartbeat, policy: structuredClone(o.policy),
      membership: structuredClone(this.#membership), finances, positions: (s?.positions ?? []).map(p => ({ id: p.id, token: p.token, symbol: p.symbol,
        units: p.units, costBasisWei: p.costBasisWei, exitValueWei: p.exitValueWei, pnlWei: p.pnlWei, status: p.status, updatedAt: p.updatedAt })),
      latestDecision: structuredClone(this.#latest), blockers: [...this.#blockers], qualification: { ...this.#qualification } };
  }
  async #event(type, data, at = this.#options.clock()) {
    const event = { schemaVersion: 1, id: randomUUID(), runnerId: this.#options.policy.runnerId, seq: this.#seq + 1, at,
      mode: this.#options.mode, type, data };
    await this.#options.journal.append({ type: 'runner.event', at, data: event }); this.#seq = event.seq; this.#updated = at;
    if (this.#options.emit) { try { await this.#options.emit(structuredClone(event)); } catch { /* Durable local telemetry remains available for relay replay. */ } }
  }
  async #decision(action, reason, token = null, outcome = 'held', analysis = null) {
    const decision = { id: randomUUID(), at: this.#options.clock(), action, token, rationale: analysis?.rationale ?? reason,
      evidence: structuredClone(analysis?.evidence ?? []), guardResults: structuredClone(analysis?.guardResults ?? []), outcome };
    await this.#event('decision', decision, decision.at); this.#latest = decision;
    if (!['pending', 'paused', 'blocked'].includes(this.#state)) this.#state = action === 'hold' ? 'holding' : this.#options.mode === 'observe' ? 'observing' : 'idle';
    return this.snapshot();
  }
  async #gate(action, intent = null) {
    const o = this.#options, now = o.clock(), policy = o.policy;
    validatePolicy(policy, { now: o.mode === 'live' ? now : policy.issuedAt });
    invariant(!this.#ledger.state.pauseLatch, 'runner-paused');
    if (o.mode !== 'live') return;
    this.#qualification.liveEnabled = false;
    invariant(o.journal.durable === true, 'durable-journal-required');
    invariant(o.executor && ['prepare', 'broadcast', 'discard'].every(method => typeof o.executor[method] === 'function'), 'live-executor-required');
    invariant(typeof o.signature === 'string' && o.signature.length > 0 && typeof o.verifyPolicy === 'function', 'owner-signature-required');
    const message = canonicalPolicyMessage(policy);
    const verification = await o.verifyPolicy({ policy: structuredClone(policy), signature: o.signature, message });
    invariant(verification?.valid === true && sameAddress(verification.owner, policy.owner) && verification.policyMessage === message, 'owner-policy-signature-invalid');
    invariant(typeof o.qualification === 'function', 'release-not-qualified');
    const q = await o.qualification({ policy: structuredClone(policy), now });
    const elapsed = Number.isSafeInteger(q?.observedFrom) && Number.isSafeInteger(q?.observedThrough) && q.observedThrough <= now
      ? Math.floor((q.observedThrough - q.observedFrom) / 86400000) : 0;
    this.#qualification.days = Math.max(0, Math.min(elapsed, Number.isInteger(q?.consecutiveDays) ? q.consecutiveDays : 0));
    invariant(q?.qualified === true && typeof q.releaseId === 'string' && q.releaseId.length > 0 && this.#qualification.days >= 7 &&
      q.replayPassed === true && q.rehearsalPassed === true && fresh(q.checkedAt, o.clock(), 60000), 'release-not-qualified');
    if (action === 'buy') {
      invariant(typeof o.membership === 'function', 'membership-unavailable');
      const membership = await o.membership({ owner: policy.owner, now: o.clock() });
      // Only the published membership shape is eligible for snapshot transport.
      const fields = ['configured', 'active', 'eligible', 'owner', 'chainId', 'token', 'registry', 'tier', 'minimumWei', 'balanceWei', 'checkedAt', 'blockNumber', 'pending', 'reason'];
      this.#membership = Object.fromEntries(fields.map(key => [key, membership?.[key] ?? null]));
      invariant(membership?.configured === true && membership.active === true && membership.eligible === true && membership.chainId === 9 &&
        sameAddress(membership.owner, policy.owner) && fresh(membership.checkedAt, o.clock()), 'membership-required');
    }
    invariant(typeof o.authority === 'function', 'exclusive-authority-required');
    const authority = await o.authority({ owner: policy.owner, tradingWallet: policy.tradingWallet, runnerId: policy.runnerId, chainId: 9, intent: structuredClone(intent), now: o.clock() });
    invariant(authority?.exclusive === true && authority.pendingOwnershipDurable === true && sameAddress(authority.owner, policy.owner) &&
      sameAddress(authority.tradingWallet, policy.tradingWallet) && authority.runnerId === policy.runnerId && authority.chainId === 9 &&
      authority.pendingIntentId === (intent?.id ?? null) && fresh(authority.checkedAt, o.clock()) && Number.isSafeInteger(authority.expiresAt) && authority.expiresAt > o.clock(), 'exclusive-authority-required');
    this.#authority = authority;
    this.#assertExecutionState(action, intent); this.#qualification.liveEnabled = true;
  }
  #assertExecutionState(action, intent = null) {
    const o = this.#options, now = o.clock(), state = this.#ledger.state;
    validatePolicy(o.policy, { now: o.mode === 'live' ? now : o.policy.issuedAt });
    invariant(!state.pauseLatch, 'runner-paused');
    if (action === 'buy') {
      invariant(!state.lossLatch, 'daily-loss-latched');
      invariant(!state.accountingUnknown && state.day.openingEquityWei !== null, 'unknown-accounting');
    }
    if (intent) invariant(state.pending?.id === intent.id, 'pending-identity-mismatch');
    if (o.mode === 'live') invariant(this.#authority && this.#authority.expiresAt > now && fresh(this.#authority.checkedAt, now) && this.#authority.pendingIntentId === (intent?.id ?? null), 'exclusive-authority-required');
  }
  async cycle() {
    invariant(this.#initialized, 'runner-not-initialized');
    if (this.#busy) return this.snapshot();
    this.#busy = true; this.#blockers = [];
    const o = this.#options, now = o.clock();
    try {
      this.#heartbeat = now; await this.#event('heartbeat', { state: this.#state }, now);
      if (this.#ledger.state.pauseLatch) { this.#state = 'paused'; return this.snapshot(); }
      if (this.#ledger.state.pending) { this.#state = 'pending'; this.#blockers = ['pending-reconciliation-required']; return this.snapshot(); }
      this.#state = 'observing'; await this.#event('cycle.started', {}, now);
      const feed = await o.market.snapshot({ now, positions: this.#ledger.state.positions, approvals: this.#ledger.state.approvals, mode: o.mode });
      invariant(feed && fresh(feed.at, o.clock()), 'feed-stale');
      for (const flow of feed.funding ?? []) await this.#ledger.funding(flow);
      for (const lot of feed.quarantined ?? []) await this.#ledger.quarantine(lot);
      await this.#ledger.mark({ cashWei: o.mode === 'paper' ? this.#ledger.state.cashWei : feed.cashWei,
        positions: feed.positions, at: o.clock() });
      await this.#ledger.recordCycle(o.clock());
      invariant(Array.isArray(feed.candidates), 'invalid-market-candidates');
      for (const position of this.#ledger.state.positions) {
        const candidate = feed.candidates.find(c => sameAddress(c.token, position.token));
        const signal = exitSignal(position, candidate?.candles ?? [], { now: o.clock() });
        if (signal.action === 'sell') return await this.#execute('sell', candidate, position, position.exitValueWei, signal.reason);
      }
      if (this.#ledger.state.lossLatch) { this.#state = 'blocked'; this.#blockers = ['daily-loss-latched']; return await this.#decision('hold', 'daily-loss-latched'); }
      const finances = this.#ledger.finances();
      invariant(finances.equityWei !== null && finances.availableQuaiWei !== null && finances.exposureWei !== null, 'unknown-accounting');
      const qualified = feed.candidates.filter(c => qualifyCandidate(c, { now: o.clock(), policy: o.policy }).qualified);
      if (!qualified.length) return await this.#decision('hold', 'no-qualified-candidates');
      await this.#gate('buy');
      const last = this.#ledger.state.lastAnalysisAt;
      if (last !== null && o.clock() - last < 300000) return await this.#decision('hold', 'analysis-cooldown');
      if (!o.decisionProvider) return await this.#decision('hold', 'decision-provider-not-configured');
      const cycleId = randomUUID(), candidates = qualified.map(c => buildModelCandidate(c, { now: o.clock(), policy: o.policy, finances }));
      await this.#ledger.recordAnalysis(o.clock()); this.#state = 'analyzing'; await this.#event('analysis.started', { candidateCount: candidates.length });
      const raw = await o.decisionProvider.analyze({ candidates, cycleId, at: o.clock() });
      // Provider adapters attach normalized usage; authority-bearing fields are never forwarded.
      const decision = validateDecision({ action: raw.action, rankedIds: raw.rankedIds, rationale: raw.rationale, veto: raw.veto }, candidates.map(c => c.id));
      const analysis = { rationale: decision.rationale,
        evidence: candidates.filter(c => decision.action === 'hold' || decision.rankedIds.includes(c.id)).slice(0, 3).map(c => ({ candidateId: c.id, features: c.features })),
        guardResults: ['verified-direct-spot', 'closed-candle-trend', 'qualified-volume', 'bounded-quote-cost'].map(guard => ({ guard, passed: true })) };
      await this.#event('analysis.completed', { action: decision.action, candidateCount: decision.rankedIds.length });
      if (decision.action === 'hold' || decision.veto) return await this.#decision('hold', decision.veto ? 'model-veto' : 'model-hold', null, 'held', analysis);
      if (this.#ledger.state.pauseLatch) return await this.#decision('hold', 'runner-paused', null, 'held', analysis);
      if (o.critiqueProvider) {
        const critique = await o.critiqueProvider.analyze({ candidates: candidates.filter(c => decision.rankedIds.includes(c.id)), cycleId, at: o.clock() });
        const checked = validateDecision({ action: critique.action, rankedIds: critique.rankedIds, rationale: critique.rationale, veto: critique.veto }, decision.rankedIds);
        if (checked.veto || checked.action === 'hold') return await this.#decision('hold', 'critique-veto', null, 'held', { ...analysis, rationale: checked.rationale, guardResults: [...analysis.guardResults, { guard: 'independent-critique', passed: false }] });
      }
      const candidate = qualified.find(c => c.id === decision.rankedIds[0]);
      const basis = min(uint(o.policy.capitalWei), uint(finances.equityWei));
      const amount = min(bps(basis, o.policy.maxEntryBps), uint(o.policy.maxPerTxWei), max(0n, uint(o.policy.maxPerDayWei) - uint(this.#ledger.state.day.spentWei)),
        max(0n, bps(basis, o.policy.maxExposureBps) - uint(finances.exposureWei)), uint(finances.availableQuaiWei));
      if (amount === 0n) return await this.#decision('hold', 'no-entry-budget');
      return await this.#execute('buy', candidate, null, amount.toString(), 'qualified-model-selection', analysis);
    } catch (error) {
      const reason = errorCode(error); this.#blockers = [reason];
      this.#state = this.#ledger.state.pending ? 'pending' : this.#ledger.state.pauseLatch ? 'paused' : 'blocked';
      if (reason === 'feed-stale') await this.#event('feed.stale', { reason });
      return await this.#decision('hold', reason);
    } finally { this.#busy = false; }
  }
  async #execute(action, candidate, position, amountWei, reason, analysis = null) {
    const o = this.#options;
    await this.#gate(action);
    invariant(candidate && sameAddress(candidate.token, position?.token ?? candidate.token) && candidate.verified === true && candidate.direct === true && candidate.chainId === 9, 'unverified-route');
    if (action === 'buy') invariant(qualifyCandidate(candidate, { now: o.clock(), policy: o.policy }).qualified, 'candidate-no-longer-qualified');
    const getQuote = () => o.market.quote({ action, candidate: structuredClone(candidate), position: structuredClone(position), approvals: this.#ledger.state.approvals, amountWei,
      units: position?.units ?? null, now: o.clock(), mode: o.mode });
    let quote = await getQuote();
    validateQuote(quote, { now: o.clock(), policy: o.policy });
    for (const key of ['gasWei', 'exitGasWei', 'minOutputWei']) uint(quote[key], key);
    if (action === 'buy') {
      const affordable = min(uint(amountWei), max(0n, uint(o.policy.maxPerDayWei) - uint(this.#ledger.state.day.spentWei) - uint(quote.gasWei)),
        max(0n, uint(this.#ledger.finances().availableQuaiWei) - uint(quote.gasWei) - uint(quote.exitGasWei)));
      invariant(affordable > 0n, 'no-entry-budget-after-gas');
      if (affordable < uint(amountWei)) {
        amountWei = affordable.toString(); quote = await getQuote();
        validateQuote(quote, { now: o.clock(), policy: o.policy });
        for (const key of ['gasWei', 'exitGasWei', 'minOutputWei']) uint(quote[key], key);
      }
    }
    let approval = null;
    if (quote.approval !== undefined) {
      exactObject(quote.approval, quote.approval?.required === true ? ['required', 'token', 'spender', 'units', 'gasWei'] : ['required'], 'invalid-approval-quote');
      invariant(typeof quote.approval.required === 'boolean', 'invalid-approval-quote');
      if (quote.approval.required) {
        approval = quote.approval;
        address(approval.token); address(approval.spender); address(quote.executionTarget); uint(approval.gasWei); uint(approval.units);
        invariant(action === 'sell' && position && o.policy.allowedActions.includes('sell') && sameAddress(approval.token, position.token) &&
          sameAddress(approval.spender, quote.executionTarget) && approval.units === position.units, 'invalid-managed-position-approval');
      }
    }
    const intent = { id: randomUUID(), action: approval ? 'approve' : action, token: candidate.token, venue: candidate.venue, amountWei: approval ? '0' : amountWei,
      units: action === 'buy' ? quote.minOutputWei : position.units, gasWei: approval ? approval.gasWei : quote.gasWei, exitGasWei: quote.exitGasWei, at: o.clock(),
      ...(approval ? { spender: approval.spender, positionId: position.id } : {}) };
    if (approval) quote = { ...quote, gasWei: approval.gasWei };
    await this.#event('proposal', { id: intent.id, action: intent.action, token: intent.token, amountWei: intent.amountWei });
    if (o.mode === 'observe') return this.#decision(approval ? 'hold' : action, approval ? 'approval-required-before-exit' : reason, candidate.token, approval ? 'observed-prerequisite' : 'observed', analysis);
    await this.#gate(action);
    await this.#ledger.reserve(intent);
    this.#state = 'submitting';
    let prepared, preparedHash, prepareStarted = false, prepareCompleted = false, broadcastStarted = false;
    try {
      await this.#event('transaction.prepared', { id: intent.id, action: intent.action, token: intent.token, amountWei: intent.amountWei });
      if (o.mode === 'paper') {
        this.#assertExecutionState(action, intent);
        const receipt = new PaperExecutor().fill(intent, quote);
        prepareStarted = true;
        await this.#ledger.recordHash(intent.id, receipt.txHash, o.clock()); await this.#ledger.reconcile(receipt);
        await this.#event(receipt.status === 1 ? 'transaction.confirmed' : 'transaction.reverted', { id: intent.id, txHash: receipt.txHash, simulated: true });
        return this.#decision(approval ? 'hold' : action, approval ? 'approval-confirmed-awaiting-fresh-exit' : reason, intent.token,
          approval ? 'approval-confirmed' : receipt.status === 1 ? 'paper-filled' : 'paper-reverted', analysis);
      }
      await this.#gate(action, intent);
      invariant(o.executor && typeof o.executor.prepare === 'function' && typeof o.executor.broadcast === 'function', 'live-executor-required');
      // The adapter must prepare/sign only. It cannot broadcast until this callback returns.
      this.#assertExecutionState(action, intent); prepareStarted = true;
      const result = await o.executor.prepare({ intent: structuredClone(intent), quote: structuredClone(quote), policy: structuredClone(o.policy) });
      prepareCompleted = true;
      prepared = result?.prepared;
      preparedHash = hash(result?.txHash); await this.#ledger.recordHash(intent.id, preparedHash, o.clock());
      await this.#event('transaction.pending', { id: intent.id, txHash: result.txHash });
      await this.#gate(action, intent); validateQuote(quote, { now: o.clock(), policy: o.policy });
      this.#assertExecutionState(action, intent); broadcastStarted = true;
      const receipt = await o.executor.broadcast({ prepared, intent: structuredClone(intent), txHash: result.txHash });
      if (receipt) await this.#applyReceipt(receipt);
      if (this.#ledger.state.pending) this.#state = 'pending';
      const outcome = this.#ledger.state.pending ? 'pending' : receipt?.status === 0 ? 'reverted' : 'confirmed';
      return this.#decision(approval ? 'hold' : action, approval ? `approval-${outcome}-awaiting-fresh-exit` : reason, intent.token,
        approval ? `approval-${outcome}` : outcome, analysis);
    } catch (error) {
      let cancelled = false;
      if (!prepareStarted) cancelled = await this.#ledger.cancelUnsent(intent.id, { kind: 'before-prepare' }, o.clock());
      if (o.mode === 'live' && prepareStarted && !prepareCompleted && typeof o.executor?.discardFailedPrepare === 'function') {
        try {
          // The adapter recognizes the exact failure using its private native state. Nothing
          // on the exception itself grants cancellation authority, and no proof survives a crash.
          const proof = await o.executor.discardFailedPrepare({ error, intentId: intent.id });
          cancelled = await this.#ledger.cancelUnsent(intent.id, nativeCancellation(proof, intent.id, null), o.clock());
        } catch { /* A failed or unrecognized native preparation remains unresolved. */ }
      }
      if (prepared !== undefined && typeof o.executor?.discard === 'function') {
        try {
          const proof = await o.executor.discard(prepared);
          if (broadcastStarted && preparedHash) {
            // Releasing the host permit is not evidence that provider dispatch began. After
            // invoking broadcast, only completed native nondispatch proof can release a hash.
            cancelled = await this.#ledger.cancelUnsent(intent.id, nativeCancellation(proof, intent.id, preparedHash), o.clock());
          } else if (!broadcastStarted && preparedHash && proof?.cancelled === true && proof.broadcastStarted === false && proof.txHash?.toLowerCase() === preparedHash.toLowerCase()) {
            if (Object.hasOwn(proof, 'completed') || Object.hasOwn(proof, 'intentId')) nativeCancellation(proof, intent.id, preparedHash);
            else exactObject(proof, ['cancelled', 'broadcastStarted', 'txHash'], 'invalid-cancellation-proof');
            cancelled = await this.#ledger.cancelUnsent(intent.id, { kind: 'discarded', cancelled: true, broadcastStarted: false, txHash: preparedHash }, o.clock());
          }
        } catch { /* An unproven cancellation cannot authorize a retry. */ }
      }
      if (cancelled) {
        this.#state = this.#ledger.state.pauseLatch ? 'paused' : 'blocked'; this.#blockers = [errorCode(error)]; this.#qualification.liveEnabled = false;
        return this.#decision('hold', errorCode(error), intent.token, 'cancelled-before-broadcast');
      }
      if (!this.#ledger.state.pending) { this.#state = 'blocked'; this.#blockers = ['receipt-telemetry-unavailable']; return this.snapshot(); }
      await this.#ledger.unknown(intent.id, o.clock()); this.#state = 'pending';
      await this.#event('transaction.unknown', { id: intent.id, txHash: this.#ledger.state.pending.txHash, retryable: false });
      return this.#decision('hold', 'transaction-outcome-unknown', intent.token, 'unknown');
    }
  }
  async #applyReceipt(receipt) {
    const applied = await this.#ledger.reconcile(receipt);
    if (applied) await this.#event(receipt.status === 1 ? 'transaction.confirmed' : 'transaction.reverted', { id: receipt.id, txHash: receipt.txHash, simulated: false });
    return applied;
  }
  async reconcile() {
    invariant(this.#initialized, 'runner-not-initialized'); invariant(!this.#busy, 'runner-busy');
    const pending = this.#ledger.state.pending;
    if (!pending) return this.snapshot();
    invariant(pending.txHash && this.#options.executor?.receipt, 'receipt-adapter-required');
    this.#busy = true;
    try {
      const receipt = await this.#options.executor.receipt(pending);
      if (receipt) await this.#applyReceipt(receipt);
      this.#state = this.#ledger.state.pending ? 'pending' : this.#ledger.state.pauseLatch ? 'paused' : 'idle'; return this.snapshot();
    } finally { this.#busy = false; }
  }
  async pause(reason = 'local-pause') {
    invariant(this.#initialized, 'runner-not-initialized'); await this.#ledger.pause(this.#options.clock(), reason);
    this.#state = 'paused'; this.#qualification.liveEnabled = false; await this.#event('runner.paused', { reason }); return this.snapshot();
  }
  async run({ signal, intervalMs = 60000, maxCycles = Infinity } = {}) {
    invariant(Number.isSafeInteger(intervalMs) && intervalMs >= 1000, 'invalid-cycle-interval');
    invariant(maxCycles === Infinity || Number.isSafeInteger(maxCycles) && maxCycles > 0, 'invalid-cycle-count');
    await this.initialize();
    for (let n = 0; n < maxCycles && !signal?.aborted; n++) {
      await this.cycle();
      if (n + 1 < maxCycles && !signal?.aborted) { try { await delay(intervalMs, undefined, { signal }); } catch (error) { if (error.name !== 'AbortError') throw error; } }
    }
    await this.#event('runner.stopped', { state: this.#state }); return this.snapshot();
  }
}
