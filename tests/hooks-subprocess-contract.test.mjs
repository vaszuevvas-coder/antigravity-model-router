import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const HOOK_RUNNER_PATH = path.join(ROOT_DIR, 'core', 'hook-runner.mjs');
const HOOKS_JSON_PATH = path.join(ROOT_DIR, 'hooks.json');

function runHookSubprocess(eventName, stdinInput, { cwd = ROOT_DIR, cacheDir, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const startNs = process.hrtime.bigint();
    const env = {
      ...process.env,
      NODE_TEST_CONTEXT: 'subprocess-contract',
      TUNNEL_TEST_ISOLATE_INSTALLED: '1',
      TUNNEL_TEST_STATE_PATH: path.join(cacheDir || os.tmpdir(), `router-state-${process.pid}.json`),
    };
    if (cacheDir) {
      env.TUNNEL_CACHE_DIR = cacheDir;
    }

    const child = spawn(process.execPath, [HOOK_RUNNER_PATH, eventName], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`Hook subprocess ${eventName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      resolve({
        code,
        signal,
        elapsedMs,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    child.stdin.on('error', () => {});
    if (stdinInput !== undefined && stdinInput !== null) {
      child.stdin.write(stdinInput, 'utf8');
    }
    child.stdin.end();
  });
}

function parseStrictSingleJsonStdout(stdout, label = 'hook stdout') {
  const trimmed = stdout.trim();
  assert.ok(trimmed.length > 0, `${label}: stdout must not be empty`);
  const lines = trimmed.split(/\r?\n/);
  assert.equal(
    lines.length,
    1,
    `${label}: expected strictly single-line JSON on stdout without stray logs, got ${lines.length} lines: ${trimmed.slice(0, 300)}`
  );
  assert.equal(trimmed.includes('\uFFFD'), false, `${label}: stdout contains UTF-8 replacement character`);
  const parsed = JSON.parse(lines[0]);
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label}: expected JSON object`);
  return parsed;
}

function makeIsolatedEnvDirs(prefix = 'amr-hook-sub-') {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const wsDir = path.join(tmpRoot, 'Проект_WS');
  const cacheDir = path.join(tmpRoot, 'cache');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'пример.mjs'), 'export const привет = 1;\n', 'utf8');
  return { tmpRoot, wsDir, cacheDir };
}

test('hooks.json defines valid hook-runner commands for all 5 lifecycle events', () => {
  const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf8'));
  const engine = hooksConfig['model-router-engine'];
  assert.ok(engine && typeof engine === 'object');

  for (const eventName of ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']) {
    const entries = engine[eventName];
    assert.ok(Array.isArray(entries) && entries.length > 0, `Missing hooks.json entries for ${eventName}`);
    const flatCommands = entries.flatMap((e) => (Array.isArray(e.hooks) ? e.hooks.map((h) => h.command) : [e.command]));
    assert.ok(
      flatCommands.some((cmd) => cmd === `node ./core/hook-runner.mjs ${eventName}`),
      `Expected command for ${eventName}, got ${JSON.stringify(flatCommands)}`
    );
  }
});

