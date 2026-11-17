// packages/hartii-cli/src/commands/vault.js
//
// `hartii vault enroll <wallet>` - let another wallet's password unlock the encrypted local data (ledger, contacts, journal).
// Needed only when two wallets use different passwords: the second wallet is otherwise enrolled automatically when
// its password matches. Asks for a password that already opens the vault, then the new wallet's password.
import { CliError } from '../errors.js';
import { assertValidWalletName, readKeystoreFile, decryptAccount, WalletError } from '../keystore.js';
import { resolvePassword } from '../prompt.js';
import { enrollWallet, vaultExists, VaultError } from '../localVault.js';

export class VaultCommandError extends CliError {}

export async function runVault({ sub, args = [], home }, deps = {}) {
  if (sub !== 'enroll' || args.length !== 1) throw new VaultCommandError('Usage: hartii vault enroll <wallet>');
  assertValidWalletName(args[0]);
  if (!vaultExists(home)) throw new VaultCommandError('Nothing to enroll: your local data is not encrypted yet. It is protected the first time you send or add a contact.');
  try {
    const existingPassword = await resolvePassword({ ...deps.passwordDeps, env: {}, label: 'A password that already unlocks your local data: ' });
    const password = await resolvePassword({ ...deps.passwordDeps, env: {}, label: `Password for wallet "${args[0]}": ` });
    await decryptAccount(readKeystoreFile(home, args[0]), password);
    await enrollWallet(home, { existingPassword, wallet: args[0], password });
    return { ok: true, enrolled: args[0] };
  } catch (error) {
    if (error instanceof VaultError || error instanceof WalletError) throw new VaultCommandError(error.message);
    throw error;
  }
}
