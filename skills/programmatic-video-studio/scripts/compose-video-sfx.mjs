#!/usr/bin/env node
/**
 * @file compose-video-sfx.mjs
 * @description Frame-accurate sound design & acoustic critic for HyperFrames / Remotion / Web Games
 *   (combines Clipwing/real-sfx cue extraction + pure-Node 16-bit PCM WAV synthesis + optional `earshot` CLI bridge + FFmpeg -16 LUFS mix).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_SAMPLE_RATE = 48000;
const VALID_KINDS = new Set(['click', 'pop', 'whoosh', 'riser', 'hit', 'chime', 'success', 'step']);

function normalizeCueKind(raw = '') {
  const s = String(raw || '').toLowerCase();
  if (/whoosh|swoosh|slide|swipe|transition|pan/.test(s)) return 'whoosh';
  if (/riser|swell|build|ramp|grow/.test(s)) return 'riser';
  if (/hit|impact|slam|boom|punch|thud|drop/.test(s)) return 'hit';
  if (/success|done|complete|win|confirm|badge|unlock/.test(s)) return 'success';
  if (/chime|bell|sparkle|ding|notify/.test(s)) return 'chime';
  if (/pop|bubble|appear|reveal|card|scale/.test(s)) return 'pop';
  if (/step|foot|walk|tap/.test(s)) return 'step';
  return VALID_KINDS.has(s) ? s : 'click';
}

/**
 * Extracts sorted timeline audio cues from HyperFrames HTML/GSAP or Remotion TSX compositions.
 * @param {string} [sourceText='']
 * @param {string} [filePath='']
 * @returns {{ fps: number, cues: Array<{ timeSec: number, kind: string, label: string, source: string }> }}
 */
export function extractTimelineAudioCues(sourceText = '', filePath = '') {
  const text = typeof sourceText === 'string' ? sourceText : String(sourceText || '');
  const cues = [];
  const fpsMatch = /\bfps\s*[:=]\s*(\d{2,3})\b/i.exec(text);
  const fps = fpsMatch ? Math.max(12, Math.min(120, Number(fpsMatch[1]))) : 30;

  // 1. HyperFrames HTML data-start / data-sfx attributes
  const hfTagRe = /<([a-z0-9-]+)\b([^>]*\bdata-(?:start|sfx)\s*=[^>]*)>/gi;
  let m;
  while ((m = hfTagRe.exec(text)) !== null) {
    const attrs = m[2];
    const startMatch = /\bdata-start\s*=\s*["']?([0-9]+(?:\.[0-9]+)?)["']?/i.exec(attrs);
    const sfxMatch = /\bdata-sfx\s*=\s*["']([^"']{1,60})["']/i.exec(attrs);
    const idMatch = /\b(?:id|data-composition-id|class)\s*=\s*["']([^"']{1,60})["']/i.exec(attrs);
    if (!startMatch && !sfxMatch) continue;
    const timeSec = startMatch ? Number(startMatch[1]) : 0;
    const label = sfxMatch?.[1] || idMatch?.[1] || m[1];
    cues.push({
      timeSec: Number.isFinite(timeSec) ? Number(timeSec.toFixed(3)) : 0,
      kind: normalizeCueKind(sfxMatch?.[1] || label),
      label: String(label).trim(),
      source: 'hyperframes_attr',
    });
  }

  // 2. GSAP timeline calls (.to / .fromTo with explicit numeric position or sequential cursor)
  let gsapCursorSec = 0;
  const gsapRe = /\.(?:fromTo|to|from)\s*\(\s*[^,]{1,80},\s*\{[^}]{1,260}\}\s*(?:,\s*\{[^}]{1,260}\}\s*)?(?:,\s*["']?([0-9]+(?:\.[0-9]+)?)["']?\s*)?\)/g;
  while ((m = gsapRe.exec(text)) !== null) {
    const full = m[0];
    const durMatch = /\bduration\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(full);
    const dur = durMatch ? Number(durMatch[1]) : 0.4;
    const explicitPos = m[1] !== undefined ? Number(m[1]) : gsapCursorSec;
    const timeSec = Number.isFinite(explicitPos) ? explicitPos : gsapCursorSec;
    const hasMotion = /\b(?:x|y|scale|opacity|rotate)\s*:/i.test(full);
    if (hasMotion) {
      const kind = /\b(?:x|y)\s*:/i.test(full) ? 'whoosh' : 'pop';
      cues.push({
        timeSec: Number(timeSec.toFixed(3)),
        kind,
        label: `gsap_${kind}_${cues.length + 1}`,
        source: 'gsap_timeline',
      });
    }
    gsapCursorSec = timeSec + (Number.isFinite(dur) ? dur : 0.4);
  }

  // 3. Remotion <Sequence from={frame} name="...">
  const remotionSeqRe = /<Sequence\b([^>]*)>/gi;
  while ((m = remotionSeqRe.exec(text)) !== null) {
    const attrs = m[1];
    const fromMatch = /\bfrom\s*=\s*\{?\s*(\d+)\s*\}?/i.exec(attrs);
    if (!fromMatch) continue;
    const fromFrame = Number(fromMatch[1]);
    const nameMatch = /\bname\s*=\s*["']([^"']{1,60})["']/i.exec(attrs);
    const label = nameMatch?.[1] || `seq_${fromFrame}`;
    cues.push({
      timeSec: Number((fromFrame / fps).toFixed(3)),
      kind: normalizeCueKind(label),
      label,
      source: 'remotion_sequence',
    });
  }

  // Deduplicate near-identical timestamps (< 40ms apart with same kind) and sort chronologically
  const sorted = cues.sort((a, b) => a.timeSec - b.timeSec);
  const deduped = [];
  for (const cue of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.timeSec - cue.timeSec) < 0.04 && prev.kind === cue.kind) {
      continue;
    }
    deduped.push(cue);
  }

  return {
    fps,
    filePath: filePath || '',
    cues: deduped,
  };
}

