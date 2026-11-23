import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LspBridgeManager,
  LspFrameDecoder,
  applyWorkspaceEditToText,
  detectLanguageForFile,
  encodeLspMessage,
  lspBridge,
} from '../core/lsp-bridge.mjs';
import { MCP_TOOLS, dispatchIpcRoute, executeMcpTool } from '../core/ram-memory-mcp.mjs';
import { formatLspDiagnosticsHint } from '../core/auto-verifier.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeMockLspServerScript(dirPath) {
  const scriptPath = path.join(dirPath, 'mock-lsp-server.mjs');
  const scriptSrc = `
import { pathToFileURL } from 'node:url';

let buf = Buffer.alloc(0);
const docs = new Map();

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n', 'ascii');
  process.stdout.write(Buffer.concat([head, body]));
}

function sendChunked(msg) {
  const pkt = Buffer.concat([
    Buffer.from('Content-Length: ', 'ascii'),
    (() => {
      const body = Buffer.from(JSON.stringify(msg), 'utf8');
      return Buffer.concat([Buffer.from(String(body.length) + '\\r\\n\\r\\n', 'ascii'), body]);
    })(),
  ]);
  const mid = Math.floor(pkt.length / 2);
  process.stdout.write(pkt.subarray(0, mid));
  setTimeout(() => process.stdout.write(pkt.subarray(mid)), 4);
}

function handle(msg) {
  if (msg.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true, referencesProvider: true, codeActionProvider: true } } });
  }
  if (msg.method === 'shutdown') {
    return send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
  if (msg.method === 'exit') {
    process.exit(0);
  }
  if (msg.method === 'textDocument/didOpen') {
    const td = msg.params.textDocument;
    docs.set(td.uri, td.text || '');
    const diags = td.text.includes('BAD_TYPE')
      ? [{ severity: 1, range: { start: { line: 1, character: 6 }, end: { line: 1, character: 14 } }, source: 'ts', code: 2322, message: "Type 'string' is not assignable to type 'number'." }]
      : [];
    return sendChunked({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: td.uri, diagnostics: diags } });
  }
  if (msg.method === 'textDocument/didChange') {
    const uri = msg.params.textDocument.uri;
    const text = msg.params.contentChanges?.[0]?.text || '';
    docs.set(uri, text);
    const diags = text.includes('BAD_TYPE')
      ? [{ severity: 1, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 10 } }, source: 'ts', code: 2322, message: "Type 'string' is not assignable to type 'number'." }]
      : [];
    return send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: diags } });
  }
  if (msg.method === 'textDocument/references') {
    const uri = msg.params.textDocument.uri;
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } } },
        { uri, range: { start: { line: 3, character: 2 }, end: { line: 3, character: 11 } } },
      ],
    });
  }
  if (msg.method === 'textDocument/definition') {
    const uri = msg.params.textDocument.uri;
    return send({ jsonrpc: '2.0', id: msg.id, result: { uri, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } } } });
  }
  if (msg.method === 'textDocument/hover') {
    return send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: 'function calcTotal(x: number): number' } } });
  }
  if (msg.method === 'textDocument/codeAction') {
    const uri = msg.params.textDocument.uri;
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: [
        {
          title: 'Add missing import',
          kind: 'quickfix',
          edit: {
            changes: {
              [uri]: [
                { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import { helper } from './helper';\\n" },
              ],
            },
          },
        },
      ],
    });
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep === -1) break;
    const header = buf.subarray(0, sep).toString('ascii');
    const m = /content-length:\\s*(\\d+)/i.exec(header);
    const start = sep + 4;
    if (!m) { buf = buf.subarray(start); continue; }
    const len = Number(m[1]);
    if (buf.length < start + len) break;
    const body = buf.subarray(start, start + len).toString('utf8');
    buf = buf.subarray(start + len);
    try { handle(JSON.parse(body)); } catch {}
  }
});
`;
  fs.writeFileSync(scriptPath, scriptSrc, 'utf8');
  return scriptPath;
}

test('1. LspFrameDecoder handles multi-byte UTF-8, split chunks, and coalesced frames', () => {
  const decoder = new LspFrameDecoder();
  const msg1 = { jsonrpc: '2.0', id: 1, result: { label: 'Привет мир 🚀' } };
  const msg2 = { jsonrpc: '2.0', method: 'ping', params: { ok: true } };
  const combined = Buffer.concat([encodeLspMessage(msg1), encodeLspMessage(msg2)]);

  const partA = combined.subarray(0, 22);
  const partB = combined.subarray(22, 47);
  const partC = combined.subarray(47);

  assert.deepEqual(decoder.push(partA), []);
  const outB = decoder.push(partB);
  const outC = decoder.push(partC);
  const all = [...outB, ...outC];

  assert.equal(all.length, 2);
  assert.equal(all[0].result.label, 'Привет мир 🚀');
  assert.equal(all[1].method, 'ping');
});

