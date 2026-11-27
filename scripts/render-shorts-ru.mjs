#!/usr/bin/env node
/**
 * @file render-shorts-ru.mjs
 * @description Renders a 25.00s vertical 1080x1920 (30fps) Russian Shorts/Reels promo video
 *              for The Tunnel v4.0.6 with:
 *              - Microsoft Edge Neural TTS v2 (ru-RU-DmitryNeural) + WordBoundary karaoke subtitles
 *              - Live Russian UI & WebGL2 Project Map captures (.cache/shorts-ru-frames/)
 *              - Multi-layer stereo sound design (sidechain-ducked 116 BPM cyber-tech bed +
 *                frame-locked mouse clicks, key taps, transitions, wave hits & chimes @ -14 LUFS)
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
import { probeAudioDurationSec, synthesizeRussianVoiceover } from './lib/edge-tts-v2.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const MEDIA_DIR = path.join(ROOT_DIR, 'docs', 'media');
const DEMO_DIR = path.join(ROOT_DIR, 'docs', 'demo');
const FRAMES_ROOT = path.join(ROOT_DIR, '.cache', 'shorts-ru-frames');

const DURATION_SEC = 25.0;
const FPS = 30;
const TOTAL_FRAMES = Math.round(DURATION_SEC * FPS); // 750 frames
const SAMPLE_RATE = 48000;
const WIDTH = 1080;
const HEIGHT = 1920;

const SCRIPT_SEGMENTS = [
  {
    id: 's1',
    rate: '+16%',
    ttsText: 'А вы знали, что есть крутое расширение для Антигравити, которое делает из него мощный автопилот?',
    displayGroups: [
      { words: ['А', 'вы', 'знали,'], ttsCount: 3 },
      { words: ['что', 'есть', 'крутое'], ttsCount: 3 },
      { words: ['расширение', 'для', 'Antigravity,'], ttsCount: 3 },
      { words: ['которое', 'делает', 'из', 'него'], ttsCount: 4 },
      { words: ['мощный', 'автопилот?'], ttsCount: 2 },
    ],
  },
  {
    id: 's2',
    rate: '+18%',
    ttsText: 'Оно само подбирает модель под задачу и экономит тридцать пять процентов токенов прямо в живой панели.',
    displayGroups: [
      { words: ['Оно', 'само', 'подбирает'], ttsCount: 3 },
      { words: ['модель', 'под', 'задачу'], ttsCount: 3 },
      { words: ['и', 'экономит', '35%', 'токенов'], ttsCount: 6 },
      { words: ['прямо', 'в', 'живой', 'панели!'], ttsCount: 4 },
    ],
  },
  {
    id: 's3',
    rate: '+18%',
    ttsText: 'Строит карту проекта в оперативке: клик по файлу — видно волну влияния, горячие точки и граф вызовов.',
    displayGroups: [
      { words: ['Строит', 'карту', 'проекта'], ttsCount: 3 },
      { words: ['в', 'оперативке:', 'клик'], ttsCount: 3 },
      { words: ['по', 'файлу', '—', 'видно'], ttsCount: 3 },
      { words: ['волну', 'влияния,', 'горячие', 'точки'], ttsCount: 4 },
      { words: ['и', 'граф', 'вызовов!'], ttsCount: 3 },
    ],
  },
  {
    id: 's4',
    rate: '+18%',
    ttsText: 'Срезы кода за миллисекунду, ноль облачных токенов на видеокарте и пятьдесят девять защит на каждый шаг.',
    displayGroups: [
      { words: ['Срезы', 'кода', 'за', 'миллисекунду,'], ttsCount: 4 },
      { words: ['0', 'облачных', 'токенов'], ttsCount: 3 },
      { words: ['на', 'видеокарте'], ttsCount: 2 },
      { words: ['и', '59', 'защит'], ttsCount: 4 },
      { words: ['на', 'каждый', 'шаг!'], ttsCount: 3 },
    ],
  },
  {
    id: 's5',
    rate: '+14%',
    ttsText: 'Зэ Таннел для Антигравити — ставится в один клик на любую систему. Ссылка в описании!',
    displayGroups: [
      { words: ['The', 'Tunnel', 'для', 'Antigravity'], ttsCount: 4 },
      { words: ['ставится', 'в', '1', 'клик'], ttsCount: 4 },
      { words: ['на', 'любую', 'ОС!'], ttsCount: 3 },
      { words: ['Ссылка', 'в', 'описании', '↓'], ttsCount: 3 },
    ],
  },
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
    `--window-size=${WIDTH},${HEIGHT}`,
    '--force-color-profile=srgb',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  const { cdpPort } = await new Promise((resolveUrl, rejectUrl) => {
    let logs = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; rejectUrl(new Error('CDP timeout')); } }, 15000);
    proc.once('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); rejectUrl(err); }
    });
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
  if (!pageWsUrl) {
    killBrowser(proc);
    throw new Error('No CDP page target found');
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
    let msg = null;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
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

/**
 * Custom tactile microswitch mouse click & mechanical key tap synthesizers.
 */
function synthesizeTactileClick(seed = 1) {
  const n = Math.floor(0.065 * SAMPLE_RATE);
  const out = new Float64Array(n);
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
  let ph1 = 0;
  let ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Primary microswitch click at t=0
    ph1 += (2 * Math.PI * (2900 * Math.exp(-t * 140) + 680)) / SAMPLE_RATE;
    const press = (Math.sin(ph1) * 0.65 + rand() * 0.35) * Math.exp(-t * 130);
    // Subtle spring release click at t=22ms
    let rel = 0;
    if (t >= 0.022) {
      const dt = t - 0.022;
      ph2 += (2 * Math.PI * (2100 * Math.exp(-dt * 120) + 520)) / SAMPLE_RATE;
      rel = (Math.sin(ph2) * 0.5 + rand() * 0.25) * Math.exp(-dt * 150) * 0.55;
    }
    out[i] = Math.max(-0.95, Math.min(0.95, (press + rel) * 0.92));
  }
  return out;
}

function synthesizeKeyTap(seed = 1) {
  const n = Math.floor(0.045 * SAMPLE_RATE);
  const out = new Float64Array(n);
  let state = (seed * 7919) >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296) * 2 - 1;
  };
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    ph += (2 * Math.PI * (1450 * Math.exp(-t * 110) + 290)) / SAMPLE_RATE;
    out[i] = Math.max(-0.9, Math.min(0.9, (Math.sin(ph) * 0.6 + rand() * 0.32) * Math.exp(-t * 115) * 0.78));
  }
  return out;
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
  for (let i = 0; i < count; i++) arr[i] = wavBuf.readInt16LE(dataOffset + i * 2) / 32768;
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
 * Aligns TTS WordBoundary timestamps to our clean display caption groups.
 */
function buildSubtitleTimeline(alignedSegments) {
  const groups = [];
  for (const seg of alignedSegments) {
    const rawWords = Array.isArray(seg.words) ? seg.words : [];
    const segStartMs = Math.round(seg.startSec * 1000);
    const segDurMs = Math.round(seg.durationSec * 1000);
    const totalTtsTokens = seg.displayGroups.reduce((s, g) => s + g.ttsCount, 0) || 1;
    let ttsIdx = 0;

    for (let gi = 0; gi < seg.displayGroups.length; gi++) {
      const grp = seg.displayGroups[gi];
      const startTok = ttsIdx;
      const endTok = Math.min(rawWords.length - 1, ttsIdx + grp.ttsCount - 1);
      ttsIdx += grp.ttsCount;

      let gStartMs;
      let gEndMs;
      if (rawWords.length > 0 && startTok < rawWords.length) {
        const wFirst = rawWords[startTok];
        const wLast = rawWords[Math.max(startTok, endTok)];
        gStartMs = segStartMs + wFirst.offsetMs;
        gEndMs = segStartMs + wLast.offsetMs + Math.max(120, wLast.durationMs);
      } else {
        gStartMs = segStartMs + Math.round((startTok / totalTtsTokens) * segDurMs);
        gEndMs = segStartMs + Math.round((ttsIdx / totalTtsTokens) * segDurMs);
      }
      if (gEndMs <= gStartMs) gEndMs = gStartMs + 220;

      // Distribute display words evenly or from matching TTS boundaries inside group
      const dispCount = grp.words.length;
      const wordEntries = [];
      for (let wi = 0; wi < dispCount; wi++) {
        const subStart = gStartMs + Math.round((wi / dispCount) * (gEndMs - gStartMs));
        const subEnd = gStartMs + Math.round(((wi + 1) / dispCount) * (gEndMs - gStartMs));
        wordEntries.push({ text: grp.words[wi], startMs: subStart, endMs: subEnd });
      }
      groups.push({
        segId: seg.id,
        startMs: Math.max(0, gStartMs - 40),
        endMs: gEndMs + 90,
        words: wordEntries,
      });
    }
  }
  // Ensure contiguous non-overlapping display windows inside each segment
  for (let i = 0; i < groups.length - 1; i++) {
    if (groups[i].endMs > groups[i + 1].startMs) {
      groups[i].endMs = groups[i + 1].startMs;
    }
  }
  return groups;
}