function createMulberry32(seed = 1) {
  let a = (Number(seed) || 1) >>> 0;
  return function nextRand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeMonoPcm16Wav(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const pcm = Math.round(clamped * 32767);
    buf.writeInt16LE(pcm, 44 + i * 2);
  }
  return buf;
}

/**
 * Generates a studio-clean 16-bit 48kHz mono PCM WAV Buffer with zero external dependencies.
 * Peak normalized to -3 dBFS (amplitude 0.707) with zero clipping.
 */
export function synthesizeProceduralWavBuffer(kind = 'click', { durationSec, sampleRate = DEFAULT_SAMPLE_RATE, seed = 1 } = {}) {
  const k = normalizeCueKind(kind);
  const defaultDurs = {
    click: 0.055,
    pop: 0.11,
    whoosh: 0.36,
    riser: 0.75,
    hit: 0.24,
    chime: 0.55,
    success: 0.45,
    step: 0.14,
  };
  const dur = Math.max(0.03, Math.min(4.0, Number(durationSec) || defaultDurs[k] || 0.15));
  const sr = Math.max(8000, Math.min(96000, Number(sampleRate) || DEFAULT_SAMPLE_RATE));
  const n = Math.floor(dur * sr);
  const out = new Float64Array(n);
  const rand = createMulberry32(seed);

  let phase = 0;
  let lpState = 0;

  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const u = i / Math.max(1, n - 1);
    const attack = Math.min(1, t / 0.003);
    let val = 0;

    if (k === 'click') {
      const freq = 1900 * Math.exp(-t * 48) + 420;
      phase += (2 * Math.PI * freq) / sr;
      val = Math.sin(phase) * Math.exp(-t * 68) + (rand() * 2 - 1) * 0.28 * Math.exp(-t * 140);
    } else if (k === 'pop') {
      const freq = 260 + 520 * Math.sin(Math.min(1, u * 1.4) * Math.PI);
      phase += (2 * Math.PI * freq) / sr;
      val = Math.sin(phase) * Math.exp(-t * 28);
    } else if (k === 'whoosh') {
      const white = rand() * 2 - 1;
      const alpha = 0.04 + 0.18 * Math.sin(u * Math.PI);
      lpState = lpState + alpha * (white - lpState);
      const env = Math.pow(Math.sin(u * Math.PI), 1.4);
      val = lpState * env * 2.2;
    } else if (k === 'riser') {
      const freq = 130 * Math.pow(6.5, u);
      phase += (2 * Math.PI * freq) / sr;
      const white = rand() * 2 - 1;
      lpState = lpState + 0.12 * (white - lpState);
      const env = Math.pow(u, 1.35) * (u > 0.94 ? (1 - u) / 0.06 : 1);
      val = (0.65 * Math.sin(phase) + 0.35 * lpState) * env;
    } else if (k === 'hit') {
      const freq = 165 * Math.exp(-t * 22) + 44;
      phase += (2 * Math.PI * freq) / sr;
      const body = Math.sin(phase) * Math.exp(-t * 11);
      const snap = (rand() * 2 - 1) * 0.45 * Math.exp(-t * 75);
      val = body + snap;
    } else if (k === 'chime') {
      const env = Math.exp(-t * 5.8);
      val = (
        0.55 * Math.sin(2 * Math.PI * 523.25 * t) +
        0.30 * Math.sin(2 * Math.PI * 659.25 * t) +
        0.20 * Math.sin(2 * Math.PI * 1046.5 * t)
      ) * env;
    } else if (k === 'success') {
      const split = dur * 0.28;
      if (t < split) {
        const env1 = Math.exp(-t * 12);
        val = (0.7 * Math.sin(2 * Math.PI * 523.25 * t) + 0.25 * Math.sin(2 * Math.PI * 1046.5 * t)) * env1;
      } else {
        const dt = t - split;
        const env2 = Math.exp(-dt * 7.2);
        val = (0.7 * Math.sin(2 * Math.PI * 783.99 * dt) + 0.3 * Math.sin(2 * Math.PI * 1174.66 * dt)) * env2;
      }
    } else {
      // step
      const white = rand() * 2 - 1;
      lpState = lpState + 0.22 * (white - lpState);
      const thud = Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t * 36);
      val = (lpState * Math.exp(-t * 30) * 0.9) + thud * 0.5;
    }

    // Fade-out tail (5ms) to avoid end-of-buffer pop
    const tail = (n - 1 - i) < sr * 0.005 ? (n - 1 - i) / (sr * 0.005) : 1;
    out[i] = val * attack * tail;
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const targetPeak = 0.707; // -3 dBFS
  if (peak > 1e-6) {
    const gain = targetPeak / peak;
    for (let i = 0; i < n; i++) out[i] *= gain;
  }

  return encodeMonoPcm16Wav(out, sr);
}

