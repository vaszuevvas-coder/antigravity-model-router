#!/usr/bin/env node
/**
 * @file render-promo-video.mjs
 * @description Generates:
 *   1. Self-contained Interactive Video Showcase (`docs/demo/index.html`) with Web Audio API sound FX,
 *      chapter navigation, live Project Map lens switcher, and EN + «RU» bilingual overlays.
 *   2. Frame-deterministic 30.00s 1920x1080 30fps MP4 (`docs/media/the-tunnel-demo-v4.0.6.mp4`) with
 *      procedural stereo cyber-industrial bed + 26 frame-locked SFX cues normalized to -16 LUFS.
 *   3. Crisp Hero Showcase GIF (`docs/media/hero-showcase.gif`) for GitHub README.md.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeWavBufferAcousticMetrics,
  synthesizeProceduralWavBuffer,
} from '../skills/programmatic-video-studio/scripts/compose-video-sfx.mjs';
import { lintVideoCompositionContent } from '../skills/programmatic-video-studio/scripts/lint-video-composition.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const MEDIA_DIR = path.join(ROOT_DIR, 'docs', 'media');
const DEMO_DIR = path.join(ROOT_DIR, 'docs', 'demo');

const DURATION_SEC = 30.0;
const FPS = 30;
const TOTAL_FRAMES = Math.round(DURATION_SEC * FPS);
const SAMPLE_RATE = 48000;

export const VIDEO_SFX_CUES = [
  { timeSec: 0.12, kind: 'riser', gain: 0.45, label: 'grid_ignite' },
  { timeSec: 0.85, kind: 'hit', gain: 0.82, label: 'diamond_lock' },
  { timeSec: 1.75, kind: 'pop', gain: 0.55, label: 'metrics_reveal' },
  { timeSec: 4.20, kind: 'whoosh', gain: 0.72, label: 'scene_tensor' },
  { timeSec: 5.05, kind: 'click', gain: 0.50, label: 'axis_scan' },
  { timeSec: 6.20, kind: 'pop', gain: 0.58, label: 'lane_hydrogen' },
  { timeSec: 7.25, kind: 'chime', gain: 0.62, label: 'lane_orchestrator' },
  { timeSec: 8.35, kind: 'success', gain: 0.58, label: 'lane_swarm' },
  { timeSec: 9.50, kind: 'whoosh', gain: 0.72, label: 'scene_cockpit' },
  { timeSec: 10.20, kind: 'click', gain: 0.52, label: 'composer_click' },
  { timeSec: 11.40, kind: 'pop', gain: 0.56, label: 'tab_behavior' },
  { timeSec: 12.80, kind: 'pop', gain: 0.56, label: 'tab_hardware' },
  { timeSec: 14.15, kind: 'chime', gain: 0.55, label: 'tab_guard' },
  { timeSec: 15.10, kind: 'click', gain: 0.50, label: 'lang_ru_switch' },
  { timeSec: 15.65, kind: 'riser', gain: 0.55, label: 'map_riser' },
  { timeSec: 16.05, kind: 'hit', gain: 0.85, label: 'scene_project_map' },
  { timeSec: 17.50, kind: 'click', gain: 0.54, label: 'map_zoom_hub' },
  { timeSec: 19.10, kind: 'hit', gain: 0.78, label: 'map_blast_wave' },
  { timeSec: 20.60, kind: 'pop', gain: 0.60, label: 'map_context_cart' },
  { timeSec: 21.65, kind: 'click', gain: 0.52, label: 'map_hotspots' },
  { timeSec: 22.85, kind: 'chime', gain: 0.62, label: 'map_ast_zoom' },
  { timeSec: 24.00, kind: 'whoosh', gain: 0.70, label: 'scene_local_stack' },
  { timeSec: 24.90, kind: 'pop', gain: 0.58, label: 'ram_metric' },
  { timeSec: 25.85, kind: 'pop', gain: 0.58, label: 'gpu_metric' },
  { timeSec: 26.65, kind: 'success', gain: 0.65, label: 'guardrails_ok' },
  { timeSec: 27.40, kind: 'hit', gain: 0.85, label: 'outro_lockup' },
  { timeSec: 28.15, kind: 'chime', gain: 0.68, label: 'outro_chord' },
];

function findBrowserExecutable() {
  const envOverride = process.env.CDP_BROWSER_PATH || process.env.CHROME_PATH || process.env.EDGE_PATH;
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = process.platform === 'win32'
    ? [
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function killBrowser(proc) {
  if (!proc) return;
  try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
  if (process.platform === 'win32' && proc.pid) {
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 }); } catch {}
  }
}

async function launchCdp(browserExe, userDataDir) {
  const proc = spawn(browserExe, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--window-size=1920,1080',
    '--force-color-profile=srgb',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const { cdpPort } = await new Promise((resolveUrl, rejectUrl) => {
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rejectUrl(new Error('CDP timeout')); } }, 15000);
    const onData = (chunk) => {
      if (settled) return;
      logs += chunk.toString('utf8');
      const m = logs.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/[^\s\r\n]+)/i);
      if (m) { settled = true; clearTimeout(timer); resolveUrl({ cdpPort: Number(m[2]) }); }
    };
    proc.stderr?.on('data', onData);
    proc.stdout?.on('data', onData);
  });

  let pageWsUrl = null;
  const dl = Date.now() + 8000;
  while (Date.now() < dl && !pageWsUrl) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const list = await res.json();
      pageWsUrl = list.find((x) => x?.type === 'page' && x?.webSocketDebuggerUrl)?.webSocketDebuggerUrl || null;
    } catch {}
    if (!pageWsUrl) await new Promise((r) => setTimeout(r, 80));
  }

  const ws = new WebSocket(pageWsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const waiters = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const w of [...waiters]) {
        if (w.method === msg.method) {
          waiters.delete(w);
          clearTimeout(w.timer);
          w.resolve(msg.params);
        }
      }
    }
  });

  const send = (method, params = {}, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const waitForEvent = (method, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const w = { method, resolve, timer: null };
    w.timer = setTimeout(() => { waiters.delete(w); reject(new Error(`Event timeout: ${method}`)); }, timeoutMs);
    waiters.add(w);
  });

  return {
    send,
    waitForEvent,
    close() {
      try { ws.close(); } catch {}
      killBrowser(proc);
    },
  };
}

function decodeMonoWavSamples(wavBuf) {
  let pos = 12;
  let dataOffset = 44;
  let dataLength = wavBuf.length - 44;
  while (pos + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', pos, pos + 4);
    const sz = wavBuf.readUInt32LE(pos + 4);
    if (id === 'data') {
      dataOffset = pos + 8;
      dataLength = Math.min(sz, wavBuf.length - dataOffset);
      break;
    }
    pos += 8 + sz + (sz % 2);
  }
  const count = Math.floor(dataLength / 2);
  const arr = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    arr[i] = wavBuf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return arr;
}

function encodeStereoPcm16Wav(left, right, sampleRate = SAMPLE_RATE) {
  const n = Math.min(left.length, right.length);
  const dataBytes = n * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < n; i++) {
    const l = Math.max(-0.98, Math.min(0.98, left[i]));
    const r = Math.max(-0.98, Math.min(0.98, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(r * 32767), 44 + i * 4 + 2);
  }
  return buf;
}

/**
 * Generates a studio-clean 30.00s stereo cyber-industrial soundtrack:
 * subtle 108 BPM D-minor sidechained analog pulse + atmospheric fifth pad + 26 frame-locked SFX cues.
 */