/**
 * Decodes voice segments into 48kHz PCM, applies speech presence EQ + tempo calibration,
 * builds a sidechain-ducked 116 BPM cyber-tech bed, and layers 30+ frame-locked SFX cues.
 */
function buildMasterAudioWav({ alignedSegments, sfxCues, tmpDir, outWavPath }) {
  const totalSamples = Math.round(DURATION_SEC * SAMPLE_RATE);
  const voiceTrack = new Float64Array(totalSamples);

  for (const seg of alignedSegments) {
    const cleanWav = path.join(tmpDir, `${seg.id}-48k.wav`);
    const filters = [
      `atrim=start=${seg.trimStartSec.toFixed(3)}:end=${seg.trimEndSec.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      ...(Math.abs(seg.atempo - 1.0) > 0.005 ? [`atempo=${seg.atempo.toFixed(4)}`] : []),
      'highpass=f=85',
      'equalizer=f=3100:t=q:w=1.2:g=2.8',
      'acompressor=threshold=-18dB:ratio=3.2:attack=8:release=70:makeup=3dB',
      'aresample=48000',
    ].join(',');
    execFileSync('ffmpeg', [
      '-y', '-i', seg.audioPath,
      '-af', filters,
      '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
      cleanWav,
    ], { stdio: 'ignore', windowsHide: true });

    const samples = decodeMonoWavSamples(fs.readFileSync(cleanWav));
    const startSample = Math.max(0, Math.round(seg.startSec * SAMPLE_RATE));
    for (let i = 0; i < samples.length && startSample + i < totalSamples; i++) {
      voiceTrack[startSample + i] += samples[i] * 1.18;
    }
  }

  // Envelope follower on voiceTrack for smooth musical sidechain ducking
  const voiceEnv = new Float64Array(totalSamples);
  let env = 0;
  for (let i = 0; i < totalSamples; i++) {
    const a = Math.abs(voiceTrack[i]);
    const coeff = a > env ? 0.0045 : 0.00018; // fast attack (~5ms), smooth release (~120ms)
    env += coeff * (a - env);
    voiceEnv[i] = env;
  }

  // Layer 2: Procedural 116 BPM D-minor tech-pulse music bed
  const left = new Float64Array(totalSamples);
  const right = new Float64Array(totalSamples);
  const bpm = 116;
  const beatDur = 60 / bpm;
  const chordRoots = [73.42, 87.31, 65.41, 55.0, 73.42]; // D2, F2, C2, A1, D2
  const arpIntervals = [4, 6, 8, 12, 8, 6]; // octave/fifth pulse
  let prng = 0x73f19a2d;
  const nextRand = () => {
    prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
    return prng / 4294967296;
  };

  let bassPh = 0;
  let kickPh = 0;
  let arpPh = 0;
  let padPhA = 0;
  let padPhB = 0;
  let lpL = 0;
  let lpR = 0;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    const masterEnv = Math.min(1, t / 0.25) * (t > DURATION_SEC - 0.7 ? Math.max(0, (DURATION_SEC - t) / 0.7) : 1);
    const beatPos = (t % beatDur) / beatDur;
    const step16 = Math.floor(t / (beatDur / 4));
    const stepPos = (t % (beatDur / 4)) / (beatDur / 4);

    // Pick chord root by chapter timing
    let secIdx = 0;
    for (let k = 0; k < alignedSegments.length; k++) {
      if (t >= alignedSegments[k].startSec) secIdx = k;
    }
    const rootHz = chordRoots[secIdx % chordRoots.length];

    // Tight punchy kick on every beat
    const kickFreq = 135 * Math.exp(-beatPos * 18) + 46;
    kickPh += (2 * Math.PI * kickFreq) / SAMPLE_RATE;
    const kick = Math.sin(kickPh) * Math.exp(-beatPos * 10) * 0.17;

    // Sidechained sub-bass + stereo fifth pad
    const beatDuck = Math.min(1, 0.28 + beatPos * 1.45);
    bassPh += (2 * Math.PI * rootHz) / SAMPLE_RATE;
    const sub = (Math.sin(bassPh) * 0.75 + Math.sin(bassPh * 2) * 0.18) * 0.13 * beatDuck;

    padPhA += (2 * Math.PI * rootHz * 2.0) / SAMPLE_RATE;
    padPhB += (2 * Math.PI * rootHz * 3.0) / SAMPLE_RATE;
    const padL = (Math.sin(padPhA) * 0.55 + Math.sin(padPhB + 0.35) * 0.4) * 0.065 * beatDuck;
    const padR = (Math.sin(padPhA + 0.25) * 0.55 + Math.sin(padPhB - 0.35) * 0.4) * 0.065 * beatDuck;

    // 16th-note gentle tech arpeggio pluck
    const arpMul = arpIntervals[step16 % arpIntervals.length];
    arpPh += (2 * Math.PI * rootHz * arpMul) / SAMPLE_RATE;
    const arpEnv = Math.exp(-stepPos * 7.5);
    const arp = Math.sin(arpPh) * arpEnv * 0.042;
    const arpPan = ((step16 % 4) - 1.5) * 0.22;

    // Crisp hi-hat tick on off-beats
    const hatEnv = stepPos < 0.08 ? Math.exp(-stepPos * 85) : 0;
    const hatAcc = step16 % 4 === 2 ? 1.5 : 0.55;
    const hat = (nextRand() * 2 - 1) * hatEnv * 0.032 * hatAcc;

    lpL += 0.22 * ((sub + padL + kick) - lpL);
    lpR += 0.22 * ((sub + padR + kick) - lpR);

    const musicL = lpL + arp * (1 - Math.max(0, arpPan)) + hat * 0.85;
    const musicR = lpR + arp * (1 + Math.min(0, arpPan)) + hat * 1.15;

    // Duck music cleanly when voice is active (-10dB duck at speech peaks)
    const duckGain = Math.max(0.28, 1.0 - Math.min(0.72, voiceEnv[i] * 6.5));
    left[i] = (musicL * duckGain + voiceTrack[i] * 0.96) * masterEnv;
    right[i] = (musicR * duckGain + voiceTrack[i] * 0.96) * masterEnv;
  }

  // Layer 3: Frame-locked SFX cues (clicks, key taps, transitions, blast wave, chimes)
  for (let idx = 0; idx < sfxCues.length; idx++) {
    const cue = sfxCues[idx];
    let samples;
    if (cue.kind === 'mouse_click') {
      samples = synthesizeTactileClick(idx + 11);
    } else if (cue.kind === 'key_tap') {
      samples = synthesizeKeyTap(idx + 31);
    } else {
      const wavBuf = synthesizeProceduralWavBuffer(cue.kind, { seed: idx + 19, sampleRate: SAMPLE_RATE });
      samples = decodeMonoWavSamples(wavBuf);
    }
    const startSample = Math.max(0, Math.round(cue.timeSec * SAMPLE_RATE));
    const pan = ((idx % 5) - 2) * 0.13;
    const gainBase = cue.gain || 0.55;
    const gL = gainBase * (1 - Math.max(0, pan)) * 0.62;
    const gR = gainBase * (1 + Math.min(0, pan)) * 0.62;
    for (let j = 0; j < samples.length && startSample + j < totalSamples; j++) {
      left[startSample + j] += samples[j] * gL;
      right[startSample + j] += samples[j] * gR;
    }
  }

  // Soft-knee limiter + peak headroom
  let peak = 0;
  for (let i = 0; i < totalSamples; i++) {
    left[i] = Math.tanh(left[i] * 1.08);
    right[i] = Math.tanh(right[i] * 1.08);
    const a = Math.max(Math.abs(left[i]), Math.abs(right[i]));
    if (a > peak) peak = a;
  }
  const scale = peak > 0.85 ? 0.85 / peak : 1;
  for (let i = 0; i < totalSamples; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }

  const stereoWav = encodeStereoPcm16Wav(left, right, SAMPLE_RATE);
  fs.writeFileSync(outWavPath, stereoWav);
  return analyzeWavBufferAcousticMetrics(stereoWav);
}

function buildShortsHtml({ version, chapters, subtitles, clips, sfxCues }) {
  const pad4 = (n) => String(Math.max(1, n)).padStart(4, '0');
  const mapFiles = clips.map?.filesMeta || { fileNodes: 188, fileEdges: 419 };

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>The Tunnel v${version} — Вертикальный обзор (Shorts / Reels 25s)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%; overflow: hidden;
      background: #06070a; color: #f3f4f6;
      font-family: system-ui, -apple-system, 'Segoe UI', Inter, Roboto, sans-serif;
      user-select: none;
    }
    body.capture-mode { width: 1080px; height: 1920px; }
    body.capture-mode .controls-dock { display: none !important; }
    body.capture-mode .viewport-wrap { display: block; width: 1080px; height: 1920px; }

    .viewport-wrap {
      width: 100vw; height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; background: #040507;
    }
    .stage-shell {
      position: relative; width: 1080px; height: 1920px;
      background: radial-gradient(circle at 50% 24%, #181116 0%, #090a0e 52%, #06070a 100%);
      overflow: hidden; transform-origin: center center;
    }
    .bg-grid {
      position: absolute; inset: 0; pointer-events: none;
      background-image:
        linear-gradient(to right, rgba(255,255,255,0.036) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(255,255,255,0.036) 1px, transparent 1px);
      background-size: 72px 72px;
    }
    .bg-glow-top {
      position: absolute; left: 50%; top: 180px; width: 780px; height: 780px;
      transform: translate(-50%, -50%); pointer-events: none;
      background: radial-gradient(circle, rgba(240,72,72,0.16) 0%, rgba(240,72,72,0.0) 68%);
    }

    /* Top Stories-Style 5-Segment Progress + Brand Header (Safe Top Margin >= 46px) */
    .top-hud {
      position: absolute; top: 36px; left: 42px; right: 42px; z-index: 40;
      display: flex; flex-direction: column; gap: 16px;
    }
    .stories-bars { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; height: 6px; }
    .story-seg { background: rgba(255,255,255,0.14); border-radius: 4px; overflow: hidden; }
    .story-fill { height: 100%; width: 100%; background: #f04848; transform-origin: left center; transform: scaleX(0); }
    .brand-bar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 18px; border-radius: 12px;
      background: rgba(14,16,22,0.88); border: 1px solid rgba(255,255,255,0.1);
    }
    .brand-left { display: flex; align-items: center; gap: 12px; font: 800 22px ui-monospace, Consolas, monospace; letter-spacing: 0.6px; }
    .brand-left span { color: #f04848; }
    .brand-right {
      display: flex; align-items: center; gap: 10px;
      font: 700 18px ui-monospace, Consolas, monospace; color: #d1d5db;
    }
    .live-dot { width: 10px; height: 10px; border-radius: 50%; background: #3fb950; }

    /* Transition crimson scanner bar */
    .scan-wipe {
      position: absolute; left: 0; right: 0; top: 0; height: 6px; z-index: 45;
      background: linear-gradient(90deg, transparent, #f04848, #ff9b9b, #f04848, transparent);
      opacity: 0; pointer-events: none; transform: translateY(0);
    }

    /* Scene Container inside Safe Reels/Shorts Content Box (y: 155..1355) */
    .scene {
      position: absolute; left: 42px; right: 42px; top: 162px; bottom: 560px;
      opacity: 0; pointer-events: none;
      display: flex; flex-direction: column;
    }

    /* Typography helpers */
    .kicker {
      display: inline-flex; align-items: center; gap: 10px; align-self: flex-start;
      padding: 7px 16px; border-radius: 999px;
      background: rgba(240,72,72,0.14); border: 1px solid rgba(240,72,72,0.45);
      font: 700 19px ui-monospace, Consolas, monospace; color: #ff6b6b; letter-spacing: 0.8px;
      text-transform: uppercase;
    }
    .h1-big {
      font-size: 74px; font-weight: 900; line-height: 1.04; letter-spacing: -2px; color: #ffffff;
    }
    .h1-big span { color: #f04848; }
    .h2-title {
      font-size: 48px; font-weight: 850; line-height: 1.1; letter-spacing: -1.1px; color: #f9fafb;
    }
    .h2-title span { color: #f04848; }
    .sub-lead { font-size: 28px; font-weight: 500; line-height: 1.3; color: #b7c0ce; }

    /* SCENE 1: HOOK */
    .s1-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 28px; }
    .emblem-wrap { position: relative; width: 220px; height: 220px; display: flex; align-items: center; justify-content: center; }
    .emblem-ring {
      position: absolute; inset: 0; border-radius: 50%;
      border: 2px solid rgba(240,72,72,0.45);
    }
    .s1-cards { width: 100%; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 12px; }
    .s1-card {
      background: rgba(16,18,24,0.94); border: 1px solid #2b2f3b; border-radius: 16px;
      padding: 24px 16px; text-align: center; display: flex; flex-direction: column; gap: 8px;
    }
    .s1-card strong { font: 800 50px ui-monospace, Consolas, monospace; color: var(--c, #f04848); font-variant-numeric: tabular-nums; }
    .s1-card span { font-size: 21px; font-weight: 600; color: #d1d5db; }

    /* SCENE 2: 3D TENSOR + LIVE RUSSIAN COCKPIT */
    .s2-wrap { flex: 1; display: flex; flex-direction: column; gap: 20px; min-height: 0; }
    .tensor-strip {
      background: rgba(14,16,22,0.95); border: 1px solid #2b2f3a; border-radius: 16px;
      padding: 18px 22px; display: flex; flex-direction: column; gap: 14px;
    }
    .tensor-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .tensor-top b { font: 700 20px ui-monospace, Consolas, monospace; color: #f3f4f6; }
    .tensor-badge {
      padding: 6px 14px; border-radius: 8px; background: #261317; border: 1px solid #f04848;
      font: 700 18px ui-monospace, Consolas, monospace; color: #ff6b6b;
    }
    .axes-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
    .ax-box { display: flex; flex-direction: column; gap: 6px; }
    .ax-lbl { display: flex; justify-content: space-between; font: 700 16px ui-monospace, Consolas, monospace; color: #9ca3af; }
    .ax-lbl em { font-style: normal; color: #f3f4f6; }
    .ax-track { height: 10px; border-radius: 6px; background: #090b0f; overflow: hidden; border: 1px solid #252834; }
    .ax-fill { height: 100%; transform-origin: left center; transform: scaleX(0); }

    .device-frame {
      flex: 1; min-height: 0; background: #0c0d12; border: 1.5px solid #2e3240; border-radius: 18px;
      overflow: hidden; display: flex; flex-direction: column; position: relative;
      box-shadow: 0 24px 60px rgba(0,0,0,0.55);
    }
    .device-bar {
      height: 50px; padding: 0 20px; background: #13151c; border-bottom: 1px solid rgba(255,255,255,0.08);
      display: flex; align-items: center; justify-content: space-between; flex: none;
    }
    .dots-3 { display: flex; gap: 8px; }
    .dots-3 i { width: 12px; height: 12px; border-radius: 50%; display: block; background: #363b48; }
    .dots-3 i:first-child { background: #f04848; }
    .device-bar b { font: 700 18px ui-monospace, Consolas, monospace; color: #e5e7eb; }
    .device-bar span { font: 700 17px ui-monospace, Consolas, monospace; color: #f04848; }
    .device-body {
      flex: 1; min-height: 0; background: #08090c; padding: 10px;
      display: flex; align-items: center; justify-content: center; overflow: hidden;
    }
    .device-body img { width: 100%; height: 100%; object-fit: contain; border-radius: 10px; display: block; }

    /* SCENE 3: LIVE RUSSIAN WEBGL2 PROJECT MAP */
    .s3-wrap { flex: 1; display: flex; flex-direction: column; gap: 18px; min-height: 0; }
    .lens-pills { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .lens-pill {
      padding: 12px 10px; border-radius: 10px; text-align: center;
      background: #12141b; border: 1px solid #2b2f3a;
      font: 700 17px system-ui, sans-serif; color: #9ca3af;
    }
    .lens-pill.active { background: #261317; border-color: #f04848; color: #ffffff; }
    .map-hud-foot {
      position: absolute; left: 22px; right: 22px; bottom: 20px; z-index: 5;
      padding: 12px 18px; border-radius: 12px;
      background: rgba(10,11,15,0.92); border: 1px solid rgba(240,72,72,0.55);
      display: flex; justify-content: space-between; align-items: center;
    }
    .map-hud-foot strong { font: 700 20px ui-monospace, Consolas, monospace; color: #ffffff; }
    .map-hud-foot span { font: 700 18px ui-monospace, Consolas, monospace; color: #3fb950; }

    /* SCENE 4: LOCAL STACK + 59 GUARDRAILS */
    .s4-wrap { flex: 1; display: flex; flex-direction: column; gap: 18px; justify-content: center; }
    .stack-list { display: flex; flex-direction: column; gap: 16px; }
    .stack-row {
      background: rgba(16,18,24,0.95); border: 1px solid #2b2f3a; border-radius: 16px;
      padding: 22px 26px; display: flex; align-items: center; justify-content: space-between; gap: 18px;
      position: relative; overflow: hidden;
    }
    .stack-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 6px; background: var(--bar, #f04848); }
    .stack-info { display: flex; flex-direction: column; gap: 6px; }
    .stack-kicker { font: 700 17px ui-monospace, Consolas, monospace; color: var(--bar, #f04848); letter-spacing: 0.7px; }
    .stack-name { font-size: 32px; font-weight: 800; color: #ffffff; }
    .stack-sub { font-size: 21px; color: #a7b0be; }
    .stack-val {
      font: 800 34px ui-monospace, Consolas, monospace; color: #ffffff;
      padding: 12px 18px; border-radius: 12px; background: #0a0b0f; border: 1px solid #2b2f3a;
      white-space: nowrap; flex: none;
    }

    /* SCENE 5: OUTRO / CTA */
    .s5-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 24px; }
    .os-pills { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
    .os-pill {
      padding: 12px 22px; border-radius: 10px; background: #13151c; border: 1px solid #2f3442;
      font: 700 22px ui-monospace, Consolas, monospace; color: #e5e7eb;
    }
    .cmd-box {
      width: 100%; padding: 24px 28px; border-radius: 16px;
      background: #101218; border: 2px solid #f04848;
      font: 700 30px ui-monospace, Consolas, monospace; color: #ffffff;
    }
    .cmd-box span { color: #f04848; }
    .cta-pill {
      margin-top: 8px; padding: 20px 38px; border-radius: 999px;
      background: #f04848; color: #ffffff;
      font-size: 32px; font-weight: 850; letter-spacing: -0.3px;
      box-shadow: 0 12px 36px rgba(240,72,72,0.45);
    }

    /* KARAOKE SUBTITLES IN SAFE REELS/SHORTS ZONE (y: 1390..1585, well clear of bottom UI) */
    .subtitles-dock {
      position: absolute; left: 54px; right: 54px; top: 1395px; height: 185px; z-index: 50;
      display: flex; align-items: center; justify-content: center; pointer-events: none;
    }
    .sub-pill {
      display: inline-flex; flex-wrap: wrap; justify-content: center; align-items: center;
      gap: 10px 14px; padding: 18px 28px; border-radius: 22px;
      background: rgba(8, 9, 13, 0.92); border: 1.5px solid rgba(255,255,255,0.16);
      box-shadow: 0 18px 44px rgba(0,0,0,0.68);
      text-align: center;
    }
    .sub-word {
      font-size: 48px; font-weight: 850; line-height: 1.18; letter-spacing: -0.5px;
      color: #b8c1cf; padding: 3px 10px; border-radius: 10px;
      transform-origin: center center;
    }
    .sub-word.spoken { color: #f3f4f6; }
    .sub-word.active {
      color: #ffffff; background: #f04848; transform: scale(1.07);
    }

    /* Bottom safe-zone subtle watermark above platform UI */
    .safe-foot {
      position: absolute; left: 42px; right: 42px; bottom: 265px; z-index: 30;
      display: flex; justify-content: space-between; align-items: center;
      font: 600 18px ui-monospace, Consolas, monospace; color: rgba(209,213,219,0.52);
    }

    /* Interactive Controls Dock (browser preview only, hidden during capture) */
    .controls-dock {
      position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); z-index: 100;
      background: rgba(15, 16, 20, 0.94); border: 1px solid #2e323c; border-radius: 10px;
      padding: 10px 14px; display: flex; align-items: center; gap: 10px;
    }
    .ctl-btn {
      background: #181a20; border: 1px solid #303440; color: #f3f4f6; border-radius: 6px;
      padding: 6px 12px; font: 600 12px ui-monospace, Consolas, monospace; cursor: pointer;
    }
    .ctl-btn.primary { background: #f04848; border-color: #f04848; }
    .ctl-scrub { width: 200px; accent-color: #f04848; }
    .ctl-time { font: 700 12px ui-monospace, Consolas, monospace; color: #9ca3af; min-width: 90px; text-align: center; }
  </style>
</head>
<body>
  <div class="viewport-wrap">
    <div id="root" class="stage-shell" data-composition-id="the-tunnel-shorts-ru" data-start="0" data-duration="${DURATION_SEC}" data-width="${WIDTH}" data-height="${HEIGHT}">
      <div class="bg-grid"></div>
      <div class="bg-glow-top"></div>
      <div class="scan-wipe" id="scanWipe"></div>

      <!-- Top Stories Progress & Brand Bar -->
      <div class="top-hud">
        <div class="stories-bars">
          <div class="story-seg"><div class="story-fill" id="storyFill0"></div></div>
          <div class="story-seg"><div class="story-fill" id="storyFill1"></div></div>
          <div class="story-seg"><div class="story-fill" id="storyFill2"></div></div>
          <div class="story-seg"><div class="story-fill" id="storyFill3"></div></div>
          <div class="story-seg"><div class="story-fill" id="storyFill4"></div></div>
        </div>
        <div class="brand-bar">
          <div class="brand-left">
            <svg width="28" height="28" viewBox="0 0 128 128" aria-hidden="true">
              <rect x="10" y="10" width="108" height="108" rx="20" fill="#0d0e12" stroke="#2a2d35" stroke-width="5"/>
              <line x1="22" y1="64" x2="43" y2="64" stroke="#9ca3af" stroke-width="7" stroke-linecap="round"/>
              <line x1="85" y1="64" x2="106" y2="64" stroke="#9ca3af" stroke-width="7" stroke-linecap="round"/>
              <path d="M64 36 L90 64 L64 92 L38 64 Z" fill="#181215" stroke="#f04848" stroke-width="7" stroke-linejoin="round"/>
              <path d="M64 51 L75 64 L64 77 L53 64 Z" fill="#f04848"/>
            </svg>
            <div>THE TUNNEL <span>v${version}</span></div>
          </div>
          <div class="brand-right">
            <span class="live-dot"></span>
            <span id="hudChapterName">01 · АВТОПИЛОТ</span>
          </div>
        </div>
      </div>

      <!-- SCENE 1: HOOK -->
      <section class="scene" id="scene0" data-start="${chapters[0].start.toFixed(2)}" data-duration="${(chapters[0].end - chapters[0].start).toFixed(2)}">
        <div class="s1-wrap">
          <div class="emblem-wrap" id="s1Emblem">
            <div class="emblem-ring" id="s1Ring"></div>
            <svg width="164" height="164" viewBox="0 0 128 128">
              <rect x="8" y="8" width="112" height="112" rx="24" fill="#111319" stroke="#2f3340" stroke-width="3.5"/>
              <line x1="20" y1="64" x2="42" y2="64" stroke="#9ca3af" stroke-width="6" stroke-linecap="round"/>
              <line x1="86" y1="64" x2="108" y2="64" stroke="#9ca3af" stroke-width="6" stroke-linecap="round"/>
              <path d="M64 34 L92 64 L64 94 L36 64 Z" fill="#1f1115" stroke="#f04848" stroke-width="6" stroke-linejoin="round"/>
              <path d="M64 50 L76 64 L64 78 L52 64 Z" fill="#f04848"/>
              <circle cx="64" cy="64" r="4" fill="#ffffff"/>
            </svg>
          </div>
          <div class="kicker">Google Antigravity · Плагин</div>
          <h1 class="h1-big" id="s1Title">А ВЫ ЗНАЛИ?<span><br/>The Tunnel</span></h1>
          <p class="sub-lead" id="s1Sub">Инженерный 3D-автопилот<br/>и локальный сопроцессор в IDE</p>
          <div class="s1-cards" id="s1Cards">
            <div class="s1-card" style="--c:#f04848;"><strong>59</strong><span>Защит канона</span></div>
            <div class="s1-card" style="--c:#3fb950;"><strong>−35%</strong><span>Расход токенов</span></div>
            <div class="s1-card" style="--c:#e09f3e;"><strong>0</strong><span>Зависимостей</span></div>
          </div>
        </div>
      </section>

      <!-- SCENE 2: 3D TENSOR + LIVE RUSSIAN COCKPIT -->
      <section class="scene" id="scene1" data-start="${chapters[1].start.toFixed(2)}" data-duration="${(chapters[1].end - chapters[1].start).toFixed(2)}">
        <div class="s2-wrap">
          <div class="kicker">3D-роутинг моделей · Умная панель</div>
          <h2 class="h2-title">Точная модель <span>под каждую задачу</span></h2>
          <div class="tensor-strip">
            <div class="tensor-top">
              <b>Тензор 3D: Ширина × Глубина × Риск</b>
              <span class="tensor-badge">Orchestrator · Neon High</span>
            </div>
            <div class="axes-grid">
              <div class="ax-box">
                <div class="ax-lbl"><span>Ширина</span><em>4+ файла</em></div>
                <div class="ax-track"><div class="ax-fill" id="axFill0" style="background:#f04848;"></div></div>
              </div>
              <div class="ax-box">
                <div class="ax-lbl"><span>Глубина</span><em>Архитектура</em></div>
                <div class="ax-track"><div class="ax-fill" id="axFill1" style="background:#e09f3e;"></div></div>
              </div>
              <div class="ax-box">
                <div class="ax-lbl"><span>Экономия</span><em>−35%</em></div>
                <div class="ax-track"><div class="ax-fill" id="axFill2" style="background:#3fb950;"></div></div>
              </div>
            </div>
          </div>
          <div class="device-frame" id="cockpitDevice">
            <div class="device-bar">
              <div class="dots-3"><i></i><i></i><i></i></div>
              <b>Панель управления · RU</b>
              <span id="cockpitPhaseBadge">УМНЫЙ ВВОД @FILE</span>
            </div>
            <div class="device-body">
              <img id="cockpitLiveImg" src="/shorts-ru-frames/cockpit/frame-0001.png" alt="Живая панель управления The Tunnel" />
            </div>
          </div>
        </div>
      </section>

      <!-- SCENE 3: LIVE RUSSIAN WEBGL2 PROJECT MAP -->
      <section class="scene" id="scene2" data-start="${chapters[2].start.toFixed(2)}" data-duration="${(chapters[2].end - chapters[2].start).toFixed(2)}">
        <div class="s3-wrap">
          <div class="kicker">Интерактивная карта проекта · WebGL2</div>
          <h2 class="h2-title">Волна влияния <span>и граф вызовов</span></h2>
          <div class="lens-pills">
            <div class="lens-pill active" id="mapLens0">Архитектура</div>
            <div class="lens-pill" id="mapLens1">Волна Blast</div>
            <div class="lens-pill" id="mapLens2">Hotspots</div>
            <div class="lens-pill" id="mapLens3">AST-символы</div>
          </div>
          <div class="device-frame" id="mapDevice">
            <div class="device-bar">
              <div class="dots-3"><i></i><i></i><i></i></div>
              <b>Карта проекта в ОЗУ</b>
              <span>${mapFiles.fileNodes} файлов · ${mapFiles.fileEdges} связей</span>
            </div>
            <div class="device-body" style="padding:4px;">
              <img id="mapLiveImg" src="/shorts-ru-frames/map/frame-0001.png" alt="Интерактивная карта проекта The Tunnel" />
            </div>
            <div class="map-hud-foot">
              <strong id="mapFootMode">Папки → Файлы · Плавный зум</strong>
              <span>WebGL2 · ОЗУ</span>
            </div>
          </div>
        </div>
      </section>

      <!-- SCENE 4: LOCAL STACK (RAM + CPU + GPU + 59 GUARDRAILS) -->
      <section class="scene" id="scene3" data-start="${chapters[3].start.toFixed(2)}" data-duration="${(chapters[3].end - chapters[3].start).toFixed(2)}">
        <div class="s4-wrap">
          <div class="kicker">Локальное ускорение · Безопасность</div>
          <h2 class="h2-title">Быстро в ОЗУ, <span>0 токенов на GPU</span></h2>
          <div class="stack-list">
            <div class="stack-row" id="stackCard0" style="--bar:#f04848;">
              <div class="stack-info">
                <div class="stack-kicker">IN-RAM MCP · 4–32 ГБ</div>
                <div class="stack-name">Срезы и поиск по коду</div>
                <div class="stack-sub">239 файлов проекта прямо в оперативке</div>
              </div>
              <div class="stack-val">0.86 мс</div>
            </div>
            <div class="stack-row" id="stackCard1" style="--bar:#e09f3e;">
              <div class="stack-info">
                <div class="stack-kicker">OLLAMA GPU · i8bin-v2</div>
                <div class="stack-name">Сжатие логов и аудит UI</div>
                <div class="stack-sub">gemma4:12b + qwen3-embedding локально</div>
              </div>
              <div class="stack-val">0 токенов</div>
            </div>
            <div class="stack-row" id="stackCard2" style="--bar:#3fb950;">
              <div class="stack-info">
                <div class="stack-kicker">CPU-ПУЛ ПОТОКОВ</div>
                <div class="stack-name">Реранкер и TOON-сжатие</div>
                <div class="stack-sub">RU↔EN поиск без нагрузки на видеокарту</div>
              </div>
              <div class="stack-val">−35%</div>
            </div>
            <div class="stack-row" id="stackCard3" style="--bar:#9ca3af;">
              <div class="stack-info">
                <div class="stack-kicker">МАШИНА ВРЕМЕНИ И СТРАХОВКА</div>
                <div class="stack-name">Откат шага и Git-песочницы</div>
                <div class="stack-sub">AgentShield, Wiretap и 56 наборов тестов</div>
              </div>
              <div class="stack-val">59 защит</div>
            </div>
          </div>
        </div>
      </section>

      <!-- SCENE 5: OUTRO / CTA -->
      <section class="scene" id="scene4" data-start="${chapters[4].start.toFixed(2)}" data-duration="${(chapters[4].end - chapters[4].start).toFixed(2)}">
        <div class="s5-wrap">
          <svg width="150" height="150" viewBox="0 0 128 128" id="s5Logo">
            <rect x="8" y="8" width="112" height="112" rx="24" fill="#111319" stroke="#2f3340" stroke-width="3.5"/>
            <line x1="20" y1="64" x2="42" y2="64" stroke="#9ca3af" stroke-width="6" stroke-linecap="round"/>
            <line x1="86" y1="64" x2="108" y2="64" stroke="#9ca3af" stroke-width="6" stroke-linecap="round"/>
            <path d="M64 34 L92 64 L64 94 L36 64 Z" fill="#1f1115" stroke="#f04848" stroke-width="6" stroke-linejoin="round"/>
            <path d="M64 50 L76 64 L64 78 L52 64 Z" fill="#f04848"/>
          </svg>
          <div class="kicker">Бесплатно · Открытый код</div>
          <h2 class="h1-big" style="font-size:68px;">The Tunnel <span>v${version}</span></h2>
          <p class="sub-lead">Установка в один клик на любую ОС</p>
          <div class="os-pills">
            <div class="os-pill">Windows · Setup.exe</div>
            <div class="os-pill">macOS</div>
            <div class="os-pill">Linux</div>
          </div>
          <div class="cmd-box"><span>$</span> node install.js</div>
          <div class="cta-pill" id="ctaPill">Ссылка в описании ↓</div>
        </div>
      </section>

      <!-- Karaoke Subtitles Dock (Safe Vertical Zone) -->
      <div class="subtitles-dock">
        <div class="sub-pill" id="subPill"></div>
      </div>

      <div class="safe-foot">
        <span>github.com/vaszuevvas-coder/antigravity-model-router</span>
        <span id="hudClock">00.0 / 25.0s</span>
      </div>
    </div>
  </div>

  <div class="controls-dock" id="controlsDock">
    <button type="button" class="ctl-btn primary" id="btnPlayPause">▶ Play</button>
    <input type="range" class="ctl-scrub" id="timeScrub" min="0" max="25" step="0.04" value="0" />
    <span class="ctl-time" id="ctlTime">00.0 / 25.0s</span>
  </div>

  <script>
    (function () {
      const DURATION = ${DURATION_SEC};
      const CHAPTERS = ${JSON.stringify(chapters)};
      const SUBTITLES = ${JSON.stringify(subtitles)};
      const CLIPS = ${JSON.stringify({
        cockpitCount: clips.cockpit.frameCount,
        cockpitMilestones: clips.cockpit.milestones,
        mapCount: clips.map.frameCount,
        mapMilestones: clips.map.milestones,
      })};

      const isCapture = new URLSearchParams(location.search).get('capture') === '1';
      if (isCapture) document.body.classList.add('capture-mode');

      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
      const norm = (t, a, b) => easeOut((t - a) / Math.max(0.001, b - a));
      const pad4 = (n) => String(Math.max(1, n)).padStart(4, '0');

      const CHAPTER_TITLES = [
        '01 · АВТОПИЛОТ',
        '02 · 3D-РОУТИНГ И ПАНЕЛЬ',
        '03 · КАРТА ПРОЕКТА WebGL2',
        '04 · RAM / CPU / GPU И ЗАЩИТЫ',
        '05 · УСТАНОВКА В 1 КЛИК',
      ];
      const COCKPIT_LABELS = [
        'УМНЫЙ ВВОД @FILE',
        '3D-РОУТИНГ И AUTO-SPEC',
        'ОЗУ · ЦП · OLLAMA GPU',
        '59 ЗАЩИТ И SENTINEL',
      ];
      const MAP_LABELS = [
        'Архитектура проекта · Умный зум',
        'Волна Blast & Diff (1–3 хопа) + Пакет',
        'Горячие точки Git · Фокус связей',
        'AST-граф вызовов функций · WebGL2',
      ];

      let currentTime = 0;

      function fitStage() {
        if (isCapture) return;
        const shell = document.getElementById('root');
        const sx = (window.innerWidth - 20) / ${WIDTH};
        const sy = (window.innerHeight - 86) / ${HEIGHT};
        const sc = Math.min(sx, sy, 1);
        shell.style.transform = 'scale(' + sc.toFixed(4) + ')';
      }
      window.addEventListener('resize', fitStage);
      fitStage();

      function renderSubtitleAtMs(tMs) {
        const pill = document.getElementById('subPill');
        if (!pill) return;
        let activeGrp = null;
        for (let i = 0; i < SUBTITLES.length; i++) {
          const g = SUBTITLES[i];
          if (tMs >= g.startMs && tMs <= g.endMs) { activeGrp = g; break; }
        }
        if (!activeGrp) {
          pill.style.opacity = '0';
          return;
        }
        pill.style.opacity = '1';
        let html = '';
        for (const w of activeGrp.words) {
          const isAct = tMs >= w.startMs && tMs <= w.endMs;
          const isSpoken = tMs > w.endMs;
          const cls = isAct ? 'sub-word active' : (isSpoken ? 'sub-word spoken' : 'sub-word');
          html += '<span class="' + cls + '">' + w.text + '</span>';
        }
        if (pill.getAttribute('data-last-html') !== html) {
          pill.setAttribute('data-last-html', html);
          pill.innerHTML = html;
        }
      }

      function applyTime(tSec) {
        const t = clamp(Number(tSec) || 0, 0, DURATION);
        currentTime = t;
        const tMs = Math.round(t * 1000);

        const clk = document.getElementById('hudClock');
        if (clk) clk.textContent = t.toFixed(1).padStart(4, '0') + ' / 25.0s';
        const ctlT = document.getElementById('ctlTime');
        if (ctlT) ctlT.textContent = t.toFixed(1).padStart(4, '0') + ' / 25.0s';
        const scrub = document.getElementById('timeScrub');
        if (scrub && document.activeElement !== scrub) scrub.value = t.toFixed(2);

        // Top 5 stories segments
        let activeIdx = 0;
        let scanOp = 0;
        let scanY = 0;
        for (let i = 0; i < CHAPTERS.length; i++) {
          const ch = CHAPTERS[i];
          const fill = document.getElementById('storyFill' + i);
          const p = clamp((t - ch.start) / Math.max(0.01, ch.end - ch.start), 0, 1);
          if (fill) fill.style.transform = 'scaleX(' + p.toFixed(4) + ')';

          const el = document.getElementById('scene' + i);
          if (!el) continue;
          const fadeIn = i === 0 ? 1 : clamp((t - ch.start) / 0.22, 0, 1);
          const fadeOut = i === CHAPTERS.length - 1 ? 1 : clamp((ch.end - t) / 0.18, 0, 1);
          const inRange = t >= ch.start && (t < ch.end || (i === CHAPTERS.length - 1 && t <= DURATION));
          const op = inRange ? Math.min(fadeIn, fadeOut) : 0;
          el.style.opacity = op.toFixed(4);
          const yShift = inRange ? ((1 - fadeIn) * 28 - (1 - fadeOut) * 18) : 0;
          const sc = inRange ? (0.96 + 0.04 * fadeIn) : 0.96;
          el.style.transform = 'translateY(' + yShift.toFixed(1) + 'px) scale(' + sc.toFixed(4) + ')';

          if (inRange) activeIdx = i;
          if (i > 0 && t >= ch.start - 0.06 && t <= ch.start + 0.24) {
            const wProg = (t - (ch.start - 0.06)) / 0.30;
            scanOp = Math.sin(clamp(wProg, 0, 1) * Math.PI) * 0.9;
            scanY = wProg * 1550;
          }
        }

        const wipe = document.getElementById('scanWipe');
        if (wipe) {
          wipe.style.opacity = scanOp.toFixed(3);
          wipe.style.transform = 'translateY(' + scanY.toFixed(1) + 'px)';
        }
        const chName = document.getElementById('hudChapterName');
        if (chName) chName.textContent = CHAPTER_TITLES[activeIdx] || CHAPTER_TITLES[0];

        // Scene 0: Hook
        if (t < CHAPTERS[0].end + 0.2) {
          const p0 = norm(t, 0.05, 0.65);
          const p1 = norm(t, 0.25, 0.85);
          const p2 = norm(t, 0.95, 1.65);
          const pulse = (t * 0.9) % 1;
          document.getElementById('s1Emblem').style.transform = 'scale(' + (0.8 + 0.2 * p0).toFixed(4) + ')';
          document.getElementById('s1Ring').style.transform = 'scale(' + (0.85 + 0.45 * pulse).toFixed(3) + ')';
          document.getElementById('s1Ring').style.opacity = (1 - pulse).toFixed(3);
          document.getElementById('s1Title').style.transform = 'translateY(' + ((1 - p1) * 24).toFixed(1) + 'px)';
          document.getElementById('s1Title').style.opacity = p1.toFixed(3);
          document.getElementById('s1Cards').style.transform = 'translateY(' + ((1 - p2) * 32).toFixed(1) + 'px)';
          document.getElementById('s1Cards').style.opacity = p2.toFixed(3);
        }

        // Scene 1: 3D Tensor + Live Russian Cockpit
        if (t >= CHAPTERS[1].start - 0.1 && t < CHAPTERS[1].end + 0.2) {
          const s = CHAPTERS[1].start;
          const dur = CHAPTERS[1].end - s;
          document.getElementById('axFill0').style.transform = 'scaleX(' + (0.84 * norm(t, s + 0.2, s + 1.0)).toFixed(4) + ')';
          document.getElementById('axFill1').style.transform = 'scaleX(' + (0.92 * norm(t, s + 0.4, s + 1.2)).toFixed(4) + ')';
          document.getElementById('axFill2').style.transform = 'scaleX(' + (0.78 * norm(t, s + 0.6, s + 1.4)).toFixed(4) + ')';

          const u = clamp((t - s) / Math.max(0.1, dur), 0, 0.9999);
          const cFrame = Math.min(CLIPS.cockpitCount, 1 + Math.floor(u * CLIPS.cockpitCount));
          const cImg = document.getElementById('cockpitLiveImg');
          if (cImg) {
            const targetSrc = '/shorts-ru-frames/cockpit/frame-' + pad4(cFrame) + '.png';
            if (cImg.getAttribute('data-cur-src') !== targetSrc) {
              cImg.setAttribute('data-cur-src', targetSrc);
              cImg.src = targetSrc;
            }
          }
          const cm = CLIPS.cockpitMilestones || {};
          let step = 0;
          if (cFrame >= (cm.guardStartFrame || 62)) step = 3;
          else if (cFrame >= (cm.hardwareStartFrame || 45)) step = 2;
          else if (cFrame >= (cm.behaviorStartFrame || 28)) step = 1;
          const badge = document.getElementById('cockpitPhaseBadge');
          if (badge) badge.textContent = COCKPIT_LABELS[step];
        }

        // Scene 2: Live Russian WebGL2 Project Map
        if (t >= CHAPTERS[2].start - 0.1 && t < CHAPTERS[2].end + 0.2) {
          const s = CHAPTERS[2].start;
          const dur = CHAPTERS[2].end - s;
          const u = clamp((t - s) / Math.max(0.1, dur), 0, 0.9999);
          const mFrame = Math.min(CLIPS.mapCount, 1 + Math.floor(u * CLIPS.mapCount));
          const mImg = document.getElementById('mapLiveImg');
          if (mImg) {
            const targetSrc = '/shorts-ru-frames/map/frame-' + pad4(mFrame) + '.png';
            if (mImg.getAttribute('data-cur-src') !== targetSrc) {
              mImg.setAttribute('data-cur-src', targetSrc);
              mImg.src = targetSrc;
            }
          }
          const mm = CLIPS.mapMilestones || {};
          let lensIdx = 0;
          if (mFrame >= (mm.symbolsStartFrame || 102)) lensIdx = 3;
          else if (mFrame >= (mm.hotspotsStartFrame || 79)) lensIdx = 2;
          else if (mFrame >= (mm.blastStartFrame || 45)) lensIdx = 1;
          for (let i = 0; i < 4; i++) {
            const pill = document.getElementById('mapLens' + i);
            if (pill) pill.classList.toggle('active', i === lensIdx);
          }
          const foot = document.getElementById('mapFootMode');
          if (foot) foot.textContent = MAP_LABELS[lensIdx];
        }

        // Scene 3: Local Stack & 59 Guardrails
        if (t >= CHAPTERS[3].start - 0.1 && t < CHAPTERS[3].end + 0.2) {
          const s = CHAPTERS[3].start;
          for (let i = 0; i < 4; i++) {
            const p = norm(t, s + i * 0.45, s + 0.65 + i * 0.45);
            const card = document.getElementById('stackCard' + i);
            if (card) {
              card.style.opacity = p.toFixed(3);
              card.style.transform = 'translateX(' + ((1 - p) * 36).toFixed(1) + 'px)';
            }
          }
        }

        // Scene 4: Outro / CTA
        if (t >= CHAPTERS[4].start - 0.1) {
          const s = CHAPTERS[4].start;
          const p = norm(t, s + 0.05, s + 0.7);
          document.getElementById('s5Logo').style.transform = 'scale(' + (0.84 + 0.16 * p).toFixed(4) + ')';
          const pulse = 1 + 0.035 * Math.sin((t - s) * 7.5);
          document.getElementById('ctaPill').style.transform = 'scale(' + pulse.toFixed(4) + ')';
        }

        renderSubtitleAtMs(tMs);
      }

      async function waitVisibleImagesDecoded() {
        const imgs = [];
        const cImg = document.getElementById('cockpitLiveImg');
        const mImg = document.getElementById('mapLiveImg');
        if (currentTime >= CHAPTERS[1].start - 0.1 && currentTime < CHAPTERS[1].end + 0.2 && cImg) imgs.push(cImg);
        if (currentTime >= CHAPTERS[2].start - 0.1 && currentTime < CHAPTERS[2].end + 0.2 && mImg) imgs.push(mImg);
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

      window.__seek = applyTime;
      window.__seekAsync = async function (tSec) {
        applyTime(tSec);
        await waitVisibleImagesDecoded();
      };
      window.__timelines = window.__timelines || {};
      window.__timelines['the-tunnel-shorts-ru'] = {
        seek: applyTime,
        pause(tSec) { if (tSec !== undefined) applyTime(tSec); },
        duration: () => DURATION,
      };
      applyTime(0);

      if (!isCapture) {
        let playing = false;
        let lastTs = 0;
        const tick = (ts) => {
          if (!playing) return;
          if (!lastTs) lastTs = ts;
          const dt = Math.min(0.1, (ts - lastTs) / 1000);
          lastTs = ts;
          const next = currentTime + dt;
          if (next >= DURATION) {
            applyTime(DURATION);
            playing = false;
            document.getElementById('btnPlayPause').textContent = '↻ Replay';
            return;
          }
          applyTime(next);
          window.requestAnimationFrame(tick);
        };
        document.getElementById('btnPlayPause').addEventListener('click', () => {
          if (currentTime >= DURATION - 0.1) currentTime = 0;
          playing = !playing;
          document.getElementById('btnPlayPause').textContent = playing ? '⏸ Pause' : '▶ Play';
          if (playing) { lastTs = 0; window.requestAnimationFrame(tick); }
        });
        document.getElementById('timeScrub').addEventListener('input', (ev) => {
          applyTime(Number(ev.target.value));
        });
      }
    })();
  </script>
</body>
</html>`;
}

function startStaticServer(docsDir, framesRoot) {
  const mime = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json; charset=utf-8' };
  const isContainedPath = (rootDir, candidate) => {
    const rel = path.relative(rootDir, candidate);
    return Boolean(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const server = http.createServer((req, res) => {
    const clean = decodeURIComponent((req.url || '/').split('?')[0]);
    if (clean.startsWith('/shorts-ru-frames/')) {
      const rel = clean.slice('/shorts-ru-frames/'.length);
      const abs = path.resolve(framesRoot, rel);
      if (!isContainedPath(framesRoot, abs) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404); res.end('Not found'); return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    const rel = clean === '/' ? 'demo/shorts-ru.html' : clean.replace(/^\/+/, '');
    const abs = path.resolve(docsDir, rel);
    if (!isContainedPath(docsDir, abs) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen({ server, port: server.address().port })));
}

async function main() {
  const metricsPath = path.join(FRAMES_ROOT, 'shorts-ru-metrics.json');
  if (!fs.existsSync(metricsPath)) {
    throw new Error('Отсутствует .cache/shorts-ru-frames/shorts-ru-metrics.json — сначала запустите capture-shorts-ru-media.mjs');
  }
  const clips = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '4.0.6';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-shorts-ru-'));
  const ttsDir = path.join(tmpDir, 'tts');
  let staticSrv = null;
  let cdp = null;

  try {
    console.log('[1/4] Синтез русской нейро-озвучки (ru-RU-DmitryNeural) и калибровка таймингов под 25.00с...');
    const rawTts = await synthesizeRussianVoiceover(
      SCRIPT_SEGMENTS.map((s) => ({ id: s.id, text: s.ttsText, rate: s.rate })),
      ttsDir,
      { voice: 'ru-RU-DmitryNeural' }
    );

    const trimmedMeta = rawTts.map((tts) => {
      const words = Array.isArray(tts.words) ? tts.words : [];
      const firstW = words[0];
      const lastW = words[words.length - 1];
      const trimStartSec = firstW ? Math.max(0, (firstW.offsetMs - 40) / 1000) : 0;
      const trimEndSec = lastW
        ? Math.min(tts.durationSec, (lastW.offsetMs + lastW.durationMs + 130) / 1000)
        : tts.durationSec;
      const trimmedDur = Math.max(0.5, trimEndSec - trimStartSec);
      return { trimStartSec, trimEndSec, trimmedDur };
    });

    const gapSec = 0.20;
    const totalGaps = gapSec * (rawTts.length - 1);
    const introLead = 0.14;
    const outroTail = 0.72;
    const targetSpeechWindow = DURATION_SEC - introLead - outroTail - totalGaps; // ~23.34s
    const rawSpeechSum = trimmedMeta.reduce((acc, m) => acc + m.trimmedDur, 0);
    const tempoRatio = Math.max(0.92, Math.min(1.22, rawSpeechSum / targetSpeechWindow));

    const alignedSegments = [];
    let cursorSec = introLead;
    for (let i = 0; i < SCRIPT_SEGMENTS.length; i++) {
      const def = SCRIPT_SEGMENTS[i];
      const tts = rawTts[i];
      const meta = trimmedMeta[i];
      const scaledDur = meta.trimmedDur / tempoRatio;
      const trimStartMs = Math.round(meta.trimStartSec * 1000);
      const scaledWords = (tts.words || []).map((w) => ({
        text: w.text,
        offsetMs: Math.max(0, Math.round((w.offsetMs - trimStartMs) / tempoRatio)),
        durationMs: Math.round(w.durationMs / tempoRatio),
      }));
      alignedSegments.push({
        id: def.id,
        engine: tts.engine,
        audioPath: tts.audioPath,
        trimStartSec: meta.trimStartSec,
        trimEndSec: meta.trimEndSec,
        atempo: tempoRatio,
        startSec: Number(cursorSec.toFixed(3)),
        durationSec: Number(scaledDur.toFixed(3)),
        endSec: Number((cursorSec + scaledDur).toFixed(3)),
        words: scaledWords,
        displayGroups: def.displayGroups,
      });
      cursorSec += scaledDur + gapSec;
    }

    // Build exact 25.00s chapter boundaries seamlessly covering 0..25.0s
    const chapters = alignedSegments.map((seg, i) => ({
      id: seg.id,
      start: i === 0 ? 0.0 : Number((alignedSegments[i - 1].endSec + gapSec * 0.45).toFixed(3)),
      end: i === alignedSegments.length - 1 ? DURATION_SEC : Number((seg.endSec + gapSec * 0.45).toFixed(3)),
    }));
    for (let i = 0; i < chapters.length - 1; i++) chapters[i].end = chapters[i + 1].start;

    console.log('      Движки:', rawTts.map((r) => r.engine).join(', '), '| rawSum:', rawSpeechSum.toFixed(2) + 'с | atempo:', tempoRatio.toFixed(3), '| конец речи:', alignedSegments[4].endSec.toFixed(2) + 'с');

    // Frame-locked SFX cues synced to exact chapters, cockpit clicks/typing & map clicks/lenses
    const sfxCues = [
      { timeSec: 0.08, kind: 'riser', gain: 0.48, label: 'intro_riser' },
      { timeSec: 0.45, kind: 'hit', gain: 0.78, label: 'hook_hit' },
      { timeSec: 1.05, kind: 'pop', gain: 0.56, label: 'hook_cards' },
      { timeSec: 1.35, kind: 'chime', gain: 0.52, label: 'hook_chime' },
    ];

    // Chapter transitions
    for (let i = 1; i < chapters.length; i++) {
      sfxCues.push({ timeSec: Math.max(0.05, chapters[i].start - 0.10), kind: 'whoosh', gain: 0.72, label: `trans_${i}` });
      sfxCues.push({ timeSec: chapters[i].start + 0.02, kind: 'hit', gain: 0.52, label: `land_${i}` });
    }

    // Cockpit exact mouse clicks & mechanical key taps mapped to Chapter 1 (Scene 2)
    const chCockpit = chapters[1];
    const cDur = chCockpit.end - chCockpit.start;
    for (const clk of clips.cockpit.clicks || []) {
      const t = chCockpit.start + (clk.frame / Math.max(1, clips.cockpit.frameCount)) * cDur;
      sfxCues.push({ timeSec: Number(t.toFixed(3)), kind: 'mouse_click', gain: 0.72, label: clk.label });
      sfxCues.push({ timeSec: Number((t + 0.05).toFixed(3)), kind: 'pop', gain: 0.46, label: `${clk.label}_pop` });
    }
    for (const tf of clips.cockpit.typeFrames || []) {
      const baseT = chCockpit.start + (tf / Math.max(1, clips.cockpit.frameCount)) * cDur;
      for (let k = 0; k < 4; k++) {
        sfxCues.push({ timeSec: Number((baseT + k * 0.075).toFixed(3)), kind: 'key_tap', gain: 0.52, label: `type_${tf}_${k}` });
      }
    }

    // Map exact clicks & lens FX mapped to Chapter 2 (Scene 3)
    const chMap = chapters[2];
    const mDur = chMap.end - chMap.start;
    for (const clk of clips.map.clicks || []) {
      const t = chMap.start + (clk.frame / Math.max(1, clips.map.frameCount)) * mDur;
      sfxCues.push({ timeSec: Number(t.toFixed(3)), kind: 'mouse_click', gain: 0.74, label: clk.label });
      if (clk.label === 'map_lens_blast') {
        sfxCues.push({ timeSec: Number(Math.max(chMap.start, t - 0.18).toFixed(3)), kind: 'riser', gain: 0.44, label: 'blast_riser' });
        sfxCues.push({ timeSec: Number((t + 0.08).toFixed(3)), kind: 'hit', gain: 0.72, label: 'blast_wave_hit' });
      } else if (clk.label === 'map_symbols') {
        sfxCues.push({ timeSec: Number((t + 0.08).toFixed(3)), kind: 'chime', gain: 0.58, label: 'symbols_chime' });
      } else {
        sfxCues.push({ timeSec: Number((t + 0.05).toFixed(3)), kind: 'pop', gain: 0.45, label: `${clk.label}_pop` });
      }
    }

    // Chapter 3 (Local Stack cards) + Chapter 4 (Outro finale)
    for (let i = 0; i < 4; i++) {
      sfxCues.push({ timeSec: Number((chapters[3].start + 0.12 + i * 0.45).toFixed(3)), kind: 'pop', gain: 0.58, label: `stack_${i}` });
    }
    sfxCues.push({ timeSec: Number((chapters[4].start + 0.05).toFixed(3)), kind: 'hit', gain: 0.80, label: 'outro_hit' });
    sfxCues.push({ timeSec: Number((chapters[4].start + 0.45).toFixed(3)), kind: 'success', gain: 0.65, label: 'outro_success' });
    sfxCues.push({ timeSec: 24.25, kind: 'chime', gain: 0.68, label: 'final_chord' });

    const subtitles = buildSubtitleTimeline(alignedSegments);

    console.log('[2/4] Сведение многослойного саунд-дизайна (голос + tech-бит с sidechain + SFX)...');
    const rawMixWav = path.join(tmpDir, 'master-mix-raw.wav');
    const audioMetrics = buildMasterAudioWav({ alignedSegments, sfxCues, tmpDir, outWavPath: rawMixWav });
    console.log('      Аудиометрики:', JSON.stringify({
      durationSec: audioMetrics.durationSec,
      peakDb: audioMetrics.peakDb,
      approxLufs: audioMetrics.approxLufs,
      clippingSamples: audioMetrics.clippingSamples,
    }));

    fs.mkdirSync(DEMO_DIR, { recursive: true });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const htmlPath = path.join(DEMO_DIR, 'shorts-ru.html');
    const html = buildShortsHtml({ version, chapters, subtitles, clips, sfxCues });
    const lintRes = lintVideoCompositionContent(html, 'docs/demo/shorts-ru.html');
    if (!lintRes.ok) {
      throw new Error(`Composition determinism lint failed: ${JSON.stringify(lintRes.findings)}`);
    }
    fs.writeFileSync(htmlPath, html, 'utf8');

    const browserExe = findBrowserExecutable();
    if (!browserExe) throw new Error('Headless Chromium/Edge binary not found');

    staticSrv = await startStaticServer(path.join(ROOT_DIR, 'docs'), FRAMES_ROOT);
    cdp = await launchCdp(browserExe, path.join(tmpDir, 'profile'));

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

    const loaded = cdp.waitForEvent('Page.loadEventFired', 15000);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${staticSrv.port}/demo/shorts-ru.html?capture=1` });
    await loaded;

    await cdp.send('Runtime.evaluate', {
      expression: `Promise.all(Array.from(document.images).map(img => img.complete ? true : new Promise(r => { img.onload = r; img.onerror = r; })))`,
      awaitPromise: true,
    });

    const rawMp4Path = path.join(tmpDir, 'shorts-silent.mp4');
    const finalMp4Path = path.join(MEDIA_DIR, `the-tunnel-shorts-ru-v${version}.mp4`);

    console.log(`[3/4] Покадровый рендер ${TOTAL_FRAMES} вертикальных кадров (1080x1920 @ 30fps)...`);
    const ff = spawn('ffmpeg', [
      '-y', '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(FPS), '-i', '-',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      rawMp4Path,
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });

    let ffStderr = '';
    ff.stderr.on('data', (c) => { ffStderr += c.toString('utf8'); });

    for (let f = 0; f < TOTAL_FRAMES; f++) {
      const tSec = Number((f / FPS).toFixed(4));
      await cdp.send('Runtime.evaluate', { expression: `window.__seekAsync(${tSec})`, awaitPromise: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(shot.data, 'base64');
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if ((f + 1) % 150 === 0 || f === TOTAL_FRAMES - 1) {
        console.log(`      Отрендерено ${f + 1}/${TOTAL_FRAMES} кадров (${tSec.toFixed(1)}с)`);
      }
    }
    ff.stdin.end();
    await new Promise((resolve, reject) => {
      ff.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${ffStderr.slice(-600)}`))));
    });

    console.log('[4/4] Мастеринг -14 LUFS аудио и финальная сборка MP4...');
    execFileSync('ffmpeg', [
      '-y', '-i', rawMp4Path, '-i', rawMixWav,
      '-filter_complex', '[1:a]loudnorm=I=-14:TP=-1.2:LRA=8[aout]',
      '-map', '0:v:0', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', '-shortest',
      finalMp4Path,
    ], { stdio: 'ignore', windowsHide: true });

    const sizeMb = (fs.statSync(finalMp4Path).size / (1024 * 1024)).toFixed(2);
    console.log(`✓ Готово: ${finalMp4Path} (${sizeMb} MB)`);
  } finally {
    try { cdp?.close?.(); } catch {}
    try { staticSrv?.server?.close?.(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  main().catch((err) => {
    console.error('[render-shorts-ru] FAILED:', err);
    process.exit(1);
  });
}
