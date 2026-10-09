import { createHash } from 'node:crypto';
import { canonicalJson, invariant, uint } from './validation.mjs';
/** Cost inputs must be observed/configured. Missing fees or gas never become zero. */
export class PaperExecutor {
  fill(intent, quote) {
    if (intent.action === 'approve') {
      invariant(uint(intent.amountWei) === 0n && uint(intent.units) > 0n, 'invalid-paper-approval');
      return { id: intent.id, txHash: `0x${createHash('sha256').update(`paper-approval:${canonicalJson(intent)}`).digest('hex')}`,
        status: 1, amountWei: '0', units: '0', gasWei: uint(quote.gasWei).toString(), at: intent.at };
    }
    const price = uint(quote.unitPriceWei), gas = uint(quote.gasWei);
    invariant(price > 0n && Number.isInteger(quote.tokenDecimals) && quote.tokenDecimals >= 0 && quote.tokenDecimals <= 36, 'invalid-paper-price');
    for (const key of ['feeBps', 'impactBps']) invariant(Number.isInteger(quote[key]) && quote[key] >= 0 && quote[key] <= 10000, 'invalid-paper-cost');
    invariant(quote.feeBps + quote.impactBps < 10000, 'invalid-paper-cost');
    const factor = BigInt(10000 - quote.feeBps - quote.impactBps), scale = 10n ** BigInt(quote.tokenDecimals);
    const amount = intent.action === 'buy' ? uint(intent.amountWei) : uint(intent.units) * price * factor / (scale * 10000n);
    const units = intent.action === 'buy' ? amount * factor * scale / (price * 10000n) : uint(intent.units);
    invariant(units > 0n && amount > 0n, 'paper-dust-fill');
    const minimum = uint(quote.minOutputWei ?? (intent.action === 'buy' ? intent.units : undefined), 'minimum-output');
    const succeeded = (intent.action === 'buy' ? units : amount) >= minimum;
    return { id: intent.id, txHash: `0x${createHash('sha256').update(`paper:${canonicalJson(intent)}:${canonicalJson(quote)}`).digest('hex')}`,
      status: succeeded ? 1 : 0, amountWei: succeeded ? amount.toString() : '0', units: succeeded ? units.toString() : '0', gasWei: gas.toString(), at: intent.at };
  }
}
