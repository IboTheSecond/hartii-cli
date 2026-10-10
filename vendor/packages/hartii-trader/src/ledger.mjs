import { address, bps, canonicalJson, dayOf, exactObject, hash, identifier, invariant, max, min, timestamp, uint } from './validation.mjs';
import { HBOME_TOKEN, canonicalPolicyMessage, validatePolicy } from './policy.mjs';
import { randomUUID } from 'node:crypto';

function equity(state, cashWei = state.cashWei) {
  if (cashWei === null || state.positions.some(p => p.exitValueWei === null)) return null;
  return uint(cashWei) + state.positions.reduce((n, p) => n + uint(p.exitValueWei), 0n);
}
function exposure(state) {
  if (state.positions.some(p => p.exitValueWei === null)) return null;
  return state.positions.reduce((n, p) => n + max(uint(p.costBasisWei), uint(p.exitValueWei)), 0n) + (state.pending?.action === 'buy' ? uint(state.pending.amountWei) : 0n);
}
function refreshAccounting(state) {
  state.accountingUnknown = state.accountingFault || state.cashUncertainty || state.cashWei === null ||
    state.accountedCashWei === null || state.cashWei !== state.accountedCashWei;
}
function rememberCashObservation(state, cashWei, at) {
  if (cashWei === null || state.accountedCashWei === null || cashWei === state.accountedCashWei && !state.cashUncertainty) return;
  const observation = { at, cashWei, expectedCashWei: state.accountedCashWei };
  const previous = state.cashObservations.at(-1);
  if (!previous || previous.cashWei !== cashWei || previous.expectedCashWei !== observation.expectedCashWei) state.cashObservations.push(observation);
  state.cashUncertainty = true;
}
function applyCashEvidence(state, delta, eventAt, resolve) {
  for (const observation of state.cashObservations) {
    if (eventAt <= observation.at) observation.expectedCashWei = (BigInt(observation.expectedCashWei) + delta).toString();
  }
  // Preserve the observed path, including a return to the expected balance. A later
  // unrelated transfer cannot explain an earlier observation, even if today's net
  // balance matches. Only discard a fully explained chronological prefix.
  if (resolve) {
    while (state.cashObservations.length && state.cashObservations[0].cashWei === state.cashObservations[0].expectedCashWei) state.cashObservations.shift();
    state.cashUncertainty = state.cashObservations.length > 0;
  }
}
function anchorDay(state) {
  const accountedEquity = equity(state, state.accountedCashWei);
  if (state.day.openingEquityWei === null && !state.accountingFault && accountedEquity !== null) {
    const opening = accountedEquity - uint(state.day.incomingWei) + uint(state.day.withdrawalsWei);
    if (opening >= 0n) state.day.openingEquityWei = opening.toString();
  }
}
function rollDay(state, at) {
  const day = dayOf(at);
  if (!state.day || state.day.date < day) state.day = { date: day, openingEquityWei: state.accountingFault ? null : equity(state, state.accountedCashWei)?.toString() ?? null,
    incomingWei: '0', withdrawalsWei: '0', spentWei: '0' };
}
function lossCheck(state, policy, at) {
  // Accounted cash excludes unexplained external movements. Known position losses
  // and verified gas still count immediately, before rollover can replace the basis.
  const current = equity(state, state.accountedCashWei), opening = state.day.openingEquityWei === null ? null : uint(state.day.openingEquityWei);
  if (opening !== null && opening > 0n && current !== null && !state.lossLatch) {
    const loss = opening + uint(state.day.incomingWei) - uint(state.day.withdrawalsWei) - current;
    if (loss * 10000n >= opening * BigInt(policy.maxDailyLossBps)) state.lossLatch = { reason: 'daily-loss', at, day: state.day.date, lossWei: loss.toString(), openingEquityWei: opening.toString() };
  }
}
function identity(policy, mode) { return { owner: policy.owner.toLowerCase(), tradingWallet: policy.tradingWallet.toLowerCase(), runnerId: policy.runnerId, chainId: 9, mode }; }
export class TraderLedger {
  #state; #journal; #policy; #clock; #queue = Promise.resolve();
  static async open({ journal, policy, mode, clock = Date.now, now = clock(), initialBalanceWei = null }) {
    validatePolicy(policy, { now: policy.issuedAt }); timestamp(now);
    invariant(['observe', 'paper', 'live'].includes(mode), 'invalid-mode');
    if (initialBalanceWei !== null) uint(initialBalanceWei);
    const ledger = new TraderLedger(); ledger.#journal = journal; ledger.#policy = structuredClone(policy); ledger.#clock = clock;
    const events = await journal.read(); const latest = events.filter(r => r.type === 'ledger.state').at(-1);
    if (latest) {
      invariant(canonicalJson(latest.data.identity) === canonicalJson(identity(policy, mode)), 'journal-identity-mismatch');
      ledger.#state = structuredClone(latest.data);
      ledger.#state.lastProcessedAt ??= events.filter(r => r.type === 'ledger.state').reduce((last, r) => Math.max(last, r.at), 0);
      ledger.#state.lastMarkedAt ??= ledger.#state.lastProcessedAt;
      ledger.#state.flows ??= [];
      ledger.#state.cancelled ??= [];
      ledger.#state.approvals ??= [];
      ledger.#state.pauseHistory ??= [];
      ledger.#state.resumeHistory ??= [];
      if (ledger.#state.pauseLatch) {
        const paused = ledger.#state.pauseLatch;
        paused.id ??= `legacy-pause-${paused.at}-${paused.reason}`;
        paused.policyNonce ??= null;
        if (!ledger.#state.pauseHistory.some(p => p.id === paused.id)) ledger.#state.pauseHistory.push(structuredClone(paused));
      }
      // Older journals did not preserve the cash baseline. Never guess that an old
      // unknown flag came only from funding, or use new proof to clear other faults.
      if (!Object.hasOwn(ledger.#state, 'accountedCashWei')) {
        ledger.#state.accountedCashWei = ledger.#state.cashWei;
        ledger.#state.accountingFault = ledger.#state.accountingUnknown;
        ledger.#state.cashUncertainty = false;
        ledger.#state.lastCashObservedAt = ledger.#state.lastMarkedAt;
      }
      if (!Object.hasOwn(ledger.#state, 'cashObservations')) {
        // An older uncertainty flag did not retain the observed cash path. Current
        // equality cannot reconstruct it, so require deliberate investigation.
        ledger.#state.accountingFault ||= ledger.#state.cashUncertainty;
        ledger.#state.cashObservations = [];
      }
      refreshAccounting(ledger.#state);
      invariant(uint(policy.nonce) >= uint(ledger.#state.policyNonce) && (policy.nonce !== ledger.#state.policyNonce || canonicalPolicyMessage(policy) === ledger.#state.policyMessage), 'policy-nonce-reuse-or-rollback');
      if (policy.nonce !== ledger.#state.policyNonce) {
        ledger.#state.policyNonce = policy.nonce; ledger.#state.policyMessage = canonicalPolicyMessage(policy);
        ledger.#state.lastProcessedAt = Math.max(now, ledger.#state.lastProcessedAt);
        await journal.append({ type: 'ledger.state', at: ledger.#state.lastProcessedAt, data: ledger.#state });
      }
    } else {
      ledger.#state = { schemaVersion: 1, identity: identity(policy, mode), cashWei: initialBalanceWei, accountedCashWei: initialBalanceWei,
        accountingUnknown: initialBalanceWei === null, accountingFault: false, cashUncertainty: false, lastCashObservedAt: null, cashObservations: [],
        policyNonce: policy.nonce, policyMessage: canonicalPolicyMessage(policy), lastProcessedAt: now, lastMarkedAt: null, flows: [],
        positions: [], approvals: [], quarantined: [], pending: null, settled: [], cancelled: [], fundingIds: [], incomingWei: '0', withdrawalsWei: '0', gasWei: '0',
        realizedPnlWei: '0', lossLatch: null, pauseLatch: null, pauseHistory: [], resumeHistory: [], day: null, lastAnalysisAt: null, lastCycleAt: null };
      rollDay(ledger.#state, now);
      await journal.append({ type: 'ledger.state', at: now, data: ledger.#state });
    }
    return ledger;
  }
  get state() { return structuredClone(this.#state); }
  get policy() { return structuredClone(this.#policy); }
  #commit(eventAt, mutate, duplicate = () => false) {
    const op = this.#queue.then(async () => {
      timestamp(eventAt);
      // Idempotency is checked before clocks, rollover, loss checks, or writes.
      if (duplicate(this.#state)) return false;
      const processedAt = Math.max(timestamp(this.#clock()), this.#state.lastProcessedAt);
      invariant(eventAt <= processedAt, 'future-ledger-event');
      const next = structuredClone(this.#state); rollDay(next, processedAt);
      const result = mutate(next, processedAt); next.lastProcessedAt = processedAt; refreshAccounting(next); lossCheck(next, this.#policy, processedAt);
      await this.#journal.append({ type: 'ledger.state', at: processedAt, data: next }); this.#state = next; return result;
    }); this.#queue = op.catch(() => {}); return op;
  }
  finances() {
    const s = this.#state, eq = equity(s), exp = exposure(s);
    const exitGasFor = p => s.pending?.action === 'approve' && s.pending.positionId === p.id ? s.pending.exitGasWei : p.exitGasWei;
    const exitGas = s.positions.some(p => exitGasFor(p) === null) ? null : s.positions.reduce((n, p) => n + uint(exitGasFor(p)), 0n);
    let available = null;
    if (s.cashWei !== null && exitGas !== null && !s.accountingUnknown && s.day.openingEquityWei !== null) {
      const p = s.pending; const reserved = p ? uint(p.gasWei) + (p.action === 'buy' ? uint(p.amountWei) + uint(p.exitGasWei) : 0n) : 0n;
      available = max(0n, uint(s.cashWei) - exitGas - reserved).toString();
    }
    return { equityWei: eq?.toString() ?? null, availableQuaiWei: available, exposureWei: exp?.toString() ?? null,
      realizedPnlWei: s.realizedPnlWei, unrealizedPnlWei: eq === null ? null : s.positions.reduce((n, p) => n + uint(p.exitValueWei) - uint(p.costBasisWei), 0n).toString(),
      gasWei: s.gasWei, modelCostMicrousd: null };
  }
  reserve(intent) {
    exactObject(intent, ['id', 'action', 'token', 'venue', 'amountWei', 'units', 'gasWei', 'exitGasWei', 'at', ...(intent?.action === 'approve' ? ['spender', 'positionId'] : [])]);
    identifier(intent.id); address(intent.token); timestamp(intent.at);
    if (intent.action === 'approve') { address(intent.spender); identifier(intent.positionId); }
    invariant(intent.token.toLowerCase() !== HBOME_TOKEN.toLowerCase(), 'hbome-excluded');
    for (const key of ['amountWei', 'units', 'gasWei', 'exitGasWei']) uint(intent[key], key);
    return this.#commit(intent.at, (s, processedAt) => {
      validatePolicy(this.#policy, { now: s.identity.mode === 'live' ? processedAt : this.#policy.issuedAt });
      invariant(processedAt - intent.at <= 30000, 'stale-intent');
      invariant(!s.pending, 'pending-transaction');
      invariant(!s.settled.some(r => r.id === intent.id) && !s.cancelled.some(r => r.id === intent.id), 'duplicate-intent');
      invariant(this.#policy.allowedActions.includes(intent.action === 'approve' ? 'sell' : intent.action) && this.#policy.allowedVenues.includes(intent.venue), 'policy-action-denied');
      invariant(!s.pauseLatch, 'runner-paused');
      const gas = uint(intent.gasWei), amount = uint(intent.amountWei);
      invariant(gas <= uint(this.#policy.maxFeeWei), 'fee-cap');
      invariant(s.cashWei !== null, 'unknown-cash');
      // The daily turnover cap limits NEW risk only. A managed exit (approve or sell) is bounded by the fee cap and cash,
      // so a buy that used the whole day budget can never strand its own stop-loss. Exit gas still lands in spentWei at settlement.
      if (intent.action === 'buy') invariant(uint(s.day.spentWei) + gas + amount <= uint(this.#policy.maxPerDayWei), 'daily-spend-cap');
      if (intent.action === 'buy') {
        invariant(!s.lossLatch, 'daily-loss-latched');
        invariant(s.day.openingEquityWei !== null, 'unknown-daily-basis');
        invariant(!s.accountingUnknown && equity(s) !== null && exposure(s) !== null && s.positions.every(p => p.exitGasWei !== null), 'unknown-accounting-or-exit-gas');
        invariant(amount > 0n && uint(intent.units) > 0n, 'positive-entry-required');
        const basis = min(uint(this.#policy.capitalWei), equity(s));
        invariant(amount <= bps(basis, this.#policy.maxEntryBps), 'entry-cap');
        invariant(amount <= uint(this.#policy.maxPerTxWei), 'per-tx-cap');
        invariant(exposure(s) + amount <= bps(basis, this.#policy.maxExposureBps), 'exposure-cap');
        invariant(s.positions.length < this.#policy.maxPositions && !s.positions.some(p => p.token.toLowerCase() === intent.token.toLowerCase()), 'position-limit');
        const exitReserve = s.positions.reduce((n, p) => n + uint(p.exitGasWei), uint(intent.exitGasWei));
        invariant(uint(s.cashWei) >= amount + gas + exitReserve, 'insufficient-gas-reserve');
      } else if (intent.action === 'approve') {
        const position = s.positions.find(p => p.id === intent.positionId);
        invariant(position && position.token.toLowerCase() === intent.token.toLowerCase() && position.venue === intent.venue && intent.units === position.units && amount === 0n, 'invalid-managed-position-approval');
        invariant(!s.approvals.some(a => a.positionId === position.id && a.spender.toLowerCase() === intent.spender.toLowerCase() && a.units === intent.units), 'approval-already-confirmed');
        const otherPositions = s.positions.filter(p => p.id !== position.id);
        invariant(otherPositions.every(p => p.exitGasWei !== null), 'unknown-approval-exit-reserve');
        const remainingExits = otherPositions.reduce((sum, p) => sum + uint(p.exitGasWei), uint(intent.exitGasWei));
        invariant(uint(s.cashWei) >= gas + remainingExits, 'insufficient-approval-and-exit-gas');
      } else {
        const p = s.positions.find(p => p.token.toLowerCase() === intent.token.toLowerCase());
        invariant(p && intent.units === p.units && intent.venue === p.venue, 'unknown-position-or-partial-exit');
        invariant(uint(s.cashWei) >= gas, 'insufficient-exit-gas');
      }
      s.pending = { ...structuredClone(intent), txHash: null, status: 'reserved' };
    });
  }
  recordHash(id, txHash, at = this.#clock()) {
    hash(txHash); return this.#commit(at, s => {
      invariant(s.pending?.id === id && (!s.pending.txHash || s.pending.txHash.toLowerCase() === txHash.toLowerCase()), 'pending-identity-mismatch');
      s.pending.txHash = txHash; s.pending.status = 'pending';
    }, s => s.pending?.id === id && s.pending.txHash?.toLowerCase() === txHash.toLowerCase() && s.pending.status === 'pending');
  }
  unknown(id, at) { return this.#commit(at, s => { invariant(s.pending?.id === id, 'pending-identity-mismatch'); s.pending.status = 'unknown'; }, s => s.pending?.id === id && s.pending.status === 'unknown'); }
  /** Called only by the native execution state machine, never based on an exception's claims. */
  cancelUnsent(id, proof, at = this.#clock()) {
    identifier(id); exactObject(proof, proof?.kind === 'before-prepare' ? ['kind'] :
      ['kind', 'cancelled', 'broadcastStarted', 'txHash', ...(proof?.kind === 'native-undispatched' ? ['intentId', 'completed'] : [])]);
    invariant(['before-prepare', 'discarded', 'native-undispatched'].includes(proof.kind), 'invalid-cancellation-proof');
    if (proof.kind === 'discarded') { hash(proof.txHash); invariant(proof.cancelled === true && proof.broadcastStarted === false, 'invalid-cancellation-proof'); }
    if (proof.kind === 'native-undispatched') {
      invariant(proof.cancelled === true && proof.broadcastStarted === false && proof.completed === true && proof.intentId === id, 'invalid-cancellation-proof');
      if (proof.txHash !== null) hash(proof.txHash);
    }
    return this.#commit(at, (s, processedAt) => {
      invariant(s.pending?.id === id, 'pending-identity-mismatch');
      if (proof.kind === 'before-prepare' || proof.kind === 'native-undispatched' && proof.txHash === null) invariant(s.pending.status === 'reserved' && s.pending.txHash === null, 'prepared-intent-cannot-cancel-unsigned');
      else if (proof.kind === 'native-undispatched') invariant(s.pending.txHash?.toLowerCase() === proof.txHash.toLowerCase(), 'cancellation-hash-mismatch');
      else invariant(s.pending.txHash === null ? s.pending.status === 'reserved' : s.pending.txHash.toLowerCase() === proof.txHash.toLowerCase(), 'cancellation-hash-mismatch');
      s.cancelled.push({ id, kind: proof.kind, txHash: proof.kind === 'before-prepare' ? null : proof.txHash, eventAt: at, processedAt });
      s.pending = null; return true;
    }, s => s.cancelled.some(record => record.id === id));
  }
  reconcile(receipt) {
    exactObject(receipt, ['id', 'txHash', 'status', 'gasWei', 'amountWei', 'units', 'at']);
    identifier(receipt.id); hash(receipt.txHash); timestamp(receipt.at);
    return this.#commit(receipt.at, (s, processedAt) => {
      const p = s.pending;
      invariant(p?.id === receipt.id && p.txHash?.toLowerCase() === receipt.txHash.toLowerCase(), 'receipt-identity-mismatch');
      if (receipt.status !== 0 && receipt.status !== 1) { p.status = 'unknown'; return false; }
      const gas = uint(receipt.gasWei), amount = uint(receipt.amountWei), units = uint(receipt.units);
      invariant(s.accountedCashWei !== null, 'unknown-cash');
      const cashMatched = s.cashWei === s.accountedCashWei;
      let cash = uint(s.accountedCashWei) - gas;
      s.gasWei = (uint(s.gasWei) + gas).toString();
      s.day.spentWei = (uint(s.day.spentWei) + gas).toString();
      if (gas > uint(p.gasWei)) s.accountingFault = true;
      if (receipt.status === 1 && p.action === 'buy') {
        invariant(amount > 0n && units > 0n, 'invalid-buy-receipt');
        cash -= amount; s.day.spentWei = (uint(s.day.spentWei) + amount).toString();
        if (amount > uint(p.amountWei) || units < uint(p.units)) s.accountingFault = true;
        s.positions.push({ id: p.id, token: p.token, symbol: null, venue: p.venue, units: units.toString(), costBasisWei: amount.toString(),
          exitValueWei: null, peakExitValueWei: amount.toString(), exitGasWei: p.exitGasWei, pnlWei: null, status: 'open', updatedAt: receipt.at });
      } else if (receipt.status === 1 && p.action === 'approve') {
        invariant(amount === 0n && units === 0n && s.positions.some(position => position.id === p.positionId && position.token.toLowerCase() === p.token.toLowerCase() && position.units === p.units), 'invalid-approval-receipt');
        s.approvals.push({ id: p.id, positionId: p.positionId, token: p.token, spender: p.spender, units: p.units, txHash: receipt.txHash, at: receipt.at, simulated: s.identity.mode === 'paper' });
      } else if (receipt.status === 1) {
        const position = s.positions.find(x => x.token.toLowerCase() === p.token.toLowerCase());
        invariant(position && units === uint(position.units), 'invalid-sell-receipt');
        cash += amount; s.realizedPnlWei = (BigInt(s.realizedPnlWei) + amount - uint(position.costBasisWei)).toString();
        s.positions = s.positions.filter(x => x.id !== position.id);
      }
      invariant(cash >= 0n, 'receipt-negative-cash');
      applyCashEvidence(s, cash - uint(s.accountedCashWei), receipt.at, true); s.accountedCashWei = cash.toString();
      if (cashMatched) s.cashWei = s.accountedCashWei;
      s.settled.push({ id: p.id, txHash: receipt.txHash, status: receipt.status, eventAt: receipt.at, processedAt, accountingDay: s.day.date }); s.pending = null; return true;
    }, s => s.settled.some(r => r.id === receipt.id && r.txHash.toLowerCase() === receipt.txHash.toLowerCase()) ||
      (receipt.status !== 0 && receipt.status !== 1 && s.pending?.id === receipt.id && s.pending.txHash?.toLowerCase() === receipt.txHash.toLowerCase() && s.pending.status === 'unknown'));
  }
  mark({ cashWei, positions, at }) {
    if (cashWei !== null) uint(cashWei); invariant(Array.isArray(positions), 'invalid-position-marks');
    for (const p of positions) { exactObject(p, ['id', 'exitValueWei', 'exitGasWei']); identifier(p.id); if (p.exitValueWei !== null) uint(p.exitValueWei); if (p.exitGasWei !== null) uint(p.exitGasWei); }
    return this.#commit(at, (s, processedAt) => {
      invariant((s.lastMarkedAt === null || at >= s.lastMarkedAt) && processedAt - at <= 30000, 'stale-mark');
      s.lastMarkedAt = at;
      invariant(s.lastCashObservedAt === null || at >= s.lastCashObservedAt, 'stale-cash-observation');
      const firstVerifiedCash = s.accountedCashWei === null && cashWei !== null && !s.accountingFault && !s.pending && s.positions.length === 0 && s.settled.length === 0 && s.fundingIds.length === 0 && s.day.openingEquityWei === null;
      if (firstVerifiedCash) { s.accountedCashWei = cashWei; s.day.openingEquityWei = cashWei; }
      else rememberCashObservation(s, cashWei, at);
      s.cashWei = cashWei; s.lastCashObservedAt = at;
      invariant(new Set(positions.map(p => p.id)).size === positions.length && positions.every(mark => s.positions.some(p => p.id === mark.id)), 'unknown-or-duplicate-position-mark');
      for (const p of s.positions) {
        const mark = positions.find(m => m.id === p.id);
        p.exitValueWei = mark?.exitValueWei ?? null; p.exitGasWei = mark?.exitGasWei ?? null; p.updatedAt = at;
        p.pnlWei = p.exitValueWei === null ? null : (uint(p.exitValueWei) - uint(p.costBasisWei)).toString();
        if (p.exitValueWei !== null) p.peakExitValueWei = max(uint(p.peakExitValueWei), uint(p.exitValueWei)).toString();
      }
      refreshAccounting(s); anchorDay(s);
    });
  }
  funding(flow) { return this.#funding(flow); }
  /** Trusted host: canonical transfer proof and a fresh independently read wallet balance. */
  reconcileFunding(flow, observation) {
    exactObject(observation, ['observedCashWei', 'checkedAt']); uint(observation.observedCashWei); timestamp(observation.checkedAt);
    return this.#funding(flow, observation);
  }
  #funding(flow, observation = null) {
    exactObject(flow, ['id', 'direction', 'amountWei', 'gasWei', 'at']); identifier(flow.id);
    const amount = uint(flow.amountWei), gas = uint(flow.gasWei === undefined ? '0' : flow.gasWei);
    invariant(amount > 0n && ['deposit', 'withdrawal'].includes(flow.direction), 'invalid-funding');
    invariant(flow.direction === 'withdrawal' || gas === 0n, 'deposit-cannot-charge-sender-gas');
    return this.#commit(flow.at, (s, processedAt) => {
      invariant(s.accountedCashWei !== null && !s.pending, 'unknown-or-pending-funding');
      if (observation) invariant(observation.checkedAt >= flow.at && observation.checkedAt <= processedAt && processedAt - observation.checkedAt <= 30000 &&
        (s.lastCashObservedAt === null || observation.checkedAt >= s.lastCashObservedAt), 'stale-cash-observation');
      // A late transfer may be the first explanation after UTC rollover. Anchor to
      // the preserved accounted balance before applying it, so its gas is still loss.
      if (s.day.openingEquityWei === null && !s.accountingFault && s.positions.every(p => p.exitValueWei !== null)) {
        const opening = s.positions.reduce((sum, p) => sum + uint(p.exitValueWei), uint(s.accountedCashWei)) -
          uint(s.day.incomingWei) + uint(s.day.withdrawalsWei);
        if (opening >= 0n) s.day.openingEquityWei = opening.toString();
      }
      const incoming = flow.direction === 'deposit', key = incoming ? 'incomingWei' : 'withdrawalsWei';
      const cashMatched = s.cashWei === s.accountedCashWei && !s.cashUncertainty;
      const delta = incoming ? amount : -amount - gas;
      const cash = uint(s.accountedCashWei) + delta; invariant(cash >= 0n, 'excess-withdrawal');
      if (observation) rememberCashObservation(s, observation.observedCashWei, observation.checkedAt);
      applyCashEvidence(s, delta, flow.at, observation !== null);
      s.accountedCashWei = cash.toString();
      if (observation) { s.cashWei = observation.observedCashWei; s.lastCashObservedAt = observation.checkedAt; }
      else if (cashMatched) s.cashWei = s.accountedCashWei;
      if (s.cashWei !== null && s.cashWei !== s.accountedCashWei) s.cashUncertainty = true;
      s[key] = (uint(s[key]) + amount).toString(); s.day[key] = (uint(s.day[key]) + amount).toString(); s.fundingIds.push(flow.id);
      s.gasWei = (uint(s.gasWei) + gas).toString(); s.day.spentWei = (uint(s.day.spentWei) + gas).toString();
      s.flows.push({ id: flow.id, direction: flow.direction, amountWei: flow.amountWei, gasWei: gas.toString(), source: 'external-funding',
        eventAt: flow.at, processedAt, accountingDay: s.day.date });
      refreshAccounting(s); anchorDay(s); return true;
    }, s => s.fundingIds.includes(flow.id));
  }
  quarantine(lot) {
    exactObject(lot, ['token', 'units', 'at']); address(lot.token); uint(lot.units);
    return this.#commit(lot.at, s => { s.quarantined.push(structuredClone(lot)); }, s => s.quarantined.some(q => q.token.toLowerCase() === lot.token.toLowerCase() && q.units === lot.units && q.at === lot.at));
  }
  pause(at = this.#clock(), reason = 'local-pause') {
    invariant(['local-pause', 'remote-pause'].includes(reason), 'invalid-pause-reason');
    return this.#commit(at, s => {
      // A control-file pause may predate the first policy ever loaded by this journal.
      s.pauseLatch = { id: randomUUID(), at, reason, policyNonce: this.#policy.issuedAt <= at ? s.policyNonce : null };
      s.pauseHistory.push(structuredClone(s.pauseLatch));
    }, s => s.pauseLatch !== null);
  }
  /** Trusted local ARM path only, after cryptographic owner verification and typed approval. */
  resumeAfterLocalApproval(proof) {
    exactObject(proof, ['policyNonce', 'policyMessage', 'pauseId', 'pauseAt', 'controlPauseId'], 'invalid-resume-proof');
    uint(proof.policyNonce); identifier(proof.pauseId); timestamp(proof.pauseAt);
    if (proof.controlPauseId !== undefined) identifier(proof.controlPauseId);
    const message = canonicalPolicyMessage(this.#policy), at = timestamp(this.#clock());
    invariant(proof.policyNonce === this.#policy.nonce && proof.policyMessage === message, 'resume-policy-mismatch');
    validatePolicy(this.#policy, { now: Math.max(at, this.#state.lastProcessedAt) });
    return this.#commit(at, (s, processedAt) => {
      validatePolicy(this.#policy, { now: processedAt });
      invariant(s.policyNonce === proof.policyNonce && s.policyMessage === proof.policyMessage, 'resume-policy-mismatch');
      const paused = s.pauseLatch;
      invariant(paused && paused.id === proof.pauseId && paused.at === proof.pauseAt, 'resume-pause-identity-mismatch');
      invariant(this.#policy.issuedAt > paused.at && (paused.policyNonce === null || uint(proof.policyNonce) > uint(paused.policyNonce)) &&
        !s.resumeHistory.some(r => r.policyNonce === proof.policyNonce), 'resume-fresh-policy-required');
      invariant(!s.pending, 'pending-transaction');
      s.resumeHistory.push({ pause: structuredClone(paused), policyNonce: proof.policyNonce, policyMessage: message, at: processedAt,
        ...(proof.controlPauseId !== undefined ? { controlPauseId: proof.controlPauseId } : {}) });
      s.pauseLatch = null; return true;
    }, s => s.pauseLatch === null && !s.pending && s.resumeHistory.some(r => r.pause.id === proof.pauseId && r.pause.at === proof.pauseAt &&
      r.policyNonce === proof.policyNonce && r.policyMessage === proof.policyMessage && r.controlPauseId === proof.controlPauseId));
  }
  recordAnalysis(at) { return this.#commit(at, s => { s.lastAnalysisAt = timestamp(at); }, s => s.lastAnalysisAt !== null && s.lastAnalysisAt >= at); }
  recordCycle(at) { return this.#commit(at, s => { s.lastCycleAt = timestamp(at); }, s => s.lastCycleAt !== null && s.lastCycleAt >= at); }
}
