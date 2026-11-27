import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  auditPrefixStability,
  classifyAntigravity429,
  clearExpiredComboCooldowns,
  computeCacheWarmthStatus,
  computeQuotaBurnForecast,
  DEFAULT_COMBO_CHAINS,
  recordComboProviderCooldown,
  recordQuotaTurnSample,
  resolveComboFailoverTarget,
  resolveScoreDrivenComboTarget,
  resolveStatelessTurnEffort,
} from '../core/quota-pacer.mjs';

function makeTmpDir(prefix = 'amr-qp-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {}
}

// --- MUST-HAVE: Caller contracts ---

test('Must-have 1: Pro subscription filters carbon models and falls back safely when customChain becomes empty', () => {
  const tmpDir = makeTmpDir();
  try {
    const deepPro = resolveComboFailoverTarget({
      combo: 'deep_architect',
      subscriptionTier: 'pro',
      cacheDir: tmpDir,
    });
    assert.equal(deepPro.ok, true);
    assert.equal(deepPro.chain.some((m) => m.toLowerCase().includes('carbon')), false);
    assert.equal(deepPro.selected, 'orchestrator_neon');

    const emptyAfterFilter = resolveComboFailoverTarget({
      customChain: ['gemini-4-carbon-high', 'orchestrator_carbon'],
      subscriptionTier: 'pro',
      cacheDir: tmpDir,
    });
    assert.deepEqual(emptyAfterFilter.chain, ['gemini-4-neon-high', 'gemini-4-hydrogen-medium']);
    assert.equal(emptyAfterFilter.selected, 'gemini-4-neon-high');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Must-have 2: Cooldown matches candidates by normalized tier key in resolveComboFailoverTarget', () => {
  const tmpDir = makeTmpDir();
  const nowMs = 1_795_200_000_000;
  try {
    const r1 = recordComboProviderCooldown({ modelOrTier: 'hydrogen', reason: 'quota_429', cacheDir: tmpDir, nowMs });
    const r2 = recordComboProviderCooldown({ modelOrTier: 'neon', reason: 'rpm_429', cacheDir: tmpDir, nowMs });
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);

    const pick = resolveComboFailoverTarget({
      customChain: ['gemini-4-hydrogen-medium', 'gemini-4-neon-medium', 'claude-sonnet-4-6'],
      cacheDir: tmpDir,
      nowMs: nowMs + 1000,
    });
    assert.equal(pick.selected, 'claude-sonnet-4-6');
    assert.deepEqual(
      pick.skippedOnCooldown.map((s) => s.model),
      ['gemini-4-hydrogen-medium', 'gemini-4-neon-medium']
    );
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Must-have 3: computeQuotaBurnForecast elevated status, RU/EN recommendations & empty buffer defaults', () => {
  const nowMs = 1_795_200_000_000;

  // Empty buffer defaults
  const emptyForecast = computeQuotaBurnForecast([], { subscriptionTier: 'pro', nowMs });
  assert.equal(emptyForecast.ok, true);
  assert.equal(emptyForecast.status, 'calm');
  assert.equal(emptyForecast.projectedPct, 0);
  assert.equal(emptyForecast.estimatedMinutesLeft, 300);
  assert.equal(emptyForecast.dominantTier, 'hydrogen');
  assert.match(emptyForecast.recommendationEn, /calm/i);

  // Elevated on Pro: 16 neon samples (weight = 35.2) at 45m ago -> 47% of 75, burnRate 35.2 < 36.1
  const elevatedSamples = Array.from({ length: 16 }, (_, i) => ({
    ts: nowMs - 45 * 60_000 - i * 1000,
    tier: 'neon',
  }));
  const elevatedPro = computeQuotaBurnForecast(elevatedSamples, { subscriptionTier: 'pro', nowMs });
  assert.equal(elevatedPro.status, 'elevated');
  assert.match(elevatedPro.recommendationRu, /Повышенный темп/i);
  assert.match(elevatedPro.recommendationEn, /Elevated burn rate/i);

  // Critical EN recommendation check
  const criticalSamples = Array.from({ length: 14 }, (_, i) => ({
    ts: nowMs - i * 60_000,
    tier: 'carbon',
  }));
  const criticalUltra = computeQuotaBurnForecast(criticalSamples, { subscriptionTier: 'ultra', nowMs });
  assert.equal(criticalUltra.status, 'critical');
  assert.match(criticalUltra.recommendationEn, /High burn rate/i);
});

test('Must-have 4: Russian tier/thinking normalization & EN prefix audit volatile leak (updated:)', () => {
  const tmpDir = makeTmpDir();
  const nowMs = 1_795_200_000_000;
  try {
    recordQuotaTurnSample({
      tier: 'Водород',
      thinkingLevel: 'сверхвысокий',
      convoId: 'ru-1',
      tokens: 300,
      ts: nowMs - 10_000,
      cacheDir: tmpDir,
    });
    recordQuotaTurnSample({
      tier: 'Оркестратор · Карбон',
      thinkingLevel: 'minimal',
      convoId: 'ru-1',
      tokens: 500,
      ts: nowMs - 5_000,
      cacheDir: tmpDir,
    });

    const forecast = computeQuotaBurnForecast(null, { cacheDir: tmpDir, nowMs, subscriptionTier: 'pro' });
    assert.equal(forecast.turnsLast30m, 2);
    // hydrogen*xhigh (1.0*1.32) + orchestrator_carbon*low (1.75*0.78) = 1.32 + 1.365 = 2.685 -> 2.7
    assert.equal(forecast.weight5h, 2.7);

    const leakEn = auditPrefixStability({
      convoId: 'en-pref',
      staticPrefix: 'System rules\nupdated: 1700000000\nend',
      dynamicTail: 'tail',
      lang: 'en',
      cacheDir: tmpDir,
    });
    assert.equal(leakEn.ok, true);
    assert.equal(leakEn.hasVolatileLeak, true);
    assert.equal(leakEn.stable, false);
    assert.match(leakEn.warningEn, /volatile timestamp/i);
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Must-have 5: resolveStatelessTurnEffort explicit override & exact band boundaries', () => {
  const exp = resolveStatelessTurnEffort({
    userChars: 10,
    estimatedContextTokens: 100,
    priorToolResultsCount: 0,
    explicitEffort: 'сверхвысокий',
  });
  assert.deepEqual(exp, { effort: 'xhigh', pinnedStateless: true, source: 'explicit' });

  // Exact upper boundary of trivial band
  assert.equal(
    resolveStatelessTurnEffort({ userChars: 160, estimatedContextTokens: 4000, priorToolResultsCount: 0 }).effort,
    'low'
  );
  // Crossing priorTools >= 1 exits trivial band into balanced medium
  assert.equal(
    resolveStatelessTurnEffort({ userChars: 160, estimatedContextTokens: 4000, priorToolResultsCount: 1 }).effort,
    'medium'
  );
  // Crossing priorTools >= 6 enters heavy band
  assert.equal(
    resolveStatelessTurnEffort({ userChars: 50, estimatedContextTokens: 1000, priorToolResultsCount: 6 }).effort,
    'high'
  );
  // Crossing userChars >= 4000 enters heavy band
  assert.equal(
    resolveStatelessTurnEffort({ userChars: 4000, estimatedContextTokens: 1000, priorToolResultsCount: 0 }).effort,
    'high'
  );
});

test('Must-have 6: computeCacheWarmthStatus cold/cooling/default-fallback & resolveScoreDrivenComboTarget domainScores', () => {
  const tmpDir = makeTmpDir();
  try {
    // Missing file -> cold
    const missing = computeCacheWarmthStatus({ convoId: 'c1', cacheDir: tmpDir });
    assert.equal(missing.status, 'cold');
    assert.equal(missing.remainingSeconds, 0);

    // Seed prefix & verify default fallback + cooling/cold transitions
    const t0 = Date.now();
    auditPrefixStability({ convoId: 'named-chat', staticPrefix: 'Static Head', cacheDir: tmpDir });

    // 4m30s elapsed with 5m TTL -> 30s left -> cooling
    const cooling = computeCacheWarmthStatus({
      convoId: 'default',
      cacheDir: tmpDir,
      nowMs: t0 + 270_000,
      ttlMs: 300_000,
    });
    assert.equal(cooling.status, 'cooling');
    assert.ok(cooling.remainingSeconds > 0 && cooling.remainingSeconds <= 60);

    // ttlMs < 30_000 clamps to 30_000
    const clampedTtl = computeCacheWarmthStatus({
      convoId: 'named-chat',
      cacheDir: tmpDir,
      nowMs: t0 + 10_000,
      ttlMs: 1000,
    });
    assert.equal(clampedTtl.status, 'cooling');
    assert.equal(clampedTtl.remainingSeconds, 20);

    // Expired -> cold
    const expired = computeCacheWarmthStatus({
      convoId: 'named-chat',
      cacheDir: tmpDir,
      nowMs: t0 + 305_000,
      ttlMs: 300_000,
    });
    assert.equal(expired.status, 'cold');
    assert.equal(expired.remainingSeconds, 0);

    // domainScores boost in resolveScoreDrivenComboTarget
    const scored = resolveScoreDrivenComboTarget({
      customChain: ['gemini-4-hydrogen-medium', 'gemini-4-argon-medium'],
      domainScores: { argon: 3.0 },
      cacheDir: tmpDir,
    });
    assert.equal(scored.selected, 'gemini-4-argon-medium');
  } finally {
    cleanupDir(tmpDir);
  }
});

// --- EDGE CASES ---

test('Edge 1: Prototype pollution keys (__proto__, constructor, prototype) are blocked everywhere', () => {
  const tmpDir = makeTmpDir();
  try {
    for (const badKey of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(auditPrefixStability({ convoId: badKey, staticPrefix: 'abc', cacheDir: tmpDir }).ok, false);
      assert.deepEqual(recordComboProviderCooldown({ modelOrTier: badKey, cacheDir: tmpDir }), {
        ok: false,
        error: 'invalid_model_key',
      });
    }

    // Malicious JSON on disk with constructor/prototype keys must be ignored on read
    fs.writeFileSync(
      path.join(tmpDir, 'combo-cooldowns.json'),
      JSON.stringify({
        cooldowns: {
          constructor: { model: 'constructor', until: Date.now() + 60_000 },
          prototype: { model: 'prototype', until: Date.now() + 60_000 },
        },
      }),
      'utf8'
    );
    const pick = resolveComboFailoverTarget({ combo: 'daily_coding', cacheDir: tmpDir });
    assert.equal(pick.activeCooldowns.length, 0);
    assert.equal(({}).polluted, undefined);
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Edge 2: Corrupt JSON files, numeric clamping & future/expired sample filtering', () => {
  const tmpDir = makeTmpDir();
  const nowMs = 1_795_200_000_000;
  try {
    fs.writeFileSync(path.join(tmpDir, 'quota-pacer.json'), '{broken json', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'prefix-stability.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'combo-cooldowns.json'), '{not-valid', 'utf8');

    const fCorrupt = computeQuotaBurnForecast(null, { cacheDir: tmpDir, nowMs });
    assert.equal(fCorrupt.ok, true);
    assert.equal(fCorrupt.turnsLast5h, 0);

    const pCorrupt = auditPrefixStability({ convoId: 'c-corrupt', staticPrefix: 'Head', cacheDir: tmpDir });
    assert.equal(pCorrupt.ok, true);
    assert.equal(pCorrupt.stable, true);

    assert.deepEqual(recordComboProviderCooldown({ modelOrTier: '   ', cacheDir: tmpDir }), {
      ok: false,
      error: 'invalid_model_key',
    });

    const minClamp = recordComboProviderCooldown({ modelOrTier: 'flash', cooldownMs: 10, nowMs, cacheDir: tmpDir });
    assert.equal(minClamp.cooldownMs, 1000);
    const maxClamp = recordComboProviderCooldown({
      modelOrTier: 'neon',
      cooldownMs: 999_999_999,
      nowMs,
      cacheDir: tmpDir,
    });
    assert.equal(maxClamp.cooldownMs, 24 * 60 * 60 * 1000);

    // Negative tokens & out-of-window samples
    const recNeg = recordQuotaTurnSample({ tier: 'hydrogen', tokens: -50, ts: nowMs, cacheDir: tmpDir });
    assert.equal(recNeg.ok, true);

    const filtered = computeQuotaBurnForecast(
      [
        null,
        'bad',
        { ts: nowMs + 120_000, tier: 'carbon' }, // future > 60s -> ignored
        { ts: nowMs - 6 * 60 * 60_000, tier: 'carbon' }, // > 5h old -> ignored
        { ts: nowMs - 1000, tier: 'hydrogen' }, // valid
      ],
      { nowMs, subscriptionTier: 'pro' }
    );
    assert.equal(filtered.turnsLast5h, 1);
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Edge 3: classifyAntigravity429 unknown fallback, Retry-After units, priority & opts.retryAfterMs', () => {
  const unk = classifyAntigravity429('', { lang: 'en' });
  assert.equal(unk.category, 'unknown');
  assert.equal(unk.decision, 'soft_retry');
  assert.equal(unk.cooldownMs, 30_000);
  assert.equal(unk.shouldSwitchModel, false);

  assert.equal(classifyAntigravity429('429 retry-after: 500ms').cooldownMs, 500);
  assert.equal(classifyAntigravity429('429 try again in 2.5 min').cooldownMs, 150_000);
  assert.equal(classifyAntigravity429('429 retry-after: 1h').cooldownMs, 3_600_000);
  // Zero retry-after is ignored -> falls back to default 5m for rate_limited
  assert.equal(classifyAntigravity429('429 retry-after: 0').cooldownMs, 5 * 60 * 1000);
  // Explicit opts.retryAfterMs overrides parsed text
  assert.equal(classifyAntigravity429('429 retry-after: 10s', { retryAfterMs: 42_000 }).cooldownMs, 42_000);

  // Mixed billing + 503 + 429 -> credits_exhausted has highest precedence
  const mixed = classifyAntigravity429('HTTP 429 overloaded billing insufficient credits');
  assert.equal(mixed.category, 'credits_exhausted');
  assert.equal(mixed.shouldSwitchModel, true);
});

test('Edge 4: Unknown combo, empty customChain & allExhausted without local GPU', () => {
  const tmpDir = makeTmpDir();
  const nowMs = 1_795_200_000_000;
  try {
    const unknownCombo = resolveComboFailoverTarget({
      combo: 'non_existent_combo',
      cacheDir: tmpDir,
      nowMs,
    });
    assert.deepEqual(unknownCombo.chain, DEFAULT_COMBO_CHAINS.daily_coding);

    const blankCustomChain = resolveComboFailoverTarget({
      combo: 'daily_coding',
      customChain: ['', null],
      cacheDir: tmpDir,
      nowMs,
    });
    assert.deepEqual(blankCustomChain.chain, ['gemini-4-neon-high', 'gemini-4-hydrogen-medium']);

    recordComboProviderCooldown({ modelOrTier: 'claude-sonnet-4-6', cacheDir: tmpDir, nowMs });
    const exhaustedNoGpu = resolveComboFailoverTarget({
      customChain: ['local_ollama', 'claude-sonnet-4-6'],
      localGpuAvailable: false,
      cacheDir: tmpDir,
      nowMs: nowMs + 100,
    });
    assert.equal(exhaustedNoGpu.allExhausted, true);
    assert.equal(exhaustedNoGpu.localOfflineFallback, '');
    assert.equal(exhaustedNoGpu.selected, 'claude-sonnet-4-6');
  } finally {
    cleanupDir(tmpDir);
  }
});

// --- REGRESSION ---

test('Regression 1: recordQuotaTurnSample prunes >5h samples and caps buffer at 600 entries', () => {
  const tmpDir = makeTmpDir();
  const nowMs = 1_795_200_000_000;
  try {
    const preSamples = [
      { ts: nowMs - 6 * 60 * 60_000, tier: 'carbon', convoId: 'old', tokens: 100 },
      ...Array.from({ length: 610 }, (_, i) => ({
        ts: nowMs - 10_000 + i,
        tier: 'hydrogen',
        convoId: 'burst',
        tokens: 10,
      })),
    ];
    fs.writeFileSync(
      path.join(tmpDir, 'quota-pacer.json'),
      JSON.stringify({ schemaVersion: 2, samples: preSamples }),
      'utf8'
    );

    const res = recordQuotaTurnSample({ tier: 'neon', convoId: 'burst', tokens: 20, ts: nowMs, cacheDir: tmpDir });
    assert.equal(res.ok, true);
    assert.equal(res.samplesCount, 600);

    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'quota-pacer.json'), 'utf8'));
    assert.equal(saved.samples.length, 600);
    assert.equal(saved.samples.some((s) => s.convoId === 'old'), false);
    assert.equal(saved.samples[saved.samples.length - 1].tier, 'neon');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Regression 2: auditPrefixStability evicts >6h stale convos & keeps driftCount when streak recovers', () => {
  const tmpDir = makeTmpDir();
  try {
    const stablePrefix = 'Immutable System Header';
    const hash = createHash('sha1').update(stablePrefix).digest('hex').slice(0, 16);
    const now = Date.now();

    fs.writeFileSync(
      path.join(tmpDir, 'prefix-stability.json'),
      JSON.stringify({
        convos: {
          staleConvo: { hash: 'deadbeef12345678', streakTurns: 5, driftCount: 2, ts: now - 7 * 60 * 60_000 },
          activeConvo: { hash, streakTurns: 1, driftCount: 1, ts: now - 5_000 },
        },
      }),
      'utf8'
    );

    const next = auditPrefixStability({ convoId: 'activeConvo', staticPrefix: stablePrefix, cacheDir: tmpDir });
    assert.equal(next.stable, true);
    assert.equal(next.drifted, false);
    assert.equal(next.streakTurns, 2);
    assert.equal(next.driftCount, 1);

    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'prefix-stability.json'), 'utf8'));
    assert.equal(Object.hasOwn(saved.convos, 'staleConvo'), false);
    assert.equal(Object.hasOwn(saved.convos, 'activeConvo'), true);
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Regression 3: clearExpiredComboCooldowns partial cleanup, missing file & cooldown overwrite', () => {
  const tmpDir = makeTmpDir();
  const nowMs = 1_795_200_000_000;
  try {
    // Missing file
    assert.deepEqual(clearExpiredComboCooldowns({ cacheDir: tmpDir, nowMs }), {
      ok: true,
      activeCooldowns: [],
      clearedCount: 0,
    });

    recordComboProviderCooldown({ modelOrTier: 'flash', reason: 'rpm', cooldownMs: 5_000, nowMs, cacheDir: tmpDir });
    recordComboProviderCooldown({ modelOrTier: 'neon', reason: 'quota_429', cooldownMs: 60_000, nowMs, cacheDir: tmpDir });
    // Overwrite neon with new reason
    recordComboProviderCooldown({ modelOrTier: 'neon', reason: 'billing', cooldownMs: 120_000, nowMs: nowMs + 1000, cacheDir: tmpDir });

    const partial = clearExpiredComboCooldowns({ cacheDir: tmpDir, nowMs: nowMs + 10_000, resetAll: false });
    assert.equal(partial.ok, true);
    assert.equal(partial.clearedCount, 1);
    assert.equal(partial.activeCooldowns.length, 1);
    assert.equal(partial.activeCooldowns[0].model, 'neon');
    assert.equal(partial.activeCooldowns[0].reason, 'billing');
  } finally {
    cleanupDir(tmpDir);
  }
});

test('Regression 4: TUNNEL_CACHE_DIR isolates default cacheDir & sequential burst writes stay valid JSON', () => {
  const tmpDir = makeTmpDir();
  const prevEnv = process.env.TUNNEL_CACHE_DIR;
  process.env.TUNNEL_CACHE_DIR = tmpDir;
  const nowMs = 1_795_200_000_000;
  try {
    for (let i = 0; i < 25; i++) {
      recordQuotaTurnSample({ tier: i % 2 === 0 ? 'hydrogen' : 'neon', convoId: `c-${i}`, tokens: 100 + i, ts: nowMs + i });
    }
    const forecast = computeQuotaBurnForecast(null, { nowMs: nowMs + 1000 });
    assert.equal(forecast.turnsLast5h, 25);
    assert.equal(fs.existsSync(path.join(tmpDir, 'quota-pacer.json')), true);
  } finally {
    if (prevEnv === undefined) delete process.env.TUNNEL_CACHE_DIR;
    else process.env.TUNNEL_CACHE_DIR = prevEnv;
    cleanupDir(tmpDir);
  }
});
