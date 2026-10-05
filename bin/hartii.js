#!/usr/bin/env node
// packages/hartii-cli/bin/hartii.js
//
// Real process entry point — kept to "parse real argv, call main(), set a real exit code" so
// everything else in this package is testable without ever spawning a process. `hartii` (no
// args, TTY) opens the full-screen UI; piped, it prints the help text (see src/router.js).
import { main } from '../src/cli.js';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Unexpected error: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
