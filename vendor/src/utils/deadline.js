export const DEADLINE_SECONDS = 20 * 60;

/** Inclusive transaction deadline shared by HartiiSwap and V3 curve writes. */
export function deadlineTimestamp() {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}