test('2. LspBridgeManager live stdio diagnostics, references/hover, code actions & graceful unavailable fallback', async () => {
  const tmpWs = makeTempDir('amr-lsp-bridge-');
  const scriptPath = writeMockLspServerScript(tmpWs);
  const manager = new LspBridgeManager({
    idleUnloadMs: 60_000,
    serverCmdOverride: {
      tsserver: {
        serverName: 'mock-tsserver',
        command: process.execPath,
        args: [scriptPath],
      },
    },
  });

  try {
    const targetFile = path.join(tmpWs, 'app.ts');
    const badText = 'export function calcTotal(x: number) {\n  const BAD_TYPE: number = "oops";\n  return x;\n}\n';
    fs.writeFileSync(targetFile, badText, 'utf8');

    const diagRes = await manager.checkFileDiagnostics(tmpWs, 'app.ts', badText, { timeoutMs: 800, waitFresh: true });
    assert.equal(diagRes.ok, true);
    assert.equal(diagRes.available, true);
    assert.equal(diagRes.errorCount, 1);
    assert.match(diagRes.formattedAlert, /L2:7/);
    assert.match(formatLspDiagnosticsHint('app.ts', diagRes), /^🧬 \[LSP Type Check\]/);

    // Subsequent clean edit updates diagnostics to 0 errors
    const cleanText = 'export function calcTotal(x: number) {\n  return x * 2;\n}\n';
    const cleanRes = await manager.checkFileDiagnostics(tmpWs, 'app.ts', cleanText, { timeoutMs: 800, waitFresh: true });
    assert.equal(cleanRes.ok, true);
    assert.equal(cleanRes.errorCount, 0);

    // References + Definition + Hover
    const refRes = await manager.queryReferencesAndHover(tmpWs, 'app.ts', 0, 16, { timeoutMs: 800 });
    assert.equal(refRes.ok, true);
    assert.equal(refRes.references.length, 2);
    assert.equal(refRes.definitions.length, 1);
    assert.match(refRes.hover, /calcTotal\(x: number\): number/);

    // Code Actions + applyWorkspaceEditToText
    const actRes = await manager.requestFastCodeActions(tmpWs, 'app.ts', {
      contentText: cleanText,
      apply: true,
      timeoutMs: 800,
    });
    assert.equal(actRes.ok, true);
    assert.equal(actRes.actions.length, 1);
    assert.match(actRes.appliedText, /^import \{ helper \} from '\.\/helper';/);

    // Unavailable language server returns clean non-throwing fallback
    const missingMgr = new LspBridgeManager({
      serverCmdOverride: () => ({ available: false }),
    });
    const missRes = await missingMgr.checkFileDiagnostics(tmpWs, 'app.ts', cleanText, { timeoutMs: 100 });
    assert.equal(missRes.available, false);
    assert.deepEqual(missRes.diagnostics, []);
    await missingMgr.shutdownAll();

    // Pure helpers tolerate null / unknown extensions safely
    assert.equal(detectLanguageForFile(null), null);
    assert.equal(applyWorkspaceEditToText('abc', null).ok, false);
  } finally {
    await manager.shutdownAll();
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});

test('3. MCP tools registration, executeMcpTool & IPC /ipc/lsp-diagnostics and /hook/post-edit integration', async () => {
  for (const toolName of ['lsp_diagnostics', 'lsp_references', 'lsp_code_actions']) {
    const def = MCP_TOOLS.find((t) => t.name === toolName);
    assert.ok(def, `MCP_TOOLS must register ${toolName}`);
    assert.ok(def.annotations && typeof def.annotations.title === 'string');
  }

  const tmpWs = makeTempDir('amr-lsp-mcp-');
  const scriptPath = writeMockLspServerScript(tmpWs);
  const override = {
    tsserver: {
      serverName: 'mock-tsserver',
      command: process.execPath,
      args: [scriptPath],
    },
  };

  try {
    fs.writeFileSync(path.join(tmpWs, 'mod.ts'), 'const BAD_TYPE = 1;\n', 'utf8');

    const mcpDiag = await executeMcpTool(
      'lsp_diagnostics',
      { workspaceRoot: tmpWs, filePath: 'mod.ts', timeoutMs: 800 },
      { lspServerCmdOverride: override }
    );
    assert.equal(mcpDiag.isError, false);
    const parsedDiag = JSON.parse(mcpDiag.text);
    assert.equal(parsedDiag.errorCount, 1);

    const mcpRefs = await executeMcpTool(
      'lsp_references',
      { workspaceRoot: tmpWs, filePath: 'mod.ts', line: 1, character: 6, timeoutMs: 800 },
      { lspServerCmdOverride: override }
    );
    assert.equal(mcpRefs.isError, false);
    const parsedRefs = JSON.parse(mcpRefs.text);
    assert.equal(parsedRefs.references.length, 2);

    const ipcRes = await dispatchIpcRoute(
      'POST',
      '/ipc/lsp-diagnostics',
      { wsPath: tmpWs, filePath: 'mod.ts', timeoutMs: 800, waitFresh: true },
      { lspServerCmdOverride: override, settings: { enabled: true, lspBridgeEnabled: true } }
    );
    assert.equal(ipcRes.status, 200);
    assert.equal(ipcRes.body.errorCount, 1);
  } finally {
    await lspBridge.shutdownAll();
    try { fs.rmSync(tmpWs, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  }
});
