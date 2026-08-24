#!/usr/bin/env node
'use strict';
const MARKER = process.env.E2E_MCP_MARKER || 'HELLO_E2E_MCP';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      respond(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'e2e-mcp', version: '1.0.0' },
      });
    } else if (msg.method === 'notifications/initialized') {
      // no response needed for notifications
    } else if (msg.method === 'tools/list') {
      respond(msg.id, {
        tools: [{
          name: 'hello_e2e',
          description: 'Returns e2e marker string for verification',
          inputSchema: { type: 'object', properties: {} },
        }],
      });
    } else if (msg.method === 'tools/call') {
      respond(msg.id, { content: [{ type: 'text', text: MARKER }] });
    }
  }
});
function respond(id, result) {
  if (id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
}
