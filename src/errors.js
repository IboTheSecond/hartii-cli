// packages/hartii-cli/src/errors.js
//
// One base class for every error the CLI expects and prints as a plain message (no stack trace).
// Each module keeps its own named subclass (`class BuyError extends CliError {}`) so callers can
// `instanceof` them; `name` is taken from the subclass. Optional `extra` fields are copied on.
export class CliError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = new.target.name;
    if (extra) Object.assign(this, extra);
  }
}

/** Runs `fn`; a `From` error is rethrown as `To` (message kept, optional prefix); anything else passes through. */
export async function rethrowAs(From, To, fn, prefix = '') {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof From) throw new To(prefix + err.message);
    throw err;
  }
}
