// These probes are generated public storage getters, so only a genuine empty execution revert
// can indicate an older curve. quais also wraps RPC rate limits/timeouts as CALL_EXCEPTION:
// that code and absent decoded data alone never establish selector absence.
export function isEmptyCurveSelectorRevert(error) {
  if (error?.code !== 'CALL_EXCEPTION' || error.revert != null) return false;
  const raw = error.info?.error;
  if (error.info?.payload?.method !== 'quai_call' || !raw || typeof raw !== 'object'
    || typeof raw.message !== 'string' || !/^execution reverted$/i.test(raw.message.trim())) return false;
  const empty = value => value === undefined || value === null || value === '0x';
  if (!empty(error.data) || !empty(raw.data)) return false;
  // alpha.54 synthesizes this reason for an empty 0x payload; it is not an application reason.
  return error.reason == null || (error.reason === 'require(false)' && error.data === '0x' && raw.data === '0x');
}
