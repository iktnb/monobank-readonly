import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const configured = process.argv.includes('--registered')
  ? JSON.parse(execFileSync('codex.exe', ['mcp', 'get', 'monobank-readonly', '--json'], { encoding: 'utf8', windowsHide: true }))
  : null;
if (configured) {
  assert.equal(configured.enabled, true);
  assert.equal(configured.transport.type, 'stdio');
  assert.equal(configured.transport.env, null);
}
const transport = new StdioClientTransport({
  command: configured?.transport.command ?? process.execPath,
  args: configured?.transport.args ?? [fileURLToPath(new URL('./server.mjs', import.meta.url))],
  env: { ...process.env }, stderr: 'pipe'
});
const client = new Client({ name: 'monobank-local-verification', version: '1.0.0' });
let stderr = '';
try {
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(t => t.name).sort(), ['monobank_accounts', 'monobank_statement', 'monobank_status']);
  assert.ok(list.tools.every(t => t.annotations.readOnlyHint === true));
  const status = await client.callTool({ name: 'monobank_status', arguments: {} });
  const parsed = JSON.parse(status.content[0].text);
  assert.equal(parsed.mode, 'read-only');
  // This smoke test intentionally never fetches real bank data.
  if (!parsed.tokenSaved) {
    const missing = await client.callTool({ name: 'monobank_accounts', arguments: {} });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).code, 'TOKEN_MISSING');
  }
  assert.equal(stderr, '');
  console.log(JSON.stringify({ protocol: 'PASS', registeredConfiguration: Boolean(configured), tools: list.tools.map(t => t.name), tokenSaved: parsed.tokenSaved, bankContacted: false }));
} finally { await client.close(); }
