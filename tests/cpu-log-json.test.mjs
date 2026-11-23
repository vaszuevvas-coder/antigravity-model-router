import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compressLogsDrain3, crushStructuredPayload } from '../core/cpu-log-json-compressor.mjs';
import {
  compressLogsDrain3 as reexportedDrain3,
  crushStructuredPayload as reexportedCrusher,
  maskTerminalOutput,
  maskTerminalOutputSmart,
} from '../core/obs-masker.mjs';

test('1. Drain3 Log Clustering: 500-line flood + 1 buried AssertionError (>80% reduction, fault & unique lines kept, <15ms)', () => {
  const lines = [];
  for (let i = 0; i < 250; i++) {
    const ts = `2026-11-17T17:22:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
    const uuid = `f7b9b1cf-8e7e-48d6-871c-${String(100000000000 + i)}`;
    const ip = `10.0.${i % 8}.${(i % 200) + 1}:8080`;
    const dur = `${10 + (i % 90)}ms`;
    const mem = `${128 + (i % 64)}MB`;
    lines.push(`${ts} INFO req=${uuid} src=${ip} path=C:\\work\\app\\handler.mjs took=${dur} mem=${mem} rate=99.5%`);
  }
  const uniqueLine = '2026-11-17T17:25:00.000Z NOTICE schema migration v2 checkpoint reached';
  lines.push(uniqueLine);
  const buriedFault = 'AssertionError [ERR_ASSERTION]: Expected status 200 but received 500 at core/api.mjs:142';
  lines.push(buriedFault);
  for (let i = 250; i < 500; i++) {
    const ts = `2026-11-17T17:26:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`;
    const hex = `deadbeef${String(i).padStart(4, '0')}`;
    const ip = `10.1.${i % 8}.${(i % 200) + 1}:9090`;
    const dur = `${15 + (i % 40)}ms`;
    const mem = `${140 + (i % 32)}MB`;
    lines.push(`${ts} INFO req=${hex} src=${ip} path=/var/log/app/worker.log took=${dur} mem=${mem} rate=98.2%`);
  }

  const rawText = lines.join('\n');
  const res = compressLogsDrain3(rawText);

  assert.equal(res.wasCompressed, true);
  assert.equal(res.originalLines, 502);
  assert.ok(res.collapsedCount >= 1);
  assert.ok(res.clusterCount >= 2);
  assert.ok(res.outputLines <= 10, `expected <= 10 output lines, got ${res.outputLines}`);

  const reduction = res.savedChars / res.originalChars;
  assert.ok(reduction > 0.8, `expected >80% reduction, got ${(reduction * 100).toFixed(1)}%`);
  assert.ok(res.elapsedMs < 15, `expected <15ms latency, got ${res.elapsedMs}ms`);

  assert.match(res.compressed, /\[×500\]/);
  assert.match(res.compressed, /\(template: <\*>/);
  assert.ok(res.compressed.includes(uniqueLine), 'unique line must be preserved verbatim');
  assert.ok(res.compressed.includes(buriedFault), 'buried AssertionError must be preserved verbatim');

  const faultIdx = res.compressed.indexOf(buriedFault);
  const uniqueIdx = res.compressed.indexOf(uniqueLine);
  const clusterIdx = res.compressed.indexOf('[×500]');
  assert.ok(clusterIdx < uniqueIdx && uniqueIdx < faultIdx, 'chronological order must be preserved');
});

test('2. Drain3 Secret Redaction & Multi-Cluster Separation', () => {
  const fakeSkProj = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
  const lines = [];
  for (let i = 0; i < 30; i++) {
    lines.push(`2026-11-17T10:00:00Z INFO auth ok token=${fakeSkProj} user=${i} latency=${i}ms`);
    lines.push(`2026-11-17T10:00:01Z WARN cache miss key=item_${i} size=${i * 2}kb`);
  }
  const res = compressLogsDrain3(lines.join('\n'));
  assert.equal(res.wasCompressed, true);
  assert.equal(res.collapsedCount, 2);
  assert.equal(res.compressed.includes(fakeSkProj), false);
  assert.match(res.compressed, /\[REDACTED_SECRET\]/);
});

test('3. Headroom Smart Crusher: 100-item JSON array + 2 failed items (>70% reduction, anomalies kept, <15ms)', () => {
  const items = [];
  for (let i = 0; i < 98; i++) {
    items.push({
      id: i + 1,
      service: `worker-${i % 5}`,
      status: 'ok',
      ok: true,
      durationMs: 12 + (i % 20),
      region: 'eu-central-1',
    });
  }
  items.splice(33, 0, {
    id: 999,
    service: 'worker-auth',
    status: 'failed',
    ok: false,
    durationMs: 5001,
    region: 'eu-central-1',
    error: 'Upstream timeout after 5000ms',
  });
  items.splice(77, 0, {
    id: 1000,
    service: 'worker-db',
    status: 'error',
    ok: false,
    durationMs: 310,
    region: 'eu-central-1',
    issues: ['ECONNREFUSED 127.0.0.1:5432'],
  });

  const rawJson = JSON.stringify(items, null, 2);
  const res = crushStructuredPayload(rawJson);

  assert.equal(res.wasCrushed, true);
  assert.equal(res.format, 'json');
  assert.equal(res.anomaliesKept, 2);

  const reduction = res.savedChars / res.originalChars;
  assert.ok(reduction > 0.7, `expected >70% reduction, got ${(reduction * 100).toFixed(1)}%`);
  assert.ok(res.elapsedMs < 15, `expected <15ms latency, got ${res.elapsedMs}ms`);

  assert.match(res.crushed, /^#schema: \[/);
  assert.match(res.crushed, /\.\.\. \+96 homogeneous items omitted/);
  assert.ok(res.crushed.includes('Upstream timeout after 5000ms'));
  assert.ok(res.crushed.includes('ECONNREFUSED 127.0.0.1:5432'));
});

test('4. Headroom Smart Crusher: JSONL stream, large object null/empty pruning & primitive array summary', () => {
  const jsonlLines = [];
  for (let i = 0; i < 60; i++) {
    jsonlLines.push(JSON.stringify({ seq: i, file: `src/mod_${i}.mjs`, valid: true, brokenImports: [] }));
  }
  jsonlLines.push(JSON.stringify({ seq: 60, file: 'src/broken.mjs', valid: false, brokenImports: ['./missing.mjs'] }));
  const jsonlRes = crushStructuredPayload(jsonlLines.join('\n'));

  assert.equal(jsonlRes.wasCrushed, true);
  assert.equal(jsonlRes.format, 'jsonl');
  assert.equal(jsonlRes.anomaliesKept, 1);
  assert.match(jsonlRes.crushed, /#schema:/);
  assert.ok(jsonlRes.crushed.includes('./missing.mjs'));

  const largeObj = {
    meta: { project: 'router', emptyStr: '', nullable: null, emptyArr: [] },
    padding: 'x'.repeat(1300),
    nullA: null,
    emptyB: '',
    emptyC: [],
    ids: Array.from({ length: 50 }, (_, i) => `item-${i}`),
  };
  const objRes = crushStructuredPayload(JSON.stringify(largeObj, null, 2));
  assert.equal(objRes.wasCrushed, true);
  assert.equal(objRes.format, 'json');
  const parsedCrushed = JSON.parse(objRes.crushed);
  assert.equal('nullA' in parsedCrushed, false);
  assert.equal('emptyB' in parsedCrushed, false);
  assert.equal('emptyC' in parsedCrushed, false);
  assert.equal('nullable' in parsedCrushed.meta, false);
  assert.ok(parsedCrushed.ids.some((x) => typeof x === 'string' && x.includes('primitive items omitted')));
});

test('5. obs-masker Integration: re-exports, contracts preserved, Drain3/Crusher pre-slicing & Smart GPU skip', async () => {
  assert.equal(typeof reexportedDrain3, 'function');
  assert.equal(typeof reexportedCrusher, 'function');

  // Contract 1: options.enabled === false passthrough
  const disabledRes = maskTerminalOutput('line1\nline2', 0, { enabled: false });
  assert.equal(disabledRes.masked, 'line1\nline2');
  assert.equal(disabledRes.cpuCompressed, false);

  // Contract 2: exitCode === 0 && originalLines <= 12 verbatim + AUTH redaction
  const fakeSk = ['sk', '1234567890abcdefghijklmnop'].join('-');
  const authRes = maskTerminalOutput(`AUTH ${fakeSk} done`, 0);
  assert.equal(authRes.masked.includes(fakeSk), false);
  assert.match(authRes.masked, /^AUTH \[REDACTED_SECRET\] done$/);
  assert.equal(authRes.cpuCompressed, false);

  // Contract 3: 500-line error flood + Error: TestAssertionFailed collapses into [xN] and preserves fault
  const floodLines = [];
  for (let i = 0; i < 400; i++) {
    floodLines.push(`2026-11-17T12:00:${String(i % 60).padStart(2, '0')}Z DEBUG step=${i} elapsed=${i}ms ok`);
  }
  floodLines.splice(200, 0, 'Error: TestAssertionFailed at core/demo.mjs:42');
  const floodRaw = floodLines.join('\n');

  const maskedErr = maskTerminalOutput(floodRaw, 1);
  assert.equal(maskedErr.cpuCompressed, true);
  assert.match(maskedErr.masked, /^\[✗ OBS-MASK\] Exit 1:/);
  assert.match(maskedErr.masked, /\[×400\]/);
  assert.match(maskedErr.masked, /Error: TestAssertionFailed at core\/demo\.mjs:42/);
  assert.ok(maskedErr.maskedChars <= 1150, `expected maskedChars <= 1150, got ${maskedErr.maskedChars}`);
  assert.ok(maskedErr.savedChars >= maskedErr.originalChars * 0.45);

  // Contract 4: maskTerminalOutputSmart skips Ollama immediately when CPU compression already achieved target
  const t0 = performance.now();
  const smartFlood = await maskTerminalOutputSmart(floodRaw, 1);
  const smartMs = performance.now() - t0;
  assert.equal(smartFlood.cpuCompressed, true);
  assert.equal(smartFlood.gpuDistilled, false);
  assert.match(smartFlood.masked, /Error: TestAssertionFailed/);
  assert.ok(smartMs < 20, `expected fast CPU skip (<20ms), got ${smartMs.toFixed(2)}ms`);

  // Contract 5: exitCode === 0 with 100-item JSON payload triggers Smart Crusher + [✓ OBS-MASK] OK
  const jsonPayload = JSON.stringify(
    Array.from({ length: 100 }, (_, i) => (
      i === 50
        ? { id: i, ok: false, status: 'failed', error: 'ValidationError' }
        : { id: i, ok: true, status: 'ok', ms: 10 + (i % 5) }
    ))
  );
  const smartJson = await maskTerminalOutputSmart(jsonPayload, 0);
  assert.equal(smartJson.cpuCompressed, true);
  assert.equal(smartJson.gpuDistilled, false);
  assert.match(smartJson.masked, /^\[✓ OBS-MASK\] OK/);
  assert.match(smartJson.masked, /#schema:/);
  assert.ok(smartJson.masked.includes('ValidationError'));
});
