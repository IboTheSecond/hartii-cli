// packages/hartii-cli/src/commands/walletRoute.js
//
// `hartii wallet <sub> ...` argv routing: which subcommand, how a secret may arrive (hidden prompt by default,
// argv only behind --from-arg with a loud warning). The wallet operations themselves live in walletCmd.js.
import * as walletCmd from './walletCmd.js';
import { WalletError } from '../keystore.js';
import { readHiddenInput } from '../prompt.js';

const MNEMONIC_LENGTHS = [12, 15, 18, 21, 24];

/** `import ... --from-arg`: split argv into [secret, name] (a phrase may arrive as separate words). */
function secretFromArgv(kind, parts) {
  if (kind === 'key') return parts;
  for (const n of MNEMONIC_LENGTHS) if (parts.length === n + 1) return [parts.slice(0, n).join(' '), parts[n]];
  if (parts.length === 2 && parts[0].trim().split(/\s+/).length >= 12) return [parts[0], parts[1]];
  return [parts.join(' '), undefined];
}

async function importWallet(home, rest, flags, io) {
  const [kind, ...parts] = rest;
  if (kind !== 'key' && kind !== 'mnemonic') throw new WalletError('Usage: hartii wallet import key|mnemonic [name]  (the secret is read from a hidden prompt or stdin).');
  if (flags['from-arg']) {
    // Explicit opt-in: the secret is in argv, so it lands in shell history and `ps` output.
    io.writeErr('WARNING: --from-arg puts your secret on the command line: it is saved in shell history and visible to other local processes. Prefer the hidden prompt (omit --from-arg) and clear your history now.');
    const [value, name] = secretFromArgv(kind, parts);
    return walletCmd.walletImport(home, kind, value, name, io);
  }
  // A quoted phrase lands here as ONE token with spaces: refuse before prompting, never treat it as the wallet name.
  if (parts.length > 1 || /\s/.test(parts[0] || '') || /^(0x)?[0-9a-fA-F]{64}$/.test(parts[0] || '')) throw new WalletError('Unexpected extra arguments. The secret is no longer accepted on the command line (shell history); omit it to get a hidden prompt, or pass --from-arg to accept that risk.');
  const promptFn = io.promptFn || readHiddenInput;
  const secret = await promptFn(kind === 'key' ? 'Private key (hidden): ' : 'Recovery phrase (hidden): ', io);
  return walletCmd.walletImport(home, kind, String(secret).trim(), parts[0], io);
}

/** `hartii wallet <sub> ...` — the one place the wallet subcommands are routed. */
export async function runWallet([sub, ...rest], flags, { home, io }) {
  switch (sub) {
    case 'new': return walletCmd.walletNew(home, rest[0], io);
    case 'import': return importWallet(home, rest, flags, io);
    case 'list': return { wallets: walletCmd.walletList(home) };
    case 'use': return walletCmd.walletUse(home, rest[0]);
    case 'address': return walletCmd.walletAddress(home, rest[0], { qr: Boolean(flags.qr) });
    case 'export': return walletCmd.walletExport(home, rest[0], io);
    case 'rename': return walletCmd.walletRename(home, rest[0], rest[1]);
    case 'remove': return walletCmd.walletRemove(home, rest[0], io);
    case 'lock-check': return walletCmd.walletLockCheck(home, rest[0]);
    default:
      throw new WalletError(`Unknown \`wallet\` subcommand "${sub || ''}". Try: new, import, list, use, address, export, rename, remove, lock-check.`);
  }
}