/**
 * Offline acoustic critique for PCM 16-bit WAV files (duration, peak dBFS, RMS/LUFS estimate, clipping, leading silence).
 * @param {Buffer} wavBuffer
 */
export function analyzeWavBufferAcousticMetrics(wavBuffer) {
  if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
    return { ok: false, error: 'invalid_wav_buffer' };
  }
  if (wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { ok: false, error: 'not_riff_wave' };
  }

  let sampleRate = DEFAULT_SAMPLE_RATE;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', pos, pos + 4);
    const chunkSize = wavBuffer.readUInt32LE(pos + 4);
    const bodyStart = pos + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= wavBuffer.length) {
      channels = wavBuffer.readUInt16LE(bodyStart + 2) || 1;
      sampleRate = wavBuffer.readUInt32LE(bodyStart + 4) || DEFAULT_SAMPLE_RATE;
      bitsPerSample = wavBuffer.readUInt16LE(bodyStart + 14) || 16;
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      dataLength = Math.min(chunkSize, wavBuffer.length - bodyStart);
      break;
    }
    pos = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataLength < 2 || bitsPerSample !== 16) {
    return { ok: false, error: 'unsupported_wav_pcm' };
  }

  const totalSamples = Math.floor(dataLength / 2);
  let peakAbs = 0;
  let sumSq = 0;
  let clippingSamples = 0;
  let firstActiveIdx = -1;

  for (let i = 0; i < totalSamples; i++) {
    const s = wavBuffer.readInt16LE(dataOffset + i * 2);
    const norm = s / 32768;
    const absNorm = Math.abs(norm);
    if (absNorm > peakAbs) peakAbs = absNorm;
    if (Math.abs(s) >= 32700) clippingSamples++;
    if (firstActiveIdx < 0 && absNorm >= 0.01) firstActiveIdx = i;
    sumSq += norm * norm;
  }

  const rms = Math.sqrt(sumSq / Math.max(1, totalSamples));
  const peakDb = Number((20 * Math.log10(Math.max(1e-7, peakAbs))).toFixed(2));
  const rmsDb = Number((20 * Math.log10(Math.max(1e-7, rms))).toFixed(2));
  const approxLufs = Number((rmsDb - 0.69).toFixed(2));
  const frameRate = sampleRate * channels;
  const durationSec = Number((totalSamples / frameRate).toFixed(3));
  const leadingSilenceMs = firstActiveIdx >= 0 ? Math.round((firstActiveIdx / frameRate) * 1000) : Math.round(durationSec * 1000);

  const issues = [];
  if (clippingSamples > 0 || peakDb > -0.2) issues.push('clipping_detected');
  if (rmsDb < -58) issues.push('too_quiet_or_silent');
  if (leadingSilenceMs > 120) issues.push('excessive_leading_silence');

  return {
    ok: issues.length === 0 && durationSec > 0,
    sampleRate,
    channels,
    durationSec,
    peakDb,
    rmsDb,
    approxLufs,
    clippingSamples,
    leadingSilenceMs,
    issues,
  };
}