function buildStudioSoundtrackWav(outWavPath) {
  const totalSamples = Math.round(DURATION_SEC * SAMPLE_RATE);
  const left = new Float64Array(totalSamples);
  const right = new Float64Array(totalSamples);

  const bpm = 108;
  const beatDur = 60 / bpm;
  const chordRoots = [73.42, 73.42, 87.31, 65.41, 73.42, 55.0]; // D2, D2, F2, C2, D2, A1
  let prng = 0x51a7c3d1;
  const nextRand = () => {
    prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
    return prng / 4294967296;
  };

  let bassPhase = 0;
  let padPhaseA = 0;
  let padPhaseB = 0;
  let padPhaseC = 0;
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const masterEnv =
      Math.min(1, t / 0.45) *
      (t > DURATION_SEC - 1.1 ? Math.max(0, (DURATION_SEC - t) / 1.1) : 1);

    const beatPos = (t % beatDur) / beatDur;
    const stepPos = (t % (beatDur / 4)) / (beatDur / 4);
    const sectionIdx = Math.min(chordRoots.length - 1, Math.floor(t / 5.0));
    const rootHz = chordRoots[sectionIdx];
    const intensity = t >= 15.2 && t < 23.0 ? 1.22 : (t >= 27.2 ? 0.72 : 1.0);

    // Warm sub-bass pulse with clean sidechain envelope
    const sidechain = Math.min(1, 0.25 + beatPos * 1.4);
    bassPhase += (2 * Math.PI * rootHz) / SAMPLE_RATE;
    const subBass = (Math.sin(bassPhase) * 0.72 + Math.sin(bassPhase * 2) * 0.16) * 0.14 * sidechain * intensity;

    // Wide stereo fifth + minor-9th atmospheric pad
    padPhaseA += (2 * Math.PI * (rootHz * 2.0)) / SAMPLE_RATE;
    padPhaseB += (2 * Math.PI * (rootHz * 3.0)) / SAMPLE_RATE;
    padPhaseC += (2 * Math.PI * (rootHz * 4.495)) / SAMPLE_RATE;
    const padL = (Math.sin(padPhaseA) * 0.45 + Math.sin(padPhaseB + 0.4) * 0.35 + Math.sin(padPhaseC) * 0.2) * 0.068 * sidechain;
    const padR = (Math.sin(padPhaseA + 0.25) * 0.45 + Math.sin(padPhaseB - 0.35) * 0.35 + Math.sin(padPhaseC + 0.8) * 0.2) * 0.068 * sidechain;

    // Crisp mechanical 16th-note clock tick (subtle hardware telemetry rhythm)
    const tickEnv = stepPos < 0.06 ? Math.exp(-stepPos * 95) : 0;
    const tickAccent = beatPos < 0.08 ? 1.45 : 0.65;
    const noise = (nextRand() * 2 - 1) * tickEnv * 0.035 * tickAccent * intensity;

    // Gentle low-pass smoothing on bed
    const alpha = 0.18;
    lpL += alpha * ((subBass + padL) - lpL);
    lpR += alpha * ((subBass + padR) - lpR);

    left[i] = (lpL + noise * 0.85) * masterEnv;
    right[i] = (lpR + noise * 1.15) * masterEnv;
  }

  // Layer frame-locked procedural SFX cues from programmatic-video-studio
  for (let idx = 0; idx < VIDEO_SFX_CUES.length; idx++) {
    const cue = VIDEO_SFX_CUES[idx];
    const wavBuf = synthesizeProceduralWavBuffer(cue.kind, { seed: idx + 7, sampleRate: SAMPLE_RATE });
    const samples = decodeMonoWavSamples(wavBuf);
    const startSample = Math.max(0, Math.round(cue.timeSec * SAMPLE_RATE));
    const pan = ((idx % 5) - 2) * 0.14; // tasteful slight stereo movement
    const gL = cue.gain * (1 - Math.max(0, pan)) * 0.56;
    const gR = cue.gain * (1 + Math.min(0, pan)) * 0.56;
    for (let j = 0; j < samples.length && startSample + j < totalSamples; j++) {
      left[startSample + j] += samples[j] * gL;
      right[startSample + j] += samples[j] * gR;
    }
  }

  // Soft limiter + peak headroom (-2 dBFS)
  let peak = 0;
  for (let i = 0; i < totalSamples; i++) {
    left[i] = Math.tanh(left[i] * 1.15);
    right[i] = Math.tanh(right[i] * 1.15);
    const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (a > peak) peak = a;
  }
  const scale = peak > 0.82 ? 0.82 / peak : 1;
  for (let i = 0; i < totalSamples; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }

  const stereoWav = encodeStereoPcm16Wav(left, right, SAMPLE_RATE);
  fs.writeFileSync(outWavPath, stereoWav);
  return analyzeWavBufferAcousticMetrics(stereoWav);
}

