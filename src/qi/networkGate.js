// packages/hartii-cli/src/qi/networkGate.js
// Qi sends work on Orchard. Mainnet Qi sends are BETA and only run with BOTH --network mainnet and
// --allow-mainnet-qi (we flip this after a live Orchard run).
import { CliError } from '../errors.js';

export class QiNetworkError extends CliError {}

export const MAINNET_QI_WARNING = 'BETA: Qi sends on mainnet are new and untested with real money. Start with a very small amount you can afford to lose.';

export function assertQiWriteAllowed({ net, flags = {}, globals = {} }) {
  if (net.name === 'orchard') return { beta: false };
  if (flags['allow-mainnet-qi'] !== true) {
    throw new QiNetworkError('Qi sends are Orchard-only for now. Use --network orchard, or to try mainnet at your own risk pass --network mainnet --allow-mainnet-qi.');
  }
  if (globals.network !== 'mainnet') {
    throw new QiNetworkError('To send Qi on mainnet name the network on purpose: --network mainnet --allow-mainnet-qi.');
  }
  return { beta: true, warning: MAINNET_QI_WARNING };
}