/**
 * Resolves a single audio cue either via external `earshot` CLI (if installed) or built-in procedural PCM synthesis.
 */
export function resolveCueAudioAsset(cue = {}, { outDir = process.cwd(), preferEarshot = true, spawnSyncImpl = spawnSync, seed = 1 } = {}) {
  const kind = normalizeCueKind(cue.kind || cue.label || 'click');
  const absOut = path.resolve(outDir);
  fs.mkdirSync(absOut, { recursive: true });
  const safeBase = String(cue.label || kind).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 32) || kind;
  const outWav = path.join(absOut, `${safeBase}-${Math.round((Number(cue.timeSec) || 0) * 1000)}ms.wav`);

  if (cue.file && fs.existsSync(path.resolve(cue.file))) {
    return { ok: true, engine: 'local_file', kind, timeSec: Number(cue.timeSec) || 0, filePath: path.resolve(cue.file) };
  }

  if (preferEarshot && typeof spawnSyncImpl === 'function') {
    try {
      let useShell = false;
      let probe = spawnSyncImpl('earshot', ['--version'], { windowsHide: true, timeout: 1500, encoding: 'utf8' });
      if (process.platform === 'win32' && probe?.error?.code === 'EINVAL') {
        useShell = true;
        probe = spawnSyncImpl('earshot', ['--version'], { windowsHide: true, timeout: 1500, encoding: 'utf8', shell: true });
      }
      if (probe?.status === 0) {
        const prompt = String(cue.label || kind).replace(/[_-]+/g, ' ');
        const gen = spawnSyncImpl('earshot', ['make', prompt, '-o', outWav], {
          windowsHide: true,
          timeout: 15000,
          encoding: 'utf8',
          ...(useShell ? { shell: true } : {}),
        });
        if (gen?.status === 0 && fs.existsSync(outWav)) {
          return { ok: true, engine: 'earshot_cli', kind, timeSec: Number(cue.timeSec) || 0, filePath: outWav };
        }
      }
    } catch {}
  }

  const wavBuf = synthesizeProceduralWavBuffer(kind, { seed });
  fs.writeFileSync(outWav, wavBuf);
  const metrics = analyzeWavBufferAcousticMetrics(wavBuf);
  return { ok: true, engine: 'builtin_pcm_synth', kind, timeSec: Number(cue.timeSec) || 0, filePath: outWav, metrics };
}

/**
 * Builds deterministic FFmpeg filtergraph arguments for frame-locked adelay + amix + -16 LUFS loudnorm.
 */
