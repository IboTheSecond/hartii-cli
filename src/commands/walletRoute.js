// packages/hartii-cli/src/commands/walletRoute.js
//
// `hartii wallet <sub> ...` argv routing: which subcommand, how a secret may arrive (hidden prompt by default,
// secret argv is refused). The wallet operations themselves live in walletCmd.js.
import * as walletCmd from './walletCmd.js';
import { WalletError } from '../keystore.js';
import { readHiddenInput } from '../prompt.js';

async function importWallet(home, rest, flags, io) {
  const [kind, ...parts] = rest;
  if (kind !== 'key' && kind !== 'mnemonic') throw new WalletError('Usage: hartii wallet import key|mnemonic [name]  (the secret is read from a hidden prompt or stdin).');
  if (Object.hasOwn(flags, 'from-arg')) throw new WalletError('--from-arg has been removed. Omit the secret and use the hidden prompt or stdin; command-line values are never imported.');
  // A quoted phrase lands here as ONE token with spaces: refuse before prompting, never treat it as the wallet name.
  if (parts.length > 1 || /\s/.test(parts[0] || '') || /^(0x)?[0-9a-fA-F]{64}$/.test(parts[0] || '')) throw new WalletError('Unexpected import arguments. Omit the secret and use the hidden prompt or stdin; --from-arg has been removed.');
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
