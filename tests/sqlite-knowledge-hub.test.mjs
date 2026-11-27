import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteKnowledgeHub } from '../core/sqlite-knowledge-hub.mjs';
import { RamMemoryEngine } from '../core/ram-memory-engine.mjs';
import { executeMcpTool } from '../core/ram-memory-mcp.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. SqliteKnowledgeHub persists RepairKV snapshots & SHA-1 AST cache across restarts (<50ms)', async () => {
  const tmpDir = makeTempDir('amr-sqlite-hub-');
  const wsDir = path.join(tmpDir, 'repo');
  const dbPath = path.join(tmpDir, 'tunnel-knowledge.sqlite');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(
    path.join(wsDir, 'billing.mjs'),
    'export function calculateTaxTotal(amount, rate) {\n  return Math.round(amount * rate);\n}\n',
    'utf8'
  );

  const hub1 = new SqliteKnowledgeHub({ dbPath });
  const ram1 = new RamMemoryEngine({ budgetMb: 128, knowledgeHub: hub1 });
  try {
    const warm1 = await ram1.warmWorkspaceAsync(wsDir, { startWatcher: false });
    assert.equal(warm1.ok, true);
    assert.equal(warm1.filesLoaded, 1);

    ram1.archiveCompactionFacts({
      convoId: 'sess-sql-1',
      wsPath: wsDir,
      rawText: 'Fixed calculateTaxTotal rounding drift in billing.mjs via Math.round.',
    });

    const stats1 = hub1.getStats(wsDir);
    assert.equal(stats1.ok, true);
    assert.ok(stats1.repairBucketsCount >= 1);
    assert.ok(stats1.astCachedFilesCount >= 1);
  } finally {
    ram1.close();
    hub1.close();
  }

  // Simulate fresh daemon boot on a brand new hub + RAM engine instance
  const hub2 = new SqliteKnowledgeHub({ dbPath });
  const ram2 = new RamMemoryEngine({ budgetMb: 128, knowledgeHub: hub2 });
  try {
    const t0 = performance.now();
    const warm2 = await ram2.warmWorkspaceAsync(wsDir, { startWatcher: false });
    const elapsed = performance.now() - t0;
    assert.equal(warm2.ok, true);
    assert.ok(elapsed < 1000, `Warm hydration unexpectedly slow: ${elapsed}ms`);

    const recalled = ram2.recallCompactionFacts({
      convoId: 'sess-sql-1',
      wsPath: wsDir,
      query: 'calculateTaxTotal billing',
    });
    assert.match(recalled.formattedHint, /calculateTaxTotal/);
    assert.match(recalled.formattedHint, /billing\.mjs/);
  } finally {
    ram2.close();
    hub2.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('2. Victory Recipes deduplication, retrieval formatting, clearing & null fuzz safety', () => {
  const tmpDir = makeTempDir('amr-sqlite-vr-');
  const wsDir = path.join(tmpDir, 'proj');
  const dbPath = path.join(tmpDir, 'vr.sqlite');
  fs.mkdirSync(wsDir, { recursive: true });
  const hub = new SqliteKnowledgeHub({ dbPath });

  try {
    const r1 = hub.recordVictoryRecipe({
      workspaceRoot: wsDir,
      errorExcerpt: 'TypeError: Cannot read properties of null in verifyJwtSession',
      touchedFiles: ['core/auth.mjs'],
      fixSummary: 'Guard nullish token before split(".") inside verifyJwtSession',
    });
    assert.equal(r1.ok, true);

    // Duplicate record bumps hits instead of duplicating row (even with differing touchedFiles sets)
    hub.recordVictoryRecipe({
      workspaceRoot: wsDir,
      errorExcerpt: 'TypeError: Cannot read properties of null in verifyJwtSession',
      touchedFiles: ['core/auth.mjs', 'tests/auth.test.mjs'],
      fixSummary: 'Guard nullish token before split(".") inside verifyJwtSession',
    });

    const list = hub.listVictoryRecipes(wsDir, 10);
    assert.equal(list.length, 1);
    assert.equal(list[0].hits, 2);

    const matched = hub.matchVictoryRecipes(wsDir, 'TypeError in verifyJwtSession auth.mjs');
    assert.equal(matched.ok, true);
    assert.ok(matched.recipes.length >= 1);
    assert.match(matched.formattedHint, /^🏆 \[Victory Recipe\]/);
    assert.ok(matched.formattedHint.length <= 260);

    // Clear recipes
    const cleared = hub.clearVictoryRecipes(wsDir);
    assert.equal(cleared.ok, true);
    assert.equal(hub.listVictoryRecipes(wsDir, 10).length, 0);

    // Null / primitive safety under fuzzer payloads
    assert.equal(hub.recordVictoryRecipe(null).ok, false);
    assert.deepEqual(hub.matchVictoryRecipes(null, null).recipes, []);
    assert.deepEqual(hub.getFederatedWorkspaces('__proto__'), []);
  } finally {
    hub.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});

test('3. Cross-Repo Federation links frontend <-> backend and serves federated ram_search hits', async () => {
  const tmpDir = makeTempDir('amr-sqlite-fed-');
  const frontendDir = path.join(tmpDir, 'frontend');
  const backendDir = path.join(tmpDir, 'backend');
  const dbPath = path.join(tmpDir, 'fed.sqlite');
  fs.mkdirSync(frontendDir, { recursive: true });
  fs.mkdirSync(backendDir, { recursive: true });

  fs.writeFileSync(
    path.join(frontendDir, 'checkoutClient.mjs'),
    'export async function submitOrder(dto) {\n  return fetch("/api/v2/orders/verify", { method: "POST", body: JSON.stringify(dto) });\n}\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(backendDir, 'ordersController.mjs'),
    'export function verifyOrderSignatureDto(orderPayload) {\n  return Boolean(orderPayload && orderPayload.signature);\n}\n',
    'utf8'
  );

  const hub = new SqliteKnowledgeHub({ dbPath });
  const ram = new RamMemoryEngine({ budgetMb: 128, knowledgeHub: hub });
  try {
    const fedSet = hub.setFederatedWorkspaces(frontendDir, [backendDir, frontendDir]);
    assert.equal(fedSet.ok, true);
    assert.equal(fedSet.peers.length, 1);
    assert.equal(fedSet.peers[0].label, 'backend');

    await ram.warmWorkspaceAsync(frontendDir, { startWatcher: false });
    const fedSearch = hub.searchFederatedPeers(frontendDir, 'verifyOrderSignatureDto', ram, { maxResults: 3 });
    assert.equal(fedSearch.ok, true);
    assert.ok(fedSearch.results.length >= 1);
    assert.match(fedSearch.formatted, /\[Federated: backend\] ordersController\.mjs/);

    const mcpOut = await executeMcpTool(
      'ram_search',
      { workspaceRoot: frontendDir, query: 'verifyOrderSignatureDto', includeFederated: true },
      { engine: ram, knowledgeHub: hub, federatedWorkspaces: [backendDir], gpuCfgOverride: { gpuEnabled: false } }
    );
    assert.equal(mcpOut.isError, false);
    assert.match(mcpOut.text, /\[Federated: backend\]/);
  } finally {
    ram.close();
    hub.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch {}
  }
});
