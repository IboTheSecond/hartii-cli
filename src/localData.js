// packages/hartii-cli/src/localData.js
//
// Glue between the local data vault (localVault.js) and the wallet: which wallet's password unlocks the data, how a
// password is checked before a vault is created, and the two entry points commands use.
//   unlockLocalData  - write paths (password already asked for signing). May create the vault.
//   unlockForRead    - read-only commands that need private data (limits, journal, pending view). Asks once;
//                      never creates a vault; no-op while the home has no vault (plain legacy files).
import { loadConfig } from './config.js';
import { readKeystoreFile, decryptAccount, WalletError } from './keystore.js';
import { resolvePassword } from './prompt.js';
import { ensureUnlocked, vaultExists, isUnlocked } from './localVault.js';

/** Which wallet's password unlocks the data: --wallet, else the selected wallet, else the only wallet. */
export function dataWalletName(home, wallet) {
  if (wallet) return wallet;
  try { return loadConfig(home).currentWallet || undefined; } catch { return undefined; }
}

/**
 * @param {{ home:string, wallet?:string, create?:boolean, passwordDeps?:object, getPassword?:()=>Promise<string>, onAccount?:(account:object)=>void, kdfN?:number }} o
 */
export async function unlockLocalData({ home, wallet, create = false, passwordDeps, getPassword, onAccount, kdfN } = {}) {
  if (isUnlocked(home)) return { unlocked: true };
  const name = dataWalletName(home, wallet);
  const ask = getPassword || (() => resolvePassword({ ...passwordDeps, label: `Password for wallet "${name}": ` }));
  return ensureUnlocked(home, {
      wallet: name, getPassword: ask, create, kdfN,
      verifyPassword: async (password) => {
        let account;
        try { account = await decryptAccount(readKeystoreFile(home, name), password); }
        catch (error) { throw error instanceof WalletError ? error : new WalletError('Could not verify that password against the wallet.'); }
        onAccount?.(account);
      },
    });
}

/**
 * Read-only commands that only SHOW private data: unlock when possible, otherwise answer `false` (locked) instead of
 * failing, so scripts and agents still get the public part of the answer and never a crash.
 */
export async function tryUnlockForRead(home, opts = {}) {
  if (!vaultExists(home) || isUnlocked(home)) return true;
  try { await unlockForRead(home, opts); return isUnlocked(home); } catch { return false; }
}

/** Read-only commands: unlock if (and only if) a vault already protects this home. */
export function unlockForRead(home, { wallet, passwordDeps } = {}) {
  if (isUnlocked(home) || !vaultExists(home)) return Promise.resolve({ unlocked: isUnlocked(home), plain: !vaultExists(home) });
  return unlockLocalData({ home, wallet, create: false, passwordDeps });
}