function buildInteractiveVideoHtml(metrics) {
  const version = metrics?.telemetry?.version || '4.0.6';
  const counts = metrics?.telemetry?.counts || { totalCore: 71, testSuites: 56, builtInSkills: 15, guardrails: 59 };
  const ram = metrics?.telemetry?.ramEngine || { cachedFiles: 239, searchMs: 0.7, sliceMs: 0.3 };
  const pg = metrics?.projectGraph || { fileNodes: 155, fileEdges: 412, hubId: 'core/ram-memory-engine.mjs' };
  const clips = metrics?.clips || {
    cockpitFrameCount: 90,
    mapFrameCount: 120,
    cockpitMilestones: { behaviorStartFrame: 32, hardwareStartFrame: 52, guardStartFrame: 72 },
    mapMilestones: { blastStartFrame: 48, hotspotsStartFrame: 80, symbolsStartFrame: 105 },
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>The Tunnel v4 — Interactive 30s Demo Showcase</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: #0a0b0d; color: #f3f4f6;
      font-family: system-ui, -apple-system, 'Segoe UI', Inter, Roboto, sans-serif;
      user-select: none;
    }
    body.capture-mode { width: 1920px; height: 1080px; }
    body.capture-mode .controls-dock { display: none !important; }
    body.capture-mode .stage-shell { width: 1920px; height: 1080px; border: none; border-radius: 0; }

    .viewport-wrap {
      width: 100vw; height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; background: #060709;
    }
    body.capture-mode .viewport-wrap { display: block; width: 1920px; height: 1080px; }

    .stage-shell {
      position: relative; width: 1920px; height: 1080px;
      background: #0a0b0d; overflow: hidden;
      transform-origin: center center;
      border: 1px solid #262830; border-radius: 8px;
    }

    /* Engineering Grid + Subtle Scanline */
    .bg-grid {
      position: absolute; inset: 0; pointer-events: none;
      background-image:
        linear-gradient(to right, rgba(255,255,255,0.032) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.032) 1px, transparent 1px);
      background-size: 96px 96px;
    }
    .top-rail-bar {
      position: absolute; top: 0; left: 0; right: 0; height: 54px; z-index: 20;
      background: #101216; border-bottom: 1px solid rgba(255,255,255,0.09);
      display: flex; align-items: center; justify-content: space-between; padding: 0 36px;
    }
    .top-crimson-line { position: absolute; top: 0; left: 0; right: 0; height: 3px; background: #f04848; z-index: 25; }
    .brand-mini { display: flex; align-items: center; gap: 14px; font: 700 15px ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: 1px; }
    .brand-mini .ver { color: #f04848; font-size: 18px; font-weight: 800; letter-spacing: 0.4px; }
    .brand-mini .sep { color: #3a3f4b; }
    .brand-mini .tagline { color: #9ca3af; font-family: system-ui, sans-serif; font-weight: 500; font-size: 14px; letter-spacing: 0.2px; }
    .rail-status { display: flex; align-items: center; gap: 12px; font: 700 13px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; }
    .status-chip { padding: 5px 12px; border-radius: 4px; background: #08090b; border: 1px solid #2a2d35; color: #d1d5db; display: flex; align-items: center; gap: 7px; }
    .status-chip.crimson { border-color: rgba(240,72,72,0.55); background: #181215; color: #f04848; }
    .dot-live { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }

    /* Bottom Progress Rail inside Stage */
    .stage-progress-track { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: #16181e; z-index: 30; }
    .stage-progress-fill { height: 100%; width: 100%; background: #f04848; transform-origin: left center; transform: scaleX(0); }

    /* Shared Scene Layer */
    .scene {
      position: absolute; inset: 54px 0 6px 0;
      opacity: 0; pointer-events: none;
      display: flex; flex-direction: column; padding: 38px 56px 36px 56px;
    }
    .scene.active { pointer-events: auto; }

    /* Bilingual Header Pattern: Bold EN + smaller quoted «RU» */
    .bilingual-head { margin-bottom: 24px; }
    .eyebrow {
      display: inline-flex; align-items: center; gap: 8px; margin-bottom: 10px;
      font: 700 13px ui-monospace, Consolas, monospace; letter-spacing: 1.4px;
      color: #f04848; text-transform: uppercase;
    }
    .eyebrow::before { content: ''; width: 10px; height: 10px; background: #f04848; transform: rotate(45deg); display: inline-block; }
    .h-en { font-size: 46px; font-weight: 800; letter-spacing: -0.9px; line-height: 1.08; color: #f3f4f6; }
    .h-en .accent { color: #f04848; }
    .h-ru { margin-top: 8px; font-size: 25px; font-weight: 500; line-height: 1.2; color: #a8b1bf; letter-spacing: -0.1px; }

    /* Corner Ticks */
    .frame-card {
      position: relative; background: #0f1014; border: 1px solid #262830; border-radius: 6px; overflow: hidden;
    }
    .frame-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: #f04848; opacity: 0.75; z-index: 2;
    }

    /* SCENE 1: INTRO */
    .s1-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 22px; }
    .s1-emblem-row { display: flex; align-items: center; gap: 26px; }
    .s1-rail-l, .s1-rail-r { width: 170px; height: 4px; background: linear-gradient(90deg, transparent, #9ca3af); border-radius: 2px; }
    .s1-rail-r { background: linear-gradient(90deg, #9ca3af, transparent); }
    .s1-title { font-size: 84px; font-weight: 850; letter-spacing: -2.2px; color: #f3f4f6; line-height: 1; }
    .s1-title span { color: #f04848; font-size: 1.12em; font-weight: 900; letter-spacing: -1px; }
    .s1-sub-en { font-size: 29px; font-weight: 600; color: #d1d5db; letter-spacing: -0.3px; }
    .s1-sub-ru { font-size: 21px; font-weight: 500; color: #9ca3af; margin-top: -8px; }
    .s1-metrics { display: grid; grid-template-columns: repeat(4, 240px); gap: 18px; margin-top: 18px; }
    .metric-box { background: #121316; border: 1px solid #2a2d35; border-radius: 6px; padding: 16px 18px; text-align: left; }
    .metric-val { font: 800 34px ui-monospace, Consolas, monospace; font-variant-numeric: tabular-nums; color: #f3f4f6; }
    .metric-val.red { color: #f04848; }
    .metric-val.green { color: #3fb950; }
    .metric-val.amber { color: #e09f3e; }
    .metric-lbl { font-size: 14px; font-weight: 600; color: #d1d5db; margin-top: 4px; }
    .metric-ru { font-size: 12px; color: #8c95a4; margin-top: 2px; }

    /* SCENE 2: 3D TASK TENSOR */
    .s2-grid { flex: 1; display: grid; grid-template-columns: 520px 1fr; gap: 36px; align-items: center; }
    .tensor-box { background: #101216; border: 1px solid #2a2d35; border-radius: 8px; padding: 26px; display: flex; flex-direction: column; gap: 16px; }
    .tensor-prompt { background: #08090b; border: 1px solid #2a2d35; border-left: 3px solid #f04848; border-radius: 4px; padding: 14px 16px; font: 500 16px/1.4 ui-monospace, Consolas, monospace; color: #e5e7eb; }
    .axis-row { display: flex; flex-direction: column; gap: 6px; }
    .axis-head { display: flex; justify-content: space-between; font: 700 14px ui-monospace, Consolas, monospace; color: #d1d5db; }
    .axis-head small { color: #9ca3af; font-weight: 500; }
    .axis-bar { height: 10px; background: #08090b; border: 1px solid #262830; border-radius: 3px; overflow: hidden; }
    .axis-fill { height: 100%; transform-origin: left center; transform: scaleX(0); }
    .lanes-col { display: flex; flex-direction: column; gap: 20px; position: relative; }
    .lane-card {
      background: #121316; border: 1px solid #2a2d35; border-radius: 6px; padding: 22px 26px;
      display: flex; justify-content: space-between; align-items: center; position: relative;
    }
    .lane-card.active-lane { border-color: #f04848; background: #191215; }
    .lane-left { display: flex; flex-direction: column; gap: 5px; }
    .lane-name { font-size: 26px; font-weight: 750; color: #f3f4f6; }
    .lane-desc { font: 500 15px ui-monospace, Consolas, monospace; color: #9ca3af; }
    .lane-ru { font-size: 15px; color: #b4bcc8; }
    .lane-badge { padding: 8px 16px; border-radius: 4px; font: 700 15px ui-monospace, Consolas, monospace; background: #08090b; border: 1px solid #303440; color: #f3f4f6; }
    .lane-card.active-lane .lane-badge { border-color: #f04848; color: #f04848; background: #1f1216; }

    /* SCENE 3: FULL-WIDTH LIVE INTERACTIVE COCKPIT */
    .s3-stage { flex: 1; display: grid; grid-template-columns: 1060px 1fr; gap: 26px; min-height: 0; align-items: stretch; }
    .cockpit-live-viewport {
      position: relative; background: #08090b; border: 1px solid #2e323c; border-radius: 6px;
      overflow: hidden; display: flex; flex-direction: column;
    }
    .cockpit-live-bar {
      height: 36px; padding: 0 16px; background: #121316; border-bottom: 1px solid rgba(255,255,255,0.08);
      display: flex; justify-content: space-between; align-items: center; flex: none;
    }
    .cockpit-live-bar b { font: 700 13px ui-monospace, Consolas, monospace; color: #f3f4f6; letter-spacing: 0.5px; }
    .cockpit-live-bar span { font: 700 12px ui-monospace, Consolas, monospace; color: #f04848; }
    .cockpit-live-frame { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; background: #0a0b0d; padding: 8px; }
    .cockpit-live-frame img { width: 100%; height: 100%; object-fit: contain; display: block; border-radius: 4px; }
    .cockpit-steps-col { display: flex; flex-direction: column; gap: 14px; }
    .cockpit-step-card {
      background: #121316; border: 1px solid #262830; border-radius: 6px; padding: 18px 20px;
      display: flex; flex-direction: column; gap: 6px; transition: border-color 140ms ease, background 140ms ease;
    }
    .cockpit-step-card.active { border-color: #f04848; background: #191215; }
    .cockpit-step-head { display: flex; justify-content: space-between; align-items: center; font-size: 19px; font-weight: 750; color: #f3f4f6; }
    .cockpit-step-head i { font-style: normal; font: 700 12px ui-monospace, Consolas, monospace; color: #f04848; }
    .cockpit-step-ru { font-size: 14.5px; color: #a8b1bf; }
    .cockpit-step-meta { font: 600 12.5px ui-monospace, Consolas, monospace; color: #6b7280; margin-top: 2px; }

    /* SCENE 4: INTERACTIVE PROJECT MAP (LIVE ZOOM & LENSES) */
    .s4-stage { flex: 1; display: grid; grid-template-columns: 1fr 370px; gap: 24px; min-height: 0; }
    .map-viewport { position: relative; background: #08090b; border: 1px solid #2e323c; border-radius: 6px; overflow: hidden; }
    .map-layer { position: absolute; inset: 0; }
    .map-layer img { width: 100%; height: 100%; object-fit: contain; object-position: center; display: block; background: #08090b; }
    .map-hud-tag {
      position: absolute; bottom: 54px; left: 18px; z-index: 6;
      background: rgba(10,11,13,0.92); border: 1px solid #f04848; border-radius: 4px;
      padding: 8px 14px; display: flex; flex-direction: column; gap: 2px;
    }
    .map-hud-tag strong { font: 700 15px ui-monospace, Consolas, monospace; color: #f3f4f6; }
    .map-hud-tag small { font-size: 13px; color: #d1d5db; }
    .reticle {
      position: absolute; width: 160px; height: 160px; border: 2px solid #f04848; border-radius: 50%;
      top: 44%; left: 48%; transform: translate(-50%, -50%) scale(0.7); opacity: 0; pointer-events: none; z-index: 5;
      box-shadow: inset 0 0 0 1px rgba(240,72,72,0.35);
    }
    .map-sidebar { display: flex; flex-direction: column; gap: 12px; }
    .lens-item {
      background: #121316; border: 1px solid #262830; border-radius: 6px; padding: 14px 16px;
      cursor: pointer; text-align: left; color: inherit;
    }
    .lens-item.active { border-color: #f04848; background: #191215; }
    .lens-item-en { font-size: 17px; font-weight: 700; color: #f3f4f6; display: flex; justify-content: space-between; }
    .lens-item-en i { font-style: normal; font: 700 12px ui-monospace, Consolas, monospace; color: #f04848; }
    .lens-item-ru { font-size: 13.5px; color: #9ca3af; margin-top: 3px; }
    .lens-item-meta { font: 600 12px ui-monospace, Consolas, monospace; color: #6b7280; margin-top: 6px; }
    .map-stats-card { margin-top: auto; background: #0f1014; border: 1px solid #2a2d35; border-radius: 6px; padding: 14px 16px; font: 600 13px/1.6 ui-monospace, Consolas, monospace; color: #9ca3af; }
    .map-stats-card b { color: #f3f4f6; }
    .map-stats-card .red { color: #f04848; }

    /* SCENE 5: LOCAL STACK */
    .s5-grid { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 22px; }
    .stack-card { background: #121316; border: 1px solid #2a2d35; border-radius: 6px; padding: 28px 30px; display: flex; flex-direction: column; justify-content: space-between; position: relative; }
    .stack-card::before { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: var(--bar, #f04848); border-radius: 6px 0 0 6px; }
    .stack-kicker { font: 700 13px ui-monospace, Consolas, monospace; color: var(--bar, #f04848); letter-spacing: 1px; }
    .stack-title { font-size: 28px; font-weight: 800; color: #f3f4f6; margin-top: 8px; }
    .stack-ru { font-size: 17px; color: #a8b1bf; margin-top: 4px; }
    .stack-num { font: 800 44px ui-monospace, Consolas, monospace; color: #f3f4f6; margin-top: 14px; font-variant-numeric: tabular-nums; }
    .stack-foot { font: 500 14px ui-monospace, Consolas, monospace; color: #8c95a4; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; margin-top: 12px; }

    /* SCENE 6: OUTRO */
    .s6-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 20px; }
    .s6-cmd {
      margin-top: 10px; background: #121316; border: 1px solid #f04848; border-radius: 6px;
      padding: 18px 34px; font: 700 22px ui-monospace, Consolas, monospace; color: #f3f4f6;
      letter-spacing: 0.3px;
    }
    .s6-cmd span { color: #f04848; }
    .s6-links { font: 600 18px ui-monospace, Consolas, monospace; color: #9ca3af; }
    .s6-links b { color: #f3f4f6; }

    /* Interactive Ripple FX */
    .click-ripple {
      position: absolute; width: 120px; height: 120px; border-radius: 50%;
      border: 2px solid #f04848; pointer-events: none; z-index: 40;
      transform: translate(-50%, -50%) scale(0.15); opacity: 0.9;
      animation: rippleOut 0.48s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    @keyframes rippleOut {
      to { transform: translate(-50%, -50%) scale(1.25); opacity: 0; }
    }

    /* Interactive Controls Dock (shown in browser, hidden during MP4 render) */
    .controls-dock {
      position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 100;
      background: rgba(15, 16, 20, 0.94); border: 1px solid #2e323c; border-radius: 8px;
      padding: 10px 14px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      box-shadow: 0 12px 32px rgba(0,0,0,0.6); max-width: 96vw;
    }
    .ctl-btn {
      background: #181a20; border: 1px solid #303440; color: #f3f4f6; border-radius: 4px;
      padding: 6px 11px; font: 600 12px ui-monospace, Consolas, monospace; cursor: pointer;
    }
    .ctl-btn:hover { border-color: #f04848; }
    .ctl-btn.primary { background: #f04848; border-color: #f04848; color: #fff; }
    .ctl-btn.active { border-color: #f04848; color: #f04848; background: #1e1316; }
    .ctl-scrub { width: 180px; accent-color: #f04848; cursor: pointer; }
    .ctl-time { font: 700 12px ui-monospace, Consolas, monospace; color: #9ca3af; min-width: 82px; text-align: center; }
  </style>
</head>
<body>
  <div class="viewport-wrap">
    <div id="root" class="stage-shell" data-composition-id="the-tunnel-v406" data-start="0" data-duration="${DURATION_SEC}" data-width="1920" data-height="1080">
      <div class="top-crimson-line"></div>
      <div class="bg-grid"></div>

      <!-- Persistent Top Engineering Rail -->
      <div class="top-rail-bar">
        <div class="brand-mini">
          <svg width="24" height="24" viewBox="0 0 128 128" aria-hidden="true">
            <rect x="10" y="10" width="108" height="108" rx="20" fill="#0d0e12" stroke="#2a2d35" stroke-width="5"/>
            <line x1="22" y1="64" x2="43" y2="64" stroke="#9ca3af" stroke-width="7" stroke-linecap="round"/>
            <line x1="85" y1="64" x2="106" y2="64" stroke="#9ca3af" stroke-width="7" stroke-linecap="round"/>
            <path d="M64 36 L90 64 L64 92 L38 64 Z" fill="#181215" stroke="#f04848" stroke-width="7" stroke-linejoin="round"/>
            <path d="M64 51 L75 64 L64 77 L53 64 Z" fill="#f04848"/>
            <circle cx="64" cy="64" r="4" fill="#f3f4f6"/>
          </svg>
          <span>THE TUNNEL</span>
          <span class="ver">v4</span>
          <span class="sep">/</span>
          <span class="tagline">3D AI Autopilot &amp; Coprocessor · «3D ИИ-автопилот для Google Antigravity»</span>
        </div>
        <div class="rail-status">
          <div class="status-chip"><span class="dot-live"></span><span id="hudChapterLabel">01 / INTRO</span></div>
          <div class="status-chip crimson">EN + «RU»</div>
          <div class="status-chip" id="hudClock">00.0s / 30.0s</div>
        </div>
      </div>

      <!-- SCENE 1: INTRO (0.0s - 4.2s) -->
      <section class="scene" id="scene1" data-start="0" data-duration="4.2" data-sfx="hit">
        <div class="s1-wrap">
          <div class="s1-emblem-row" id="s1Emblem">
            <div class="s1-rail-l"></div>
            <svg width="136" height="136" viewBox="0 0 128 128" aria-label="Crimson Diamond Logo">
              <defs><linearGradient id="bgLogo" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#14161b"/><stop offset="100%" stop-color="#090a0c"/></linearGradient></defs>
              <rect x="10" y="10" width="108" height="108" rx="20" fill="url(#bgLogo)" stroke="#2a2d35" stroke-width="3"/>
              <rect x="18" y="18" width="92" height="92" rx="14" fill="none" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1.5"/>
              <path d="M24 30v-6h6M104 30v-6h-6M24 98v6h6M104 98v6h-6" fill="none" stroke="#3a3f4b" stroke-width="2" stroke-linecap="square"/>
              <line x1="22" y1="64" x2="43" y2="64" stroke="#9ca3af" stroke-width="5" stroke-linecap="round"/>
              <line x1="85" y1="64" x2="106" y2="64" stroke="#9ca3af" stroke-width="5" stroke-linecap="round"/>
              <path d="M64 36 L90 64 L64 92 L38 64 Z" fill="#181215" stroke="#f04848" stroke-width="6" stroke-linejoin="round"/>
              <path d="M64 51 L75 64 L64 77 L53 64 Z" fill="#f04848"/>
              <circle cx="64" cy="64" r="3.5" fill="#f3f4f6"/>
            </svg>
            <div class="s1-rail-r"></div>
          </div>
          <div class="s1-title" id="s1Title">The Tunnel <span>v4</span></div>
          <div class="s1-sub-en" id="s1SubEn">3D AI Autopilot, Live Project Map &amp; Local Coprocessor for Google Antigravity</div>
          <div class="s1-sub-ru" id="s1SubRu">«3D ИИ-автопилот, интерактивная карта проекта и локальный сопроцессор»</div>
          <div class="s1-metrics" id="s1Metrics">
            <div class="metric-box"><div class="metric-val red">${counts.totalCore}</div><div class="metric-lbl">Core ESM Modules</div><div class="metric-ru">«Модулей ядра · 0 deps»</div></div>
            <div class="metric-box"><div class="metric-val green">${counts.guardrails}</div><div class="metric-lbl">Active Guardrails</div><div class="metric-ru">«Защитных контуров»</div></div>
            <div class="metric-box"><div class="metric-val">${counts.builtInSkills}</div><div class="metric-lbl">Built-in Skills</div><div class="metric-ru">«Встроенных навыков»</div></div>
            <div class="metric-box"><div class="metric-val amber">${counts.testSuites}</div><div class="metric-lbl">Automated Test Suites</div><div class="metric-ru">«Наборов автотестов»</div></div>
          </div>
        </div>
      </section>

      <!-- SCENE 2: 3D TASK TENSOR & SMART-SYNERGY (4.2s - 9.5s) -->
      <section class="scene" id="scene2" data-start="4.2" data-duration="5.3" data-sfx="whoosh">
        <div class="bilingual-head">
          <div class="eyebrow">02 · 3D Task Tensor &amp; Smart-Synergy</div>
          <div class="h-en">Routes every task across <span class="accent">Breadth × Depth × Risk</span></div>
          <div class="h-ru">«Автоматический выбор модели и глубины мышления по объёму, сложности и радиусу влияния»</div>
        </div>
        <div class="s2-grid">
          <div class="tensor-box" id="s2Tensor">
            <div class="tensor-prompt">&gt; Refactor @file:core/ram-memory-engine.mjs blast-radius graph &amp; verify 56 test suites</div>
            <div class="axis-row">
              <div class="axis-head"><span>X · BREADTH (4+ modules)</span><small>«Ширина · 4+ файла»</small></div>
              <div class="axis-bar"><div class="axis-fill" id="barX" style="background:#3fb950;"></div></div>
            </div>
            <div class="axis-row">
              <div class="axis-head"><span>Y · DEPTH (AST &amp; Contracts)</span><small>«Глубина · архитектура»</small></div>
              <div class="axis-bar"><div class="axis-fill" id="barY" style="background:#f04848;"></div></div>
            </div>
            <div class="axis-row">
              <div class="axis-head"><span>Z · BLAST RISK (reverseDeps)</span><small>«Риск · радиус влияния»</small></div>
              <div class="axis-bar"><div class="axis-fill" id="barZ" style="background:#e09f3e;"></div></div>
            </div>
            <div style="display:flex;gap:10px;margin-top:6px;font:700 13px ui-monospace,Consolas,monospace;">
              <span class="status-chip crimson">AUTO-SPEC: THINKING / CHAT</span>
              <span class="status-chip">QUOTAPACER v2 · 5h</span>
            </div>
          </div>
          <div class="lanes-col">
            <div class="lane-card" id="laneCard1">
              <div class="lane-left">
                <div class="lane-name">Hydrogen · Medium</div>
                <div class="lane-desc">S / M Routine · Direct 1–3 File Edits · Zero Overhead</div>
                <div class="lane-ru">«Рутинные правки S/M — быстро и без лишней траты квоты»</div>
              </div>
              <div class="lane-badge">GRADE S / M</div>
            </div>
            <div class="lane-card active-lane" id="laneCard2">
              <div class="lane-left">
                <div class="lane-name">Orchestrator (Neon · High / XHigh)</div>
                <div class="lane-desc">L Multi-File · Smart-Synergy Planner + Hydrogen Executor</div>
                <div class="lane-ru">«Умная синергия для L/XL задач · экономия квоты −24%»</div>
              </div>
              <div class="lane-badge">−24% QUOTA</div>
            </div>
            <div class="lane-card" id="laneCard3">
              <div class="lane-left">
                <div class="lane-name">Carbon · High + Adaptive Swarm</div>
                <div class="lane-desc">XL / Critical-Blast · Isolated Worktrees + @verifier</div>
                <div class="lane-ru">«Критический рефакторинг с изоляцией веток и @verifier»</div>
              </div>
              <div class="lane-badge">SWARM READY</div>
            </div>
          </div>
        </div>
      </section>

      <!-- SCENE 3: FULL-WIDTH LIVE INTERACTIVE COCKPIT (9.5s - 16.0s) -->
      <section class="scene" id="scene3" data-start="9.5" data-duration="6.5" data-sfx="whoosh">
        <div class="bilingual-head" style="margin-bottom:16px;">
          <div class="eyebrow">03 · Real Extension UI · Full Working Width (780px)</div>
          <div class="h-en">7-Tab Crimson Rail Cockpit &amp; <span class="accent">Smart Composer 2.0</span></div>
          <div class="h-ru">«Живая работа в кокпите: ввод @file, вкладки автопилота, RAM/CPU/GPU, Guard Dock и смена языка EN↔RU»</div>
        </div>
        <div class="s3-stage">
          <div class="cockpit-live-viewport">
            <div class="cockpit-live-bar">
              <b>LIVE SIDECAR PANEL · 820×680</b>
              <span id="cockpitHudPhase">01 · SMART COMPOSER</span>
            </div>
            <div class="cockpit-live-frame">
              <img id="cockpitLiveImg" src="../media/demo-cockpit.gif" alt="Live Sidecar Control Panel" />
            </div>
          </div>
          <div class="cockpit-steps-col">
            <div class="cockpit-step-card active" id="cockpitStep0">
              <div class="cockpit-step-head"><span>1. Smart Composer 2.0</span><i>@FILE CHIPS</i></div>
              <div class="cockpit-step-ru">«Мгновенный ввод @file и контекста с автодополнением»</div>
              <div class="cockpit-step-meta">Ghost Text · Vision Audit · 0-Token Check</div>
            </div>
            <div class="cockpit-step-card" id="cockpitStep1">
              <div class="cockpit-step-head"><span>2. 3D Routing &amp; Auto-Spec</span><i>SYNERGY</i></div>
              <div class="cockpit-step-ru">«Выбор глубины, Grill-Me и скрытое ТЗ в thinking/chat»</div>
              <div class="cockpit-step-meta">Hydrogen / Neon / Carbon · QuotaPacer v2</div>
            </div>
            <div class="cockpit-step-card" id="cockpitStep2">
              <div class="cockpit-step-head"><span>3. Local RAM / CPU / GPU</span><i>0 TOKENS</i></div>
              <div class="cockpit-step-ru">«Полные счётчики ОЗУ, потоков CPU и локальной Ollama»</div>
              <div class="cockpit-step-meta">16 GB RAM · 16 Threads · gemma4:12b</div>
            </div>
            <div class="cockpit-step-card" id="cockpitStep3">
              <div class="cockpit-step-head"><span>4. Guard Dock &amp; EN ↔ RU</span><i>59 CHECKS</i></div>
              <div class="cockpit-step-ru">«5-контурный Дозор, Health-Doctor и живой перевод UI»</div>
              <div class="cockpit-step-meta">Sentinel · AgentShield · Instant RU/EN</div>
            </div>
          </div>
        </div>
      </section>

      <!-- SCENE 4: LIVE ZOOMING INTERACTIVE PROJECT MAP (16.0s - 24.0s) -->
      <section class="scene" id="scene4" data-start="16.0" data-duration="8.0" data-sfx="hit">
        <div class="bilingual-head" style="margin-bottom:16px;">
          <div class="eyebrow">04 · Live Engine Capture · Smooth Camera Zoom &amp; Pan</div>
          <div class="h-en">Interactive Project Map · <span class="accent">Zoom, Blast &amp; AST Symbols</span></div>
          <div class="h-ru">«Масштабирование графа, тултипы, волна Blast, локальный фокус, Hotspots и зум в AST-символы»</div>
        </div>
        <div class="s4-stage">
          <div class="map-viewport" id="mapViewport">
            <div class="map-layer"><img id="mapLiveImg" src="../media/demo-project-map.gif" alt="Live Interactive Project Map" /></div>
            <div class="reticle" id="mapReticle"></div>
            <div class="map-hud-tag" id="mapHudTag">
              <strong id="mapHudEn">ARCHITECTURE · SMOOTH ZOOM ON HUB</strong>
              <small id="mapHudRu">«Плавный зум к ключевому узлу и hover-тултип без слипания линий»</small>
            </div>
          </div>
          <div class="map-sidebar">
            <button type="button" class="lens-item active" data-lens-idx="0" id="lensBtn0">
              <div class="lens-item-en"><span>1. Architecture &amp; Zoom</span><i>2.35× ZOOM</i></div>
              <div class="lens-item-ru">«Слои, зум камеры и богатые тултипы»</div>
              <div class="lens-item-meta">Folders → Files · Smooth Pan &amp; Tooltip</div>
            </button>
            <button type="button" class="lens-item" data-lens-idx="1" id="lensBtn1">
              <div class="lens-item-en"><span>2. Blast &amp; Diff + Cart</span><i>1–3 HOPS</i></div>
              <div class="lens-item-ru">«Волна влияния и корзина @file: в чат»</div>
              <div class="lens-item-meta">Linked modules + risks → Smart Composer</div>
            </button>
            <button type="button" class="lens-item" data-lens-idx="2" id="lensBtn2">
              <div class="lens-item-en"><span>3. Local Focus &amp; Hotspots</span><i>ISOLATE</i></div>
              <div class="lens-item-ru">«Локальный фокус и горячие точки Git»</div>
              <div class="lens-item-meta">1-Hop Isolation · Churn × Coupling</div>
            </button>
            <button type="button" class="lens-item" data-lens-idx="3" id="lensBtn3">
              <div class="lens-item-en"><span>4. AST Symbol Zoom</span><i>WEBGL2</i></div>
              <div class="lens-item-ru">«Зум внутрь графа вызовов функций»</div>
              <div class="lens-item-meta">Barnes-Hut O(N log N) · 25k Nodes · PNG</div>
            </button>
            <div class="map-stats-card">
              LIVE WORKSPACE GRAPH<br/>
              Nodes: <b>${pg.fileNodes}</b> · Edges: <b class="red">${pg.fileEdges}</b><br/>
              Hub: <b>${pg.hubId}</b>
            </div>
          </div>
        </div>
      </section>

      <!-- SCENE 5: ZERO-TOKEN LOCAL ACCELERATION (24.0s - 27.4s) -->
      <section class="scene" id="scene5" data-start="24.0" data-duration="3.4" data-sfx="whoosh">
        <div class="bilingual-head">
          <div class="eyebrow">05 · Zero-Token Local Coprocessors &amp; Safety</div>
          <div class="h-en">In-RAM Memory, CPU Pool, <span class="accent">Ollama GPU</span> &amp; Time-Machine</div>
          <div class="h-ru">«Локальная память в ОЗУ, CPU-реранкер, Ollama GPU без траты облачной квоты и атомарный откат»</div>
        </div>
        <div class="s5-grid">
          <div class="stack-card" id="stack0" style="--bar:#f04848;">
            <div>
              <div class="stack-kicker">MODULAR IN-RAM MCP · 4–32 GB</div>
              <div class="stack-title">Sub-Millisecond Code Slicing</div>
              <div class="stack-ru">«Мгновенный поиск BM25F + Trigram и AST-срезы из ОЗУ»</div>
              <div class="stack-num">${ram.sliceMs} ms · ${ram.cachedFiles} files</div>
            </div>
            <div class="stack-foot">core/ram/{search, slicer, graph-queries, context-packs}.mjs</div>
          </div>
          <div class="stack-card" id="stack1" style="--bar:#3fb950;">
            <div>
              <div class="stack-kicker">MULTI-CORE CPU COPROCESSOR</div>
              <div class="stack-title">Zero-VRAM Cross-Reranker &amp; TOON</div>
              <div class="stack-ru">«Реранкер &lt;15 мс, Drain3, Myers Delta и Mutation Guard»</div>
              <div class="stack-num">&lt;15 ms · −35% tokens</div>
            </div>
            <div class="stack-foot">node:worker_threads · 260+ RU↔EN engineering stems</div>
          </div>
          <div class="stack-card" id="stack2" style="--bar:#e09f3e;">
            <div>
              <div class="stack-kicker">LOCAL OLLAMA GPU · i8bin-v2</div>
              <div class="stack-title">0-Token Distill, Semantic &amp; Vision</div>
              <div class="stack-ru">«Локальное сжатие логов, смысловой поиск и аудит скриншотов»</div>
              <div class="stack-num">0 Cloud Tokens</div>
            </div>
            <div class="stack-foot">qwen3-embedding + gemma4:12b · 1-click Ollama installer</div>
          </div>
          <div class="stack-card" id="stack3" style="--bar:#9ca3af;">
            <div>
              <div class="stack-kicker">SAFETY &amp; TIME-MACHINE</div>
              <div class="stack-title">${counts.guardrails} Guardrails &amp; Turn Rollback</div>
              <div class="stack-ru">«Пошаговый откат, Git-песочницы, AgentShield и Health-Doctor»</div>
              <div class="stack-num">${counts.testSuites} / ${counts.testSuites} Tests Pass</div>
            </div>
            <div class="stack-foot">LSP Bridge · Runtime Wiretap · SQLite Episodic Memory &amp; CCR</div>
          </div>
        </div>
      </section>

      <!-- SCENE 6: OUTRO (27.4s - 30.0s) -->
      <section class="scene" id="scene6" data-start="27.4" data-duration="2.6" data-sfx="hit">
        <div class="s6-wrap">
          <svg width="118" height="118" viewBox="0 0 128 128" id="s6Logo">
            <rect x="10" y="10" width="108" height="108" rx="20" fill="#121316" stroke="#2a2d35" stroke-width="3"/>
            <line x1="22" y1="64" x2="43" y2="64" stroke="#9ca3af" stroke-width="5" stroke-linecap="round"/>
            <line x1="85" y1="64" x2="106" y2="64" stroke="#9ca3af" stroke-width="5" stroke-linecap="round"/>
            <path d="M64 36 L90 64 L64 92 L38 64 Z" fill="#181215" stroke="#f04848" stroke-width="6" stroke-linejoin="round"/>
            <path d="M64 51 L75 64 L64 77 L53 64 Z" fill="#f04848"/>
            <circle cx="64" cy="64" r="3.5" fill="#f3f4f6"/>
          </svg>
          <div class="s1-title" style="font-size:74px;">The Tunnel <span>v4</span></div>
          <div class="s1-sub-en">Ready for Windows, macOS &amp; Linux · Zero External Runtime Dependencies</div>
          <div class="s1-sub-ru">«Готово к установке в 1 клик · Setup.exe, портативный .zip или node install.js»</div>
          <div class="s6-cmd"><span>$</span> node install.js &nbsp;·&nbsp; The-Tunnel-Setup.exe</div>
          <div class="s6-links">github.com/<b>vaszuevvas-coder/antigravity-model-router</b></div>
        </div>
      </section>

      <div class="stage-progress-track"><div class="stage-progress-fill" id="stageProgressFill"></div></div>
    </div>
  </div>

  <!-- Interactive Controls Dock -->
  <div class="controls-dock" id="controlsDock">
    <button type="button" class="ctl-btn primary" id="btnPlayPause">▶ Play</button>
    <button type="button" class="ctl-btn" id="btnSound">🔊 SFX ON</button>
    <input type="range" class="ctl-scrub" id="timeScrub" min="0" max="30" step="0.05" value="0" aria-label="Seek timeline" />
    <span class="ctl-time" id="ctlTime">00.0 / 30.0s</span>
    <button type="button" class="ctl-btn" data-jump="0">1. Intro</button>
    <button type="button" class="ctl-btn" data-jump="4.3">2. 3D Tensor</button>
    <button type="button" class="ctl-btn" data-jump="9.6">3. Cockpit</button>
    <button type="button" class="ctl-btn" data-jump="16.1">4. Project Map</button>
    <button type="button" class="ctl-btn" data-jump="24.1">5. Local Stack</button>
    <button type="button" class="ctl-btn" data-jump="27.5">6. Install</button>
  </div>

  <script>
    (function () {
      const DURATION = ${DURATION_SEC};
      const CLIPS = ${JSON.stringify(clips)};
      const isCapture = new URLSearchParams(location.search).get('capture') === '1';
      if (isCapture) document.body.classList.add('capture-mode');

      const LENS_META = [
        { en: 'ARCHITECTURE · SMOOTH 2.35× ZOOM', ru: '«Плавный зум на хаб и hover-тултип без слипания»', img: '../media/project-map-arch.png', rx: 48, ry: 46 },
        { en: 'BLAST & DIFF · 1–3 HOP WAVE + CART', ru: '«Волна влияния и добавление связей @file: в чат»', img: '../media/project-map-blast.png', rx: 52, ry: 50 },
        { en: 'LOCAL FOCUS & GIT HOTSPOTS', ru: '«Локальный фокус 1-хоп и горячие точки Git»', img: '../media/project-map-hotspots.png', rx: 44, ry: 52 },
        { en: 'AST SYMBOL CALL GRAPH · 2.15× ZOOM', ru: '«Зум внутрь графа вызовов функций (WebGL2)»', img: '../media/project-map-symbols.png', rx: 52, ry: 48 },
      ];

      const COCKPIT_PHASES = [
        '01 · SMART COMPOSER (@FILE)',
        '02 · 3D ROUTING & AUTO-SPEC',
        '03 · LOCAL RAM / CPU / GPU',
        '04 · GUARD DOCK & EN ↔ RU',
      ];

      const CHAPTERS = [
        { id: 'scene1', start: 0.0, end: 4.2, label: '01 / INTRO' },
        { id: 'scene2', start: 4.2, end: 9.5, label: '02 / 3D TENSOR' },
        { id: 'scene3', start: 9.5, end: 16.0, label: '03 / LIVE COCKPIT' },
        { id: 'scene4', start: 16.0, end: 24.0, label: '04 / PROJECT MAP' },
        { id: 'scene5', start: 24.0, end: 27.4, label: '05 / LOCAL STACK' },
        { id: 'scene6', start: 27.4, end: 30.0, label: '06 / INSTALL' },
      ];

      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
      const norm = (t, a, b) => easeOut((t - a) / Math.max(0.001, b - a));
      const pad4 = (n) => String(Math.max(1, n)).padStart(4, '0');

      let manualLensOverride = -1;
      let currentTime = 0;

      function fitStage() {
        if (isCapture) return;
        const shell = document.getElementById('root');
        const sx = (window.innerWidth - 20) / 1920;
        const sy = (window.innerHeight - 92) / 1080;
        const sc = Math.min(sx, sy, 1);
        shell.style.transform = 'scale(' + sc.toFixed(4) + ')';
      }
      window.addEventListener('resize', fitStage);
      fitStage();

      function applyTime(tSec) {
        const t = clamp(Number(tSec) || 0, 0, DURATION);
        currentTime = t;

        const fill = document.getElementById('stageProgressFill');
        if (fill) fill.style.transform = 'scaleX(' + (t / DURATION).toFixed(4) + ')';
        const clk = document.getElementById('hudClock');
        if (clk) clk.textContent = t.toFixed(1).padStart(4, '0') + 's / 30.0s';
        const ctlT = document.getElementById('ctlTime');
        if (ctlT) ctlT.textContent = t.toFixed(1).padStart(4, '0') + ' / 30.0s';
        const scrub = document.getElementById('timeScrub');
        if (scrub && document.activeElement !== scrub) scrub.value = t.toFixed(2);

        // Chapter visibility with crisp 0.24s crossfade
        let activeLabel = CHAPTERS[0].label;
        for (const ch of CHAPTERS) {
          const el = document.getElementById(ch.id);
          if (!el) continue;
          const fadeIn = ch.start === 0 ? 1 : clamp((t - ch.start) / 0.24, 0, 1);
          const fadeOut = ch.end >= DURATION ? 1 : clamp((ch.end - t) / 0.22, 0, 1);
          const inRange = t >= ch.start && (t < ch.end || (ch.end >= DURATION && t <= DURATION));
          const op = inRange ? Math.min(fadeIn, fadeOut) : 0;
          el.style.opacity = op.toFixed(4);
          el.classList.toggle('active', inRange);
          if (inRange) activeLabel = ch.label;
        }
        const lblEl = document.getElementById('hudChapterLabel');
        if (lblEl) lblEl.textContent = activeLabel;

        // Scene 1 choreography
        if (t < 4.4) {
          const p1 = norm(t, 0.25, 1.05);
          const p2 = norm(t, 0.75, 1.45);
          const p3 = norm(t, 1.65, 2.35);
          document.getElementById('s1Emblem').style.transform = 'scale(' + (0.82 + 0.18 * p1).toFixed(4) + ')';
          document.getElementById('s1Emblem').style.opacity = p1.toFixed(4);
          document.getElementById('s1Title').style.transform = 'translateY(' + ((1 - p2) * 28).toFixed(1) + 'px)';
          document.getElementById('s1Title').style.opacity = p2.toFixed(4);
          document.getElementById('s1SubEn').style.opacity = norm(t, 1.05, 1.65).toFixed(4);
          document.getElementById('s1SubRu').style.opacity = norm(t, 1.25, 1.85).toFixed(4);
          document.getElementById('s1Metrics').style.transform = 'translateY(' + ((1 - p3) * 24).toFixed(1) + 'px)';
          document.getElementById('s1Metrics').style.opacity = p3.toFixed(4);
        }

        // Scene 2 choreography (3D Tensor)
        if (t >= 4.1 && t < 9.7) {
          document.getElementById('barX').style.transform = 'scaleX(' + (0.86 * norm(t, 4.7, 5.5)).toFixed(4) + ')';
          document.getElementById('barY').style.transform = 'scaleX(' + (0.94 * norm(t, 5.0, 5.8)).toFixed(4) + ')';
          document.getElementById('barZ').style.transform = 'scaleX(' + (0.78 * norm(t, 5.3, 6.1)).toFixed(4) + ')';
          const c1 = norm(t, 5.9, 6.45);
          const c2 = norm(t, 6.9, 7.5);
          const c3 = norm(t, 8.0, 8.55);
          const lc1 = document.getElementById('laneCard1');
          const lc2 = document.getElementById('laneCard2');
          const lc3 = document.getElementById('laneCard3');
          lc1.style.opacity = (0.35 + 0.65 * c1).toFixed(3);
          lc1.style.transform = 'translateX(' + ((1 - c1) * 32).toFixed(1) + 'px)';
          lc2.style.opacity = (0.35 + 0.65 * c2).toFixed(3);
          lc2.style.transform = 'translateX(' + ((1 - c2) * 32).toFixed(1) + 'px) scale(' + (1 + 0.025 * c2).toFixed(4) + ')';
          lc3.style.opacity = (0.35 + 0.65 * c3).toFixed(3);
          lc3.style.transform = 'translateX(' + ((1 - c3) * 32).toFixed(1) + 'px)';
        }

        // Scene 3 choreography (Full-Width Live Interactive Cockpit Clip)
        if (t >= 9.3 && t < 16.2) {
          const totalC = Math.max(1, CLIPS.cockpitFrameCount || 1);
          const uC = clamp((t - 9.5) / 6.5, 0, 0.9999);
          const cFrame = Math.min(totalC, 1 + Math.floor(uC * totalC));
          const cImg = document.getElementById('cockpitLiveImg');
          if (cImg) {
            const targetSrc = isCapture ? ('/promo-frames/cockpit/frame-' + pad4(cFrame) + '.png') : '../media/demo-cockpit.gif';
            if (cImg.getAttribute('data-cur-src') !== targetSrc) {
              cImg.setAttribute('data-cur-src', targetSrc);
              cImg.src = targetSrc;
            }
          }
          const cm = CLIPS.cockpitMilestones || {};
          const stepRef = isCapture ? cFrame : (1 + Math.floor(uC * totalC));
          let activeStep = 0;
          if (stepRef >= (cm.guardStartFrame || Math.round(totalC * 0.72))) activeStep = 3;
          else if (stepRef >= (cm.hardwareStartFrame || Math.round(totalC * 0.52))) activeStep = 2;
          else if (stepRef >= (cm.behaviorStartFrame || Math.round(totalC * 0.34))) activeStep = 1;
          for (let i = 0; i < 4; i++) {
            const card = document.getElementById('cockpitStep' + i);
            if (card) card.classList.toggle('active', i === activeStep);
          }
          const ph = document.getElementById('cockpitHudPhase');
          if (ph) ph.textContent = COCKPIT_PHASES[activeStep];
        }

        // Scene 4 choreography (Live Zooming Project Map Clip + Lenses)
        if (t >= 15.8 && t < 24.2) {
          const totalM = Math.max(1, CLIPS.mapFrameCount || 1);
          const uM = clamp((t - 16.0) / 8.0, 0, 0.9999);
          const mFrame = Math.min(totalM, 1 + Math.floor(uM * totalM));
          const mm = CLIPS.mapMilestones || {};

          let activeIdx = 0;
          if (manualLensOverride >= 0) {
            activeIdx = manualLensOverride;
          } else if (mFrame >= (mm.symbolsStartFrame || Math.round(totalM * 0.76))) {
            activeIdx = 3;
          } else if (mFrame >= (mm.hotspotsStartFrame || Math.round(totalM * 0.56))) {
            activeIdx = 2;
          } else if (mFrame >= (mm.blastStartFrame || Math.round(totalM * 0.34))) {
            activeIdx = 1;
          } else {
            activeIdx = 0;
          }

          const mImg = document.getElementById('mapLiveImg');
          if (mImg) {
            const targetSrc = isCapture
              ? ('/promo-frames/map/frame-' + pad4(mFrame) + '.png')
              : (manualLensOverride >= 0 ? LENS_META[activeIdx].img : '../media/demo-project-map.gif');
            if (mImg.getAttribute('data-cur-src') !== targetSrc) {
              mImg.setAttribute('data-cur-src', targetSrc);
              mImg.src = targetSrc;
            }
          }

          for (let i = 0; i < 4; i++) {
            const btn = document.getElementById('lensBtn' + i);
            if (btn) btn.classList.toggle('active', i === activeIdx);
          }

          const meta = LENS_META[activeIdx];
          document.getElementById('mapHudEn').textContent = meta.en;
          document.getElementById('mapHudRu').textContent = meta.ru;

          const pulsePhase = ((t - 16.0) * 1.1) % 1;
          const ret = document.getElementById('mapReticle');
          ret.style.left = meta.rx + '%';
          ret.style.top = meta.ry + '%';
          ret.style.opacity = isCapture ? '0' : (Math.sin(pulsePhase * Math.PI) * 0.7).toFixed(3);
          ret.style.transform = 'translate(-50%, -50%) scale(' + (0.72 + 0.48 * pulsePhase).toFixed(3) + ')';
        }

        // Scene 5 choreography (Local Stack)
        if (t >= 23.9 && t < 27.5) {
          for (let i = 0; i < 4; i++) {
            const p = norm(t, 24.15 + i * 0.38, 24.75 + i * 0.38);
            const el = document.getElementById('stack' + i);
            el.style.opacity = p.toFixed(3);
            el.style.transform = 'translateY(' + ((1 - p) * 24).toFixed(1) + 'px)';
          }
        }

        // Scene 6 choreography (Outro)
        if (t >= 27.3) {
          const p = norm(t, 27.45, 28.2);
          document.getElementById('s6Logo').style.transform = 'scale(' + (0.85 + 0.15 * p).toFixed(4) + ')';
        }
      }

      async function waitVisibleImagesDecoded() {
        const imgs = [];
        const cImg = document.getElementById('cockpitLiveImg');
        const mImg = document.getElementById('mapLiveImg');
        if (currentTime >= 9.3 && currentTime < 16.2 && cImg) imgs.push(cImg);
        if (currentTime >= 15.8 && currentTime < 24.2 && mImg) imgs.push(mImg);
        for (const img of imgs) {
          if (!img.complete) {
            await new Promise((res) => {
              img.addEventListener('load', res, { once: true });
              img.addEventListener('error', res, { once: true });
            });
          }
          if (typeof img.decode === 'function') {
            try { await img.decode(); } catch {}
          }
        }
      }

      // Deterministic timeline registry (HyperFrames-compatible seek contract)
      window.__seek = applyTime;
      window.__seekAsync = async (sec) => {
        applyTime(sec);
        await waitVisibleImagesDecoded();
      };
      window.__timelines = window.__timelines || {};
      window.__timelines['the-tunnel-v406'] = {
        duration: () => DURATION,
        time: (sec) => { if (typeof sec === 'number') applyTime(sec); return currentTime; },
        seek: (sec) => applyTime(sec),
      };

      applyTime(0);

      // Interactive browser player & Web Audio synth (never runs in ?capture=1 deterministic mode)
      if (!isCapture) {
        let playing = false;
        let soundOn = true;
        let audioCtx = null;
        let lastFrameTs = 0;
        let firedCueSet = new Set();
        const CUES = ${JSON.stringify(VIDEO_SFX_CUES)};

        function ensureAudio() {
          if (!soundOn) return null;
          if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) audioCtx = new Ctx();
          }
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
          return audioCtx;
        }

        function playWebSfx(kind) {
          const ctx = ensureAudio();
          if (!ctx) return;
          const now = ctx.currentTime;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);

          if (kind === 'hit') {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(160, now);
            osc.frequency.exponentialRampToValueAtTime(42, now + 0.22);
            gain.gain.setValueAtTime(0.28, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
            osc.start(now); osc.stop(now + 0.25);
          } else if (kind === 'whoosh' || kind === 'riser') {
            osc.type = 'sine';
            const f0 = kind === 'riser' ? 140 : 480;
            const f1 = kind === 'riser' ? 560 : 140;
            osc.frequency.setValueAtTime(f0, now);
            osc.frequency.exponentialRampToValueAtTime(f1, now + 0.28);
            gain.gain.setValueAtTime(0.14, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.30);
            osc.start(now); osc.stop(now + 0.31);
          } else if (kind === 'chime' || kind === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(kind === 'success' ? 587.33 : 659.25, now);
            osc.frequency.setValueAtTime(kind === 'success' ? 880 : 987.77, now + 0.09);
            gain.gain.setValueAtTime(0.14, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.38);
            osc.start(now); osc.stop(now + 0.4);
          } else {
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(kind === 'pop' ? 420 : 960, now);
            osc.frequency.exponentialRampToValueAtTime(kind === 'pop' ? 760 : 320, now + 0.06);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
            osc.start(now); osc.stop(now + 0.09);
          }
        }

        function spawnRipple(ev) {
          const shell = document.getElementById('root');
          const rect = shell.getBoundingClientRect();
          const x = ((ev.clientX - rect.left) / rect.width) * 1920;
          const y = ((ev.clientY - rect.top) / rect.height) * 1080;
          const r = document.createElement('div');
          r.className = 'click-ripple';
          r.style.left = x + 'px';
          r.style.top = y + 'px';
          shell.appendChild(r);
          r.addEventListener('animationend', () => r.remove());
        }

        document.getElementById('root').addEventListener('click', (ev) => {
          spawnRipple(ev);
          playWebSfx('click');
        });

        for (let i = 0; i < 4; i++) {
          document.getElementById('lensBtn' + i).addEventListener('click', (ev) => {
            ev.stopPropagation();
            manualLensOverride = i;
            applyTime(currentTime);
            playWebSfx('pop');
          });
        }

        function tick(ts) {
          if (!playing) return;
          if (!lastFrameTs) lastFrameTs = ts;
          const dt = Math.min(0.1, (ts - lastFrameTs) / 1000);
          lastFrameTs = ts;
          const next = currentTime + dt;
          if (next >= DURATION) {
            applyTime(DURATION);
            playing = false;
            document.getElementById('btnPlayPause').textContent = '↻ Replay';
            return;
          }
          for (let i = 0; i < CUES.length; i++) {
            if (!firedCueSet.has(i) && CUES[i].timeSec <= next && CUES[i].timeSec >= currentTime - 0.05) {
              firedCueSet.add(i);
              playWebSfx(CUES[i].kind);
            }
          }
          applyTime(next);
          window.requestAnimationFrame(tick);
        }

        document.getElementById('btnPlayPause').addEventListener('click', () => {
          ensureAudio();
          if (currentTime >= DURATION - 0.1) {
            currentTime = 0;
            firedCueSet.clear();
            manualLensOverride = -1;
          }
          playing = !playing;
          document.getElementById('btnPlayPause').textContent = playing ? '⏸ Pause' : '▶ Play';
          if (playing) {
            lastFrameTs = 0;
            playWebSfx('click');
            window.requestAnimationFrame(tick);
          }
        });

        document.getElementById('btnSound').addEventListener('click', (ev) => {
          soundOn = !soundOn;
          ev.currentTarget.textContent = soundOn ? '🔊 SFX ON' : '🔇 Muted';
          if (soundOn) playWebSfx('chime');
        });

        document.getElementById('timeScrub').addEventListener('input', (ev) => {
          manualLensOverride = -1;
          firedCueSet.clear();
          applyTime(Number(ev.target.value));
        });

        document.querySelectorAll('[data-jump]').forEach((btn) => {
          btn.addEventListener('click', () => {
            manualLensOverride = -1;
            firedCueSet.clear();
            applyTime(Number(btn.getAttribute('data-jump')));
            playWebSfx('whoosh');
          });
        });
      }
    })();
  </script>
</body>
</html>`;
}

function startStaticDocsServer(docsDir, promoFramesDir) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.json': 'application/json; charset=utf-8',
  };
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0]);
    if (clean.startsWith('/promo-frames/') && promoFramesDir) {
      const frameRel = clean.slice('/promo-frames/'.length);
      const frameAbs = path.resolve(promoFramesDir, frameRel);
      if (!frameAbs.startsWith(promoFramesDir) || !fs.existsSync(frameAbs) || fs.statSync(frameAbs).isDirectory()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(frameAbs).pipe(res);
      return;
    }
    const rel = clean === '/' ? 'demo/index.html' : clean.replace(/^\/+/, '');
    const abs = path.resolve(docsDir, rel);
    if (!abs.startsWith(docsDir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen({ server, port: server.address().port }));
  });
}

async function main() {
  const metricsPath = path.join(MEDIA_DIR, 'live-metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error('Missing docs/media/live-metrics.json — run node scripts/capture-live-media.mjs first');
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const version = metrics?.telemetry?.version || '4.0.6';

  fs.mkdirSync(DEMO_DIR, { recursive: true });
  const demoHtmlPath = path.join(DEMO_DIR, 'index.html');
  const html = buildInteractiveVideoHtml(metrics);

  // Verify frame-determinism via programmatic-video-studio linter
  const lintRes = lintVideoCompositionContent(html, 'docs/demo/index.html');
  if (!lintRes.ok) {
    throw new Error(`Composition determinism lint failed: ${JSON.stringify(lintRes.findings)}`);
  }
  fs.writeFileSync(demoHtmlPath, html, 'utf8');
  console.log('[1/4] Generated docs/demo/index.html (determinism lint OK)');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-video-render-'));
  const rawWavPath = path.join(tmpDir, 'soundtrack-raw.wav');
  const rawMp4Path = path.join(tmpDir, 'video-silent.mp4');
  const finalMp4Path = path.join(MEDIA_DIR, 'the-tunnel-demo-v4.mp4');
  const heroGifPath = path.join(MEDIA_DIR, 'hero-showcase.gif');

  let staticSrv = null;
  let cdp = null;

  try {
    console.log('[2/4] Synthesizing 30.00s stereo soundtrack + 26 SFX cues...');
    const audioMetrics = buildStudioSoundtrackWav(rawWavPath);
    console.log('      Audio metrics:', JSON.stringify({
      durationSec: audioMetrics.durationSec,
      peakDb: audioMetrics.peakDb,
      approxLufs: audioMetrics.approxLufs,
      clippingSamples: audioMetrics.clippingSamples,
    }));

    const browserExe = findBrowserExecutable();
    if (!browserExe) throw new Error('Headless Chromium/Edge binary not found');

    staticSrv = await startStaticDocsServer(path.join(ROOT_DIR, 'docs'), path.join(ROOT_DIR, '.cache', 'promo-frames'));
    cdp = await launchCdp(browserExe, path.join(tmpDir, 'profile'));

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

    const loaded = cdp.waitForEvent('Page.loadEventFired', 15000);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/demo/index.html?capture=1` });
    await loaded;

    // Wait for all embedded PNG screenshots to decode
    await cdp.send('Runtime.evaluate', {
      expression: `Promise.all(Array.from(document.images).map(img => img.complete ? true : new Promise(r => { img.onload = r; img.onerror = r; })))`,
      awaitPromise: true,
    });

    console.log(`[3/4] Rendering ${TOTAL_FRAMES} deterministic 1920x1080 frames directly into FFmpeg...`);
    const ff = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-framerate', String(FPS),
      '-i', '-',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '22',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      rawMp4Path,
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

    let ffStderr = '';
    ff.stderr.on('data', (c) => { ffStderr += c.toString('utf8'); });

    for (let f = 0; f < TOTAL_FRAMES; f++) {
      const tSec = Number((f / FPS).toFixed(4));
      await cdp.send('Runtime.evaluate', { expression: `window.__seekAsync(${tSec})`, awaitPromise: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.data, 'base64');
      if (!ff.stdin.write(buf)) {
        await new Promise((r) => ff.stdin.once('drain', r));
      }
      if ((f + 1) % 150 === 0 || f === TOTAL_FRAMES - 1) {
        console.log(`      Rendered ${f + 1}/${TOTAL_FRAMES} frames (${tSec.toFixed(1)}s)`);
      }
    }
    ff.stdin.end();
    await new Promise((resolve, reject) => {
      ff.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg video encode failed (${code}): ${ffStderr.slice(-600)}`))));
    });

    console.log('[4/4] Mastering -16 LUFS stereo audio into MP4 & extracting hero-showcase.gif...');
    execFileSync('ffmpeg', [
      '-y',
      '-i', rawMp4Path,
      '-i', rawWavPath,
      '-filter_complex', '[1:a]loudnorm=I=-16:TP=-1.5:LRA=9[aout]',
      '-map', '0:v:0',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-movflags', '+faststart',
      '-shortest',
      finalMp4Path,
    ], { stdio: 'ignore', windowsHide: true });

    // Extract a tight 10s multi-chapter Hero Teaser GIF (900px wide, crisp Crimson Rail palette)
    const gifPalette = path.join(tmpDir, 'hero-palette.png');
    const montageFilter = [
      "[0:v]trim=start=1.2:end=3.0,setpts=PTS-STARTPTS[v0]",
      "[0:v]trim=start=6.4:end=8.2,setpts=PTS-STARTPTS[v1]",
      "[0:v]trim=start=10.2:end=13.2,setpts=PTS-STARTPTS[v2]",
      "[0:v]trim=start=17.0:end=22.4,setpts=PTS-STARTPTS[v3]",
      "[0:v]trim=start=24.6:end=26.4,setpts=PTS-STARTPTS[v4]",
      "[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0,fps=10,scale=900:-1:flags=lanczos[cat]",
    ].join(';');

    execFileSync('ffmpeg', [
      '-y', '-i', finalMp4Path,
      '-filter_complex', `${montageFilter};[cat]palettegen=max_colors=192:stats_mode=diff[p]`,
      '-map', '[p]',
      gifPalette,
    ], { stdio: 'ignore', windowsHide: true });

    execFileSync('ffmpeg', [
      '-y', '-i', finalMp4Path, '-i', gifPalette,
      '-filter_complex', `${montageFilter};[cat][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle[out]`,
      '-map', '[out]',
      '-loop', '0',
      heroGifPath,
    ], { stdio: 'ignore', windowsHide: true });

    const mp4Mb = (fs.statSync(finalMp4Path).size / (1024 * 1024)).toFixed(2);
    const gifMb = (fs.statSync(heroGifPath).size / (1024 * 1024)).toFixed(2);
    console.log(`✓ Rendered ${path.basename(finalMp4Path)} (${mp4Mb} MB) + hero-showcase.gif (${gifMb} MB) + docs/demo/index.html`);
  } finally {
    try { cdp?.close?.(); } catch {}
    try { staticSrv?.server?.close?.(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error('[render-promo-video] FAILED:', err);
  process.exit(1);
});
