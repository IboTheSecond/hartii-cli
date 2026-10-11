import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { createProvider } from '../src/signer.js';

it('keeps real SDK bulk-read batches within the shared RPC ceiling', async () => {
  const batches = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', chunk => { text += chunk; });
    request.on('end', () => {
      const body = JSON.parse(text), jobs = Array.isArray(body) ? body : [body]; batches.push(jobs.length);
      const replies = jobs.map(job => ({ jsonrpc: '2.0', id: job.id, ...(jobs.length > 20
        ? { error: { code: -32000, message: 'Synthetic RPC rejects batches over 20' } }
        : { result: job.method === 'quai_chainId' ? '0x9' : '0x1' }) }));
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const provider = createProvider('http://127.0.0.1:' + server.address().port);
  try {
    const results = await Promise.all(Array.from({ length: 51 }, (_, i) => provider.send('quai_getBalance', ['0x0010000000000000000000000000000000000001', '0x' + i.toString(16)], '0x00')));
    expect(results).toEqual(Array(51).fill('0x1'));
    expect(batches.length).toBeGreaterThan(1); expect(Math.max(...batches)).toBeLessThanOrEqual(20);
  } finally { provider.destroy(); await new Promise(resolve => server.close(resolve)); }
}, 20000);
