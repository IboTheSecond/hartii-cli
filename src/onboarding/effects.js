// packages/hartii-cli/src/onboarding/effects.js
//
// The real side effects behind SetupFlow: keystore, config caps (through the existing config API only) and the
// backup reminder file. Tests inject fakes instead; `scrypt` is the same TEST-ONLY override the keystore has.
import { Mnemonic } from 'quais';
import { walletCreateGuided, walletImportGuided } from '../commands/walletCmd.js';
import { loadConfig, saveConfig, configSet } from '../config.js';
import { readKeystoreFile, decryptAccount, walletExists, WalletError } from '../keystore.js';
import { markBackupPending, clearBackupPending } from './state.js';

export function makeSetupEffects({ home, scrypt, activate, copyText, walletName } = {}) {
  return {
    walletName,
    createWallet: ({ password, name }) => walletCreateGuided(home, { name: name || walletName, password, scrypt }),
    importWallet: ({ kind, secret, password, name }) => walletImportGuided(home, { kind, secret, password, name: name || walletName, scrypt }),
    saveCaps: ({ perTxQuai, dailyQuai }) => {
      let cfg = loadConfig(home);
      cfg = configSet(cfg, 'limits.perTxQuai', perTxQuai);
      cfg = configSet(cfg, 'limits.dailyQuai', dailyQuai);
      saveConfig(home, cfg);
    },
    markBackupPending: (name) => { try { markBackupPending(home, name); } catch { /* reminder is advisory */ } },
    clearBackupPending: (name) => { try { clearBackupPending(home, name); } catch { /* reminder is advisory */ } },
    /** Decrypts a wallet with its password and returns the recovery phrase to the caller's one-time screen. Never logged. */
    revealPhrase: async ({ name, password }) => {
      if (!walletExists(home, name)) throw new WalletError(`No wallet named "${name}".`);
      const account = await decryptAccount(readKeystoreFile(home, name), password);
      if (!account.mnemonic) throw new WalletError('This wallet was imported from a private key, so it has no recovery phrase to back up.');
      return Mnemonic.fromEntropy(account.mnemonic.entropy).phrase;
    },
    activate,
    copyText,
  };
}
