// packages/hartii-cli/src/onboarding/password.js
//
// The new-wallet password floor (12 characters, owner 2026-11-16) and a strength HINT. The hint is advice
// only: the floor is the one hard rule. Pure, no I/O. Existing wallets with shorter passwords keep working,
// because only NEW wallets and password changes go through checkNewPassword (unlocking never does).
export const MIN_PASSWORD_LENGTH = 12;

/** @returns {string} '' when acceptable, otherwise one plain sentence. */
export function checkNewPassword(pw) {
  const n = Array.from(String(pw ?? '')).length;
  if (n < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters (you have ${n}).`;
  return '';
}

/**
 * Cheap strength hint: length plus character variety, with a penalty for one repeated character or a short
 * run. `level` 0..4; label is a word so meaning never depends on colour alone.
 * @returns {{ level: 0|1|2|3|4, label: string }}
 */
export function passwordStrength(pw) {
  const chars = Array.from(String(pw ?? ''));
  const n = chars.length;
  if (n === 0) return { level: 0, label: 'empty' };
  if (n < MIN_PASSWORD_LENGTH) return { level: 1, label: 'too short' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const unique = new Set(chars).size;
  if (unique <= 3) return { level: 1, label: 'weak' };
  let score = 2; // meets the floor
  if (n >= 16) score += 1;
  if (classes >= 3 || (n >= 20 && classes >= 2)) score += 1;
  if (/^(.)\1+$/.test(pw) || /^(?:0123|1234|abcd|qwer|pass)/i.test(pw)) score = Math.min(score, 2);
  const level = Math.min(4, score);
  return { level, label: ['empty', 'too short', 'ok', 'good', 'strong'][level] };
}
