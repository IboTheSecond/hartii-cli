// packages/hartii-cli/src/commands/contacts.js
//
// `hartii contacts add <name> <address> | list | remove <name> | rename <old> <new>`
// A local, private address book. Names never leave this computer and are never sent anywhere. `hartii send <name> <amount>`
// resolves a saved contact; the send review still shows the full address next to the name.
import { CliError } from '../errors.js';
import { addContact, removeContact, renameContact, loadContacts, ContactError } from '../contacts.js';
import { dataWalletName, unlockLocalData, unlockForRead } from '../localData.js';

export class ContactsCommandError extends CliError {}

const USAGE = 'Usage: hartii contacts add <name> <address> | list | remove <name> | rename <old> <new>';

async function unlock(opts, deps, write) {
  const home = opts.home;
  if (!dataWalletName(home, opts.wallet)) return; // no wallet yet: the book stays a plain private file until one exists
  if (write) await unlockLocalData({ home, wallet: opts.wallet, create: true, passwordDeps: deps.passwordDeps });
  else await unlockForRead(home, { wallet: opts.wallet, passwordDeps: deps.passwordDeps });
}

/**
 * @param {{ sub?: string, args?: string[], home: string, wallet?: string }} opts
 * @param {{ passwordDeps?: object, now?: Date }} [deps]
 */
export async function runContacts(opts, deps = {}) {
  const { sub = 'list', args = [], home } = opts;
  try {
    if (sub === 'list' || sub === 'ls') {
      await unlock(opts, deps, false);
      const contacts = loadContacts(home);
      return { ok: true, count: contacts.length, contacts: contacts.map(({ name, address }) => ({ name, address })), message: contacts.length ? undefined : 'No contacts yet. Add one: hartii contacts add <name> <address>' };
    }
    if (sub === 'add') {
      if (args.length !== 2) throw new ContactsCommandError(USAGE);
      await unlock(opts, deps, true);
      const saved = addContact(home, args[0], args[1], { now: deps.now ? new Date(deps.now) : undefined });
      return { ok: true, saved: { name: saved.name, address: saved.address }, ...(saved.lookalike ? { warning: `This address looks like ${saved.lookalike.label} (same first and last characters) but is different. Make sure you copied the right one.` } : {}) };
    }
    if (sub === 'remove' || sub === 'rm') {
      if (args.length !== 1) throw new ContactsCommandError(USAGE);
      await unlock(opts, deps, true);
      const removed = removeContact(home, args[0]);
      return { ok: true, removed: { name: removed.name, address: removed.address } };
    }
    if (sub === 'rename') {
      if (args.length !== 2) throw new ContactsCommandError(USAGE);
      await unlock(opts, deps, true);
      const renamed = renameContact(home, args[0], args[1]);
      return { ok: true, renamed: { name: renamed.name, address: renamed.address } };
    }
    throw new ContactsCommandError(USAGE);
  } catch (error) {
    if (error instanceof ContactError) throw new ContactsCommandError(error.message);
    throw error;
  }
}