test('UTF-8 Cyrillic prompts and Windows paths round-trip cleanly across all 5 hook events with strict single-JSON stdout', async () => {
  const { tmpRoot, wsDir, cacheDir } = makeIsolatedEnvDirs('amr-hook-utf8-');
  const convoBase = `utf8-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const winCyrillicPath = path.join(wsDir, 'Модуль', 'данные.mjs');
  const cyrillicPrompt = `Проверь маршрут C:\\Пользователи\\Тест\\проект\\Модуль\\данные.mjs и кириллицу: ёжик, щука, №42`;

  try {
    // 1. SessionStart
    const ssRes = await runHookSubprocess(
      'SessionStart',
      JSON.stringify({
        hookEventName: 'SessionStart',
        conversationId: `${convoBase}-ss`,
        workspacePaths: [wsDir],
        lastUserInput: cyrillicPrompt,
      }),
      { cacheDir }
    );
    assert.equal(ssRes.code, 0, `SessionStart stderr: ${ssRes.stderr}`);
    const ssJson = parseStrictSingleJsonStdout(ssRes.stdout, 'SessionStart UTF-8');
    assert.ok(Array.isArray(ssJson.injectSteps), 'SessionStart should return injectSteps');

    // 2. PreInvocation
    const piRes = await runHookSubprocess(
      'PreInvocation',
      JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: `${convoBase}-pi`,
        workspacePaths: [wsDir],
        lastUserInput: cyrillicPrompt,
        modelName: 'Gemini 4 Hydrogen',
      }),
      { cacheDir }
    );
    assert.equal(piRes.code, 0, `PreInvocation stderr: ${piRes.stderr}`);
    const piJson = parseStrictSingleJsonStdout(piRes.stdout, 'PreInvocation UTF-8');
    assert.ok(Array.isArray(piJson.injectSteps), 'PreInvocation should return injectSteps');
    const serializedPi = JSON.stringify(piJson);
    assert.equal(serializedPi.includes('\uFFFD'), false);

    // 3. PreToolUse (clean Cyrillic path allow + Cyrillic .env round-trip)
    const ptuAllowRes = await runHookSubprocess(
      'PreToolUse',
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: `${convoBase}-ptu-ok`,
        workspacePaths: [wsDir],
        toolCall: {
          name: 'read_file',
          args: { Path: winCyrillicPath, StartLine: 1, EndLine: 20 },
        },
      }),
      { cacheDir }
    );
    assert.equal(ptuAllowRes.code, 0, `PreToolUse allow stderr: ${ptuAllowRes.stderr}`);
    const ptuAllowJson = parseStrictSingleJsonStdout(ptuAllowRes.stdout, 'PreToolUse allow UTF-8');
    assert.equal(ptuAllowJson.decision, 'allow');

    const cyrillicEnvPath = path.join(wsDir, 'Модуль', '.env.секрет');
    const ptuRoundTripRes = await runHookSubprocess(
      'PreToolUse',
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: `${convoBase}-ptu-rt`,
        workspacePaths: [wsDir],
        toolCall: {
          name: 'read_file',
          args: { Path: cyrillicEnvPath },
        },
      }),
      { cacheDir }
    );
    assert.equal(ptuRoundTripRes.code, 0, `PreToolUse round-trip stderr: ${ptuRoundTripRes.stderr}`);
    const ptuRoundTripJson = parseStrictSingleJsonStdout(ptuRoundTripRes.stdout, 'PreToolUse round-trip UTF-8');
    assert.equal(ptuRoundTripJson.decision, 'deny');
    assert.ok(
      String(ptuRoundTripJson.reason || '').includes('.env.секрет'),
      `Expected Cyrillic filename to round-trip in reason, got: ${ptuRoundTripJson.reason}`
    );

    // 4. PostToolUse
    const postRes = await runHookSubprocess(
      'PostToolUse',
      JSON.stringify({
        hookEventName: 'PostToolUse',
        conversationId: `${convoBase}-post`,
        workspacePaths: [wsDir],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: `echo ${winCyrillicPath}` },
        },
        output: `Готово: файл ${winCyrillicPath} проверен успешно`,
      }),
      { cacheDir }
    );
    assert.equal(postRes.code, 0, `PostToolUse stderr: ${postRes.stderr}`);
    parseStrictSingleJsonStdout(postRes.stdout, 'PostToolUse UTF-8');

    // 5. Stop
    const stopRes = await runHookSubprocess(
      'Stop',
      JSON.stringify({
        hookEventName: 'Stop',
        conversationId: `${convoBase}-stop`,
        workspacePaths: [wsDir],
        terminationReason: 'END_TURN',
      }),
      { cacheDir }
    );
    assert.equal(stopRes.code, 0, `Stop stderr: ${stopRes.stderr}`);
    parseStrictSingleJsonStdout(stopRes.stdout, 'Stop UTF-8');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Large stdin JSON payload (~1.8 MB) in PostToolUse and PreInvocation completes in < 4500ms with valid JSON stdout', async () => {
  const { tmpRoot, wsDir, cacheDir } = makeIsolatedEnvDirs('amr-hook-large-');
  const convoBase = `large-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const bigChunk = 'INFO [worker] processed C:\\src\\module.mjs line 42 ok\n'.repeat(35000); // ~1.85 MB

  try {
    assert.ok(Buffer.byteLength(bigChunk, 'utf8') >= 1_750_000, 'Payload must be ~1.8 MB');

    const postLarge = await runHookSubprocess(
      'PostToolUse',
      JSON.stringify({
        hookEventName: 'PostToolUse',
        conversationId: `${convoBase}-post`,
        workspacePaths: [wsDir],
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'node --test' },
        },
        output: bigChunk,
      }),
      { cacheDir, timeoutMs: 8000 }
    );
    assert.equal(postLarge.code, 0, `PostToolUse large stderr: ${postLarge.stderr}`);
    assert.ok(
      postLarge.elapsedMs < 4500,
      `Expected PostToolUse ~1.8 MB payload < 4500ms, took ${postLarge.elapsedMs.toFixed(1)}ms`
    );
    parseStrictSingleJsonStdout(postLarge.stdout, 'PostToolUse large');

    const preInvLarge = await runHookSubprocess(
      'PreInvocation',
      JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: `${convoBase}-pi`,
        workspacePaths: [wsDir],
        lastUserInput: 'Проверь вывод команды после запуска тестов',
        toolOutput: bigChunk,
      }),
      { cacheDir, timeoutMs: 8000 }
    );
    assert.equal(preInvLarge.code, 0, `PreInvocation large stderr: ${preInvLarge.stderr}`);
    assert.ok(
      preInvLarge.elapsedMs < 4500,
      `Expected PreInvocation ~1.8 MB payload < 4500ms, took ${preInvLarge.elapsedMs.toFixed(1)}ms`
    );
    const piJson = parseStrictSingleJsonStdout(preInvLarge.stdout, 'PreInvocation large');
    assert.ok(Array.isArray(piJson.injectSteps));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Malformed/truncated JSON on stdin fails open with exit code 0 and valid JSON output', async () => {
  const { tmpRoot, cacheDir } = makeIsolatedEnvDirs('amr-hook-malformed-');

  try {
    for (const eventName of ['PreToolUse', 'PreInvocation', 'PostToolUse', 'SessionStart', 'Stop']) {
      const res = await runHookSubprocess(eventName, '{"broken":', { cacheDir });
      assert.equal(res.code, 0, `${eventName} malformed JSON exited with ${res.code}, stderr: ${res.stderr}`);
      const out = parseStrictSingleJsonStdout(res.stdout, `${eventName} malformed`);
      if (eventName === 'PreToolUse') {
        assert.equal(out.decision, 'allow', 'PreToolUse must fail open on malformed stdin');
      }
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PreToolUse blocks .env access via security-guard and blocks ask_question when swarm_worker role is detected', async () => {
  const { tmpRoot, wsDir, cacheDir } = makeIsolatedEnvDirs('amr-hook-guards-');
  const convoBase = `guards-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    // 1. Block .env read_file and edit_file via security-guard
    const envFilePath = path.join(wsDir, 'секреты', '.env');
    for (const toolName of ['read_file', 'edit_file']) {
      const envRes = await runHookSubprocess(
        'PreToolUse',
        JSON.stringify({
          hookEventName: 'PreToolUse',
          conversationId: `${convoBase}-env-${toolName}`,
          workspacePaths: [wsDir],
          toolCall: {
            name: toolName,
            args: { Path: envFilePath },
          },
        }),
        { cacheDir }
      );
      assert.equal(envRes.code, 0, `PreToolUse .env stderr: ${envRes.stderr}`);
      const envJson = parseStrictSingleJsonStdout(envRes.stdout, `PreToolUse .env (${toolName})`);
      assert.equal(envJson.decision, 'deny');
      assert.match(String(envJson.reason || ''), /Security Guard|\.env/i);
    }

    // 2. Block ask_question when swarm_worker role is detected via transcript worker tools
    const txPath = path.join(tmpRoot, 'worker-transcript.jsonl');
    fs.writeFileSync(
      txPath,
      [
        JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Implement task #3' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'post_message', args: { text: '@coordinator working' } }] }),
      ].join('\n') + '\n',
      'utf8'
    );

    const askRes = await runHookSubprocess(
      'PreToolUse',
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: `${convoBase}-worker-ask`,
        workspacePaths: [wsDir],
        transcriptPath: txPath,
        toolCall: {
          name: 'ask_question',
          args: {
            questions: [
              {
                question: 'Выбрать вариант?',
                options: ['(Recommended) Вариант А', 'Вариант Б'],
              },
            ],
          },
        },
      }),
      { cacheDir }
    );
    assert.equal(askRes.code, 0, `PreToolUse ask_question stderr: ${askRes.stderr}`);
    const askJson = parseStrictSingleJsonStdout(askRes.stdout, 'PreToolUse swarm_worker ask_question');
    assert.equal(askJson.decision, 'deny');
    assert.match(String(askJson.reason || ''), /Swarm Worker Guard|фоновые воркеры/i);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Batch 4 regressions: update_steps allows fast-path, SessionStart/PreInvocation auditPrefixStability writes prefix-stability.json, and $-patterns survive PostToolUse', async () => {
  const { tmpRoot, wsDir, cacheDir } = makeIsolatedEnvDirs('amr-hook-b4-');
  const convoId = `b4-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  try {
    const sampleFile = path.join(wsDir, 'sample.mjs');
    fs.writeFileSync(sampleFile, 'export function greet() { return "old"; }\n', 'utf8');

    const startRes = await runHookSubprocess(
      'SessionStart',
      JSON.stringify({
        hookEventName: 'SessionStart',
        conversationId: convoId,
        workspacePaths: [wsDir],
      }),
      { cacheDir }
    );
    assert.equal(startRes.code, 0, `SessionStart stderr: ${startRes.stderr}`);
    parseStrictSingleJsonStdout(startRes.stdout, 'SessionStart B4');

    const preInvRes = await runHookSubprocess(
      'PreInvocation',
      JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: convoId,
        workspacePaths: [wsDir],
        lastUserInput: 'Исправь sample.mjs и обнови шаги',
      }),
      { cacheDir }
    );
    assert.equal(preInvRes.code, 0, `PreInvocation stderr: ${preInvRes.stderr}`);
    parseStrictSingleJsonStdout(preInvRes.stdout, 'PreInvocation B4');

    const prefixStabilityFile = path.join(cacheDir, 'prefix-stability.json');
    assert.equal(fs.existsSync(prefixStabilityFile), true, 'prefix-stability.json must be written by SessionStart/PreInvocation');
    const prefixJson = JSON.parse(fs.readFileSync(prefixStabilityFile, 'utf8'));
    assert.ok(prefixJson?.convos?.[convoId]?.hash, 'prefix-stability.json must track convoId hash');

    const stepsRes = await runHookSubprocess(
      'PreToolUse',
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: convoId,
        workspacePaths: [wsDir],
        toolCall: {
          name: 'update_steps',
          args: { steps: [{ title: 'Проверить sample.mjs', status: 'in_progress' }] },
        },
      }),
      { cacheDir }
    );
    assert.equal(stepsRes.code, 0, `PreToolUse update_steps stderr: ${stepsRes.stderr}`);
    const stepsJson = parseStrictSingleJsonStdout(stepsRes.stdout, 'PreToolUse update_steps');
    assert.equal(stepsJson.decision, 'allow');

    fs.writeFileSync(sampleFile, 'export function greet() { return "$&$1$$"; }\n', 'utf8');
    const postRes = await runHookSubprocess(
      'PostToolUse',
      JSON.stringify({
        hookEventName: 'PostToolUse',
        conversationId: convoId,
        workspacePaths: [wsDir],
        toolCall: {
          name: 'edit_file',
          args: {
            Path: sampleFile,
            Target: 'return "old";',
            Replacement: 'return "$&$1$$";',
          },
        },
      }),
      { cacheDir }
    );
    assert.equal(postRes.code, 0, `PostToolUse $-pattern stderr: ${postRes.stderr}`);
    parseStrictSingleJsonStdout(postRes.stdout, 'PostToolUse $-pattern');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PreToolUse burst concurrency (6 parallel hooks) and broken/zombie .lock recovery complete fast with exit 0', async () => {
  const { tmpRoot, wsDir, cacheDir } = makeIsolatedEnvDirs('amr-hook-locks-');

  try {
    // 1. Concurrent burst of 6 parallel PreToolUse subprocesses sharing one cacheDir
    const burstPayloads = [1, 2, 3, 4].map((i) => {
      const f = path.join(wsDir, `burst-${i}.mjs`);
      fs.writeFileSync(f, `export const v${i} = ${i};\n`, 'utf8');
      return JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'burst-convo',
        workspacePaths: [wsDir],
        toolCall: { name: 'read_file', args: { Path: f, StartLine: 1, EndLine: 5 } },
      });
    });
    burstPayloads.push(
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'burst-convo',
        workspacePaths: [wsDir],
        toolCall: { name: 'run_command', args: { CommandLine: 'git status -sb' } },
      }),
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'burst-convo',
        workspacePaths: [wsDir],
        toolCall: {
          name: 'update_steps',
          args: { steps: [{ title: 'Check burst', status: 'in_progress' }] },
        },
      })
    );

    const tBurstStart = performance.now();
    const burstResults = await Promise.all(
      burstPayloads.map((p) => runHookSubprocess('PreToolUse', p, { cacheDir, timeoutMs: 8000 }))
    );
    const burstWallMs = performance.now() - tBurstStart;
    for (let i = 0; i < burstResults.length; i++) {
      const r = burstResults[i];
      assert.equal(r.code, 0, `Burst item #${i} exited with ${r.code}, stderr: ${r.stderr}`);
      const json = parseStrictSingleJsonStdout(r.stdout, `Burst item #${i}`);
      assert.ok(json.decision === 'allow' || json.decision === 'deny');
    }
    assert.ok(burstWallMs < 4500, `6 concurrent PreToolUse hooks took too long: ${burstWallMs.toFixed(1)}ms`);
    const leftoverLocks = fs.readdirSync(cacheDir).filter((n) => /\.lock(?:\.fb)?(?:\.stale\..*)?$/.test(n));
    assert.deepEqual(leftoverLocks, [], `Leftover lock artifacts after burst: ${leftoverLocks.join(', ')}`);

    const tpLock = path.join(cacheDir, 'task-progress.json.lock');
    const makeReadPayload = (tag) => {
      const f = path.join(wsDir, `lock-${tag}.mjs`);
      fs.writeFileSync(f, `export const tag = "${tag}";\n`, 'utf8');
      return JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: `lock-${tag}`,
        workspacePaths: [wsDir],
        toolCall: { name: 'read_file', args: { Path: f, StartLine: 1, EndLine: 5 } },
      });
    };

    // 2a. Corrupt regular file at .lock path
    fs.writeFileSync(tpLock, 'corrupt-lock-file', 'utf8');
    const corruptRes = await runHookSubprocess('PreToolUse', makeReadPayload('corrupt'), { cacheDir, timeoutMs: 5000 });
    assert.equal(corruptRes.code, 0, corruptRes.stderr);
    assert.equal(parseStrictSingleJsonStdout(corruptRes.stdout, 'corrupt .lock').decision, 'allow');
    assert.ok(corruptRes.elapsedMs < 2000, `Corrupt .lock recovery took ${corruptRes.elapsedMs.toFixed(1)}ms`);
    assert.equal(fs.existsSync(tpLock), false, 'Corrupt .lock file should be evicted');

    // 2b. Orphaned .lock directory with missing owner file (backdated 600ms)
    fs.mkdirSync(tpLock, { recursive: true });
    const back600 = new Date(Date.now() - 600);
    fs.utimesSync(tpLock, back600, back600);
    const orphanRes = await runHookSubprocess('PreToolUse', makeReadPayload('orphan'), { cacheDir, timeoutMs: 5000 });
    assert.equal(orphanRes.code, 0, orphanRes.stderr);
    assert.equal(parseStrictSingleJsonStdout(orphanRes.stdout, 'orphan .lock').decision, 'allow');
    assert.ok(orphanRes.elapsedMs < 2000, `Orphan .lock eviction took ${orphanRes.elapsedMs.toFixed(1)}ms`);
    assert.equal(fs.existsSync(tpLock), false, 'Orphan .lock dir should be evicted');

    // 2c. Unrenameable stale .lock directory (open owner handle on Windows forces fallback to .lock.fb)
    fs.mkdirSync(tpLock, { recursive: true });
    const ownerPath = path.join(tpLock, 'owner');
    fs.writeFileSync(ownerPath, '999999:1:dead', 'utf8');
    const back15s = new Date(Date.now() - 15_000);
    fs.utimesSync(tpLock, back15s, back15s);
    const heldFd = fs.openSync(ownerPath, 'r');
    try {
      const zombieRes = await runHookSubprocess('PreToolUse', makeReadPayload('zombie'), { cacheDir, timeoutMs: 5000 });
      assert.equal(zombieRes.code, 0, zombieRes.stderr);
      assert.equal(parseStrictSingleJsonStdout(zombieRes.stdout, 'zombie .lock').decision, 'allow');
      assert.ok(zombieRes.elapsedMs < 2500, `Zombie .lock fallback took ${zombieRes.elapsedMs.toFixed(1)}ms`);
      assert.equal(fs.existsSync(path.join(cacheDir, 'task-progress.json')), true, 'task-progress.json must still update via fallback');
    } finally {
      try { fs.closeSync(heldFd); } catch {}
      fs.rmSync(tpLock, { recursive: true, force: true });
    }

    // 2d. Live-PID-held .lock respects bounded maxWaitMs (never hangs >= 5000ms)
    fs.mkdirSync(tpLock, { recursive: true });
    fs.writeFileSync(path.join(tpLock, 'owner'), `${process.pid}:${Date.now()}:alive`, 'utf8');
    try {
      const busyRes = await runHookSubprocess('PreToolUse', makeReadPayload('busy'), { cacheDir, timeoutMs: 5000 });
      assert.equal(busyRes.code, 0, busyRes.stderr);
      assert.equal(parseStrictSingleJsonStdout(busyRes.stdout, 'live-PID .lock').decision, 'allow');
      assert.ok(busyRes.elapsedMs < 2500, `Bounded PreToolUse under live lock took ${busyRes.elapsedMs.toFixed(1)}ms`);
    } finally {
      fs.rmSync(tpLock, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