export function buildFfmpegMixArgs(opts = {}) {
  const safe = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const { videoPath = '', cueFiles = [], outputWavPath = 'sfx-track.wav', outputVideoPath = '', targetLufs = -16 } = safe;
  const validCues = Array.isArray(cueFiles) ? cueFiles.filter((c) => c && c.filePath) : [];
  const args = ['-y'];
  if (videoPath) args.push('-i', videoPath);
  for (const c of validCues) {
    args.push('-i', c.filePath);
  }
  const offsetIdx = videoPath ? 1 : 0;
  const filterChains = [];
  const mixLabels = [];
  for (let i = 0; i < validCues.length; i++) {
    const delayMs = Math.max(0, Math.round((Number(validCues[i].timeSec) || 0) * 1000));
    const lbl = `s${i}`;
    filterChains.push(`[${i + offsetIdx}:a]adelay=${delayMs}|${delayMs},aformat=sample_rates=48000:channel_layouts=stereo[${lbl}]`);
    mixLabels.push(`[${lbl}]`);
  }

  if (mixLabels.length > 0) {
    const normLufs = Math.max(-24, Math.min(-10, Number(targetLufs) || -16));
    filterChains.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:normalize=0,loudnorm=I=${normLufs}:TP=-1.5:LRA=11[sfxout]`);
    args.push('-filter_complex', filterChains.join(';'));
    if (videoPath && outputVideoPath) {
      args.push('-map', '0:v', '-map', '[sfxout]', '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputVideoPath);
    } else {
      args.push('-map', '[sfxout]', outputWavPath);
    }
  }
  return { ok: mixLabels.length > 0, args, cueCount: mixLabels.length };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : '';
  };

  const synthKind = getArg('--synth');
  const critiquePath = getArg('--critique');
  const cuesTarget = getArg('--cues');
  const outPath = getArg('--out');
  const outDir = getArg('--out-dir') || path.resolve('sfx-output');
  const renderVideo = getArg('--render');

  let result = { ok: false };
  if (synthKind) {
    const wav = synthesizeProceduralWavBuffer(synthKind);
    const dest = path.resolve(outPath || `${normalizeCueKind(synthKind)}.wav`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, wav);
    result = { ok: true, mode: 'synth', kind: normalizeCueKind(synthKind), outPath: dest, metrics: analyzeWavBufferAcousticMetrics(wav) };
  } else if (critiquePath) {
    const absWav = path.resolve(critiquePath);
    const buf = fs.existsSync(absWav) ? fs.readFileSync(absWav) : Buffer.alloc(0);
    result = { mode: 'critique', filePath: absWav, ...analyzeWavBufferAcousticMetrics(buf) };
  } else if (cuesTarget) {
    const absSrc = path.resolve(cuesTarget);
    const srcText = fs.existsSync(absSrc) ? fs.readFileSync(absSrc, 'utf8') : '';
    const parsed = extractTimelineAudioCues(srcText, absSrc);
    const resolvedCues = parsed.cues.map((c, idx) => resolveCueAudioAsset(c, { outDir, seed: idx + 1 }));
    const mixPlan = buildFfmpegMixArgs({
      videoPath: renderVideo ? path.resolve(renderVideo) : '',
      cueFiles: resolvedCues,
      outputWavPath: path.join(path.resolve(outDir), 'sfx-track.wav'),
      outputVideoPath: renderVideo ? path.join(path.resolve(outDir), 'with-sfx.mp4') : '',
    });
    let ffmpegRendered = false;
    if (renderVideo && mixPlan.ok) {
      try {
        const ff = spawnSync('ffmpeg', mixPlan.args, { windowsHide: true, timeout: 30000, encoding: 'utf8' });
        ffmpegRendered = ff.status === 0;
      } catch {}
    }
    result = { ok: true, mode: 'cues', ...parsed, resolvedCues, mixPlan, ffmpegRendered };
  }

  console.log(asJson ? JSON.stringify(result, null, 2) : `🔊 [VideoSFX] ok=${Boolean(result.ok)} mode=${result.mode || 'none'}`);
}
