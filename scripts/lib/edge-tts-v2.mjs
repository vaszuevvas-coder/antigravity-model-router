#!/usr/bin/env node
/**
 * @file edge-tts-v2.mjs
 * @description Zero-dependency Russian TTS synthesizer with Microsoft Edge Neural TTS v2
 *              (Sec-MS-GEC-Version 2-143.0.3650.75 + WordBoundary timestamps), plus automatic
 *              Google Translate TTS & Windows WinRT fallbacks.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const CHROMIUM_MAJOR_VERSION = '143';
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH = 11644473600n;
const U32_MASK = 0xFFFFFFFFn;

// FIPS 180-4 & Edge DRM v2 constants
const SHA256_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const SHA256_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const SHA256_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
  0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
  0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
  0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
  0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
  0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT = 0xC9DC06A7;
const SHA256_BLOCK_CONSTANTS = [
  ...SHA256_ROUND_CONSTANTS.slice(0, 14),
  SHA256_ADJUSTMENT,
  ...SHA256_ROUND_CONSTANTS.slice(15),
];
const SHA256_SIGMA0_ADJUSTMENT = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000B92C0;

const CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0],
  [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5],
  [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6],
  [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3],
  [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1],
  [0xCB49E3C6, 0xC5626167],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xF2F90B1An;
const CS64_ADJUSTMENT1 = 0x0B1A0000n;

function u32(n) {
  return Number(BigInt.asUintN(32, BigInt(n)));
}

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function rol16(x) {
  const v = x >>> 0;
  return (((v << 16) | (v >>> 16)) >>> 0);
}

function sigma0(v) {
  return (rotr32(v, 7) ^ rotr32(v, 18) ^ (v >>> 3)) >>> 0;
}

function sigma1(v) {
  return (rotr32(v, 17) ^ rotr32(v, 19) ^ (v >>> 10)) >>> 0;
}

function expandSha256Schedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i++) {
    const s1 = sigma1(words[i - 2]);
    const s0 = sigma0(words[i - 15]);
    words[i] = (s1 + words[i - 7] + s0 + words[i - 16]) >>> 0;
  }
}

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state.map((x) => x >>> 0);
  const constants = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS;
  for (let i = firstRound; i < 64; i++) {
    const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
    const ch = ((e & f) ^ ((~e) & g)) >>> 0;
    const t1 = (h + S1 + ch + constants[i] + words[i]) >>> 0;
    const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  return [a, b, c, d, e, f, g, h];
}

function sha256Init(data7) {
  const words = new Array(64).fill(0);
  words[14] = ((data7[0] << 16) | (data7[1] << 8) | data7[2]) >>> 0;
  words[15] = ((data7[3] << 24) | (data7[4] << 16) | (data7[5] << 8) | data7[6]) >>> 0;
  for (let i = 16; i < 30; i++) {
    let val = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) {
      const s1 = sigma1(words[i - 2]);
      val = (val + (i === 16 ? (s1 ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : s1)) >>> 0;
    }
    if (i - 7 >= 14) val = (val + words[i - 7]) >>> 0;
    if (i - 15 >= 14) {
      const s0 = sigma0(words[i - 15]);
      val = (val + (i === 29 ? (s0 ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : s0)) >>> 0;
    }
    words[i] = val >>> 0;
  }
  words[30] = (
    sigma1(words[28]) +
    words[23] +
    sigma0(words[15]) +
    words[14] +
    SHA256_ADJUSTMENT -
    SHA256_ROUND_CONSTANTS[14]
  ) >>> 0;
  expandSha256Schedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, idx) => (x + working[idx]) >>> 0);
}

function customSha256Digest(dataBuf) {
  if (dataBuf.length < 7) throw new Error('Token salt < 7 bytes');
  const totalLen = 57 + dataBuf.length;
  const zeroPadLen = (55 - (totalLen % 64) + 64) % 64;
  const padded = Buffer.concat([
    dataBuf.subarray(7),
    Buffer.from([0x80]),
    Buffer.alloc(zeroPadLen, 0),
    Buffer.alloc(8),
  ]);
  padded.writeBigUInt64BE(BigInt(totalLen) * 8n, padded.length - 8);
  let state = sha256Init(dataBuf.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const words = new Array(64);
    for (let j = 0; j < 16; j++) words[j] = padded.readUInt32BE(off + j * 4);
    expandSha256Schedule(words, 16);
    const working = sha256Rounds(state, words, 0);
    state = state.map((x, idx) => (x + working[idx]) >>> 0);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) out.writeUInt32BE(state[i] >>> 0, i * 4);
  return out;
}

function wordsLe4Even(buf) {
  const padLen = (-buf.length % 4 + 4) % 4;
  const padded = padLen ? Buffer.concat([buf, Buffer.alloc(padLen, 0)]) : buf;
  const words = [];
  for (let i = 0; i < padded.length; i += 4) {
    words.push(padded.readUInt32LE(i));
  }
  if (words.length % 2 === 1) words.push(0);
  return words;
}

function mul32(a, b) {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) & U32_MASK);
}

function cs64Digest(dataBuf, digestBuf) {
  const keyA = BigInt((digestBuf.readUInt32LE(0) | 1) >>> 0);
  const keyB = BigInt((digestBuf.readUInt32LE(4) | 1) >>> 0);
  const factors = [
    Number((keyA * CS64_FACTOR) & U32_MASK),
    Number((keyB * CS64_FACTOR) & U32_MASK),
  ];
  const terms = [];
  const offsets = [];
  for (let idx = 0; idx < CS64_COEFFICIENTS.length; idx++) {
    const [coeff, off] = CS64_COEFFICIENTS[idx];
    terms.push(mul32(coeff, factors[idx % 2]));
    offsets.push(off >>> 0);
  }
  const dataWords = wordsLe4Even(Buffer.concat([Buffer.from([0]), dataBuf]));
  for (let idx = 0; idx < dataWords.length; idx++) {
    const w = BigInt(dataWords[idx] >>> 0);
    let term = (w * (idx % 2 === 0 ? keyA : keyB)) & U32_MASK;
    let offset = (BigInt(rol16(Number(w))) * (idx % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn)) & U32_MASK;
    if (idx === 0) {
      term = (term + CS64_ADJUSTMENT0 * BigInt(factors[0])) & U32_MASK;
      offset = (offset + CS64_ADJUSTMENT1) & U32_MASK;
    }
    terms.push(Number(term));
    offsets.push(Number(offset));
  }

  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let idx = 0; idx < terms.length; idx += 2) {
    const x = terms[idx];
    const y = terms[idx + 1];
    let t = rol16((offsets[idx] + x) >>> 0);
    let q = mul32(t, 0x76F50F34);
    swapAcc = (swapAcc + (mul32(rol16(q), 0xC3EFEA97) + q)) >>> 0;

    t = rol16((offsets[idx + 1] + y) >>> 0);
    q = mul32(t, 0x1881CE3C);
    swapLast = (mul32(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;

    state = (mul32(state, Number(keyA)) + x) >>> 0;
    state = mul32(rol16(state), 0xCF98B111);
    state = mul32(rol16(state), 0x87085B9F);
    state = mul32(rol16(state), 0x12CEB96D);
    state = mul32(rol16(state), 0x257E1D83);
    acc = (acc + state) >>> 0;

    t = (mul32(state, Number(keyB)) + y) >>> 0;
    t = mul32(rol16(t), 0xA27416F5);
    t = mul32(rol16(t), 0xD38396FF);
    state = mul32(rol16(mul32(rol16(t), 0x7C932B89)), 0xBFA49F69);
    acc = (acc + state) >>> 0;
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0];
}

export function generateSecMsGecV2(unixSec = Math.floor(Date.now() / 1000)) {
  const secBig = BigInt(Math.floor(unixSec));
  let ticks = secBig + WIN_EPOCH;
  ticks -= ticks % 300n;
  ticks *= 10000000n;
  const dataBuf = Buffer.from(`${ticks.toString()}${TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const digest = customSha256Digest(dataBuf);
  const [cs0, cs1] = cs64Digest(dataBuf, digest);
  const csBuf = Buffer.alloc(8);
  csBuf.writeUInt32LE(cs0 >>> 0, 0);
  csBuf.writeUInt32LE(cs1 >>> 0, 4);
  return `${csBuf.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`;
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function fetchEdgeServerUnixSec() {
  const res = await fetch(
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
    {
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
      },
    }
  );
  const srvDate = res.headers.get('date');
  return srvDate ? Math.floor(new Date(srvDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
}

function buildMaskedWsClientFrame(opcode, payloadBuf) {
  const mask = crypto.randomBytes(4);
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

function createWsFrameParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0F;
      let payloadLen = b1 & 0x7F;
      let offset = 2;
      if (payloadLen === 126) {
        if (buf.length < 4) return;
        payloadLen = buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buf.length < 10) return;
        payloadLen = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (b1 & 0x80) offset += 4;
      if (buf.length < offset + payloadLen) return;
      const payload = buf.subarray(offset, offset + payloadLen);
      buf = buf.subarray(offset + payloadLen);
      onFrame(opcode, payload);
    }
  };
}

export async function synthesizeEdgeNeuralSegment({
  text,
  outMp3Path,
  voice = 'ru-RU-DmitryNeural',
  rate = '+10%',
  pitch = '+0Hz',
  serverUnixSec = null,
}) {
  const unixSec = serverUnixSec || (await fetchEdgeServerUnixSec());
  const secMsGec = generateSecMsGecV2(unixSec);
  const connId = crypto.randomUUID().replace(/-/g, '');
  const muid = crypto.randomBytes(16).toString('hex').toUpperCase();
  const wsPath = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connId}`;

  return new Promise((resolve, reject) => {
    const sock = tls.connect(443, 'speech.platform.bing.com', {
      servername: 'speech.platform.bing.com',
      ALPNProtocols: ['http/1.1'],
    });
    const timeout = setTimeout(() => {
      try { sock.destroy(); } catch {}
      reject(new Error('Edge TTS WebSocket timeout'));
    }, 18000);

    let upgraded = false;
    let headerBuf = Buffer.alloc(0);
    const audioChunks = [];
    const wordTimings = [];
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { sock.end(); } catch {}
      if (err) {
        reject(err);
      } else {
        const audioBuf = Buffer.concat(audioChunks);
        if (audioBuf.length < 256) {
          reject(new Error('Edge TTS returned empty audio'));
          return;
        }
        fs.writeFileSync(outMp3Path, audioBuf);
        resolve({ engine: 'edge-neural-v2', audioPath: outMp3Path, words: wordTimings, bytes: audioBuf.length });
      }
    };

    const feedWs = createWsFrameParser((opcode, payload) => {
      if (opcode === 0x8) {
        finish(audioChunks.length > 0 ? null : new Error('WebSocket closed before turn.end'));
        return;
      }
      if (opcode === 0x9) {
        sock.write(buildMaskedWsClientFrame(0xA, payload));
        return;
      }
      if (opcode === 0x1) {
        const msg = payload.toString('utf8');
        if (msg.includes('Path:audio.metadata')) {
          const sep = msg.indexOf('\r\n\r\n');
          if (sep !== -1) {
            try {
              const meta = JSON.parse(msg.slice(sep + 4));
              for (const item of meta.Metadata || []) {
                if (item?.Type === 'WordBoundary' && item.Data) {
                  wordTimings.push({
                    text: item.Data.text?.Text || '',
                    offsetMs: Math.round((item.Data.Offset || 0) / 10000),
                    durationMs: Math.round((item.Data.Duration || 0) / 10000),
                  });
                }
              }
            } catch {}
          }
        } else if (msg.includes('Path:turn.end')) {
          finish(null);
        }
      } else if (opcode === 0x2) {
        if (payload.length >= 2) {
          const hdrLen = payload.readUInt16BE(0);
          const bodyStart = 2 + hdrLen;
          if (bodyStart < payload.length) {
            const hdrStr = payload.subarray(2, bodyStart).toString('utf8');
            if (hdrStr.includes('Path:audio')) {
              audioChunks.push(payload.subarray(bodyStart));
            }
          }
        }
      }
    });

    sock.on('connect', () => {
      const wsKey = crypto.randomBytes(16).toString('base64');
      sock.write([
        `GET ${wsPath} HTTP/1.1`,
        'Host: speech.platform.bing.com',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        'Sec-WebSocket-Version: 13',
        'Pragma: no-cache',
        'Cache-Control: no-cache',
        'Accept-Encoding: identity',
        'Accept-Language: en-US,en;q=0.9',
        `Cookie: muid=${muid};`,
        'Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
        '', '',
      ].join('\r\n'));
    });

    sock.on('data', (chunk) => {
      if (!upgraded) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const respHead = headerBuf.subarray(0, idx).toString('utf8');
        const statusLine = respHead.split('\r\n')[0] || '';
        if (!statusLine.includes('101')) {
          finish(new Error(`Edge TTS upgrade rejected: ${statusLine}`));
          return;
        }
        upgraded = true;
        const tsStr = new Date().toString();
        const speechCfg = `X-Timestamp:${tsStr}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'true' },
                  outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
                },
              },
            },
          });
        sock.write(buildMaskedWsClientFrame(0x1, Buffer.from(speechCfg, 'utf8')));

        const reqId = crypto.randomUUID().replace(/-/g, '');
        const ssmlBody = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='ru-RU'><voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}'>${escapeXml(text)}</prosody></voice></speak>`;
        const ssmlMsg = `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${tsStr}\r\nPath:ssml\r\n\r\n${ssmlBody}`;
        sock.write(buildMaskedWsClientFrame(0x1, Buffer.from(ssmlMsg, 'utf8')));

        const rest = headerBuf.subarray(idx + 4);
        headerBuf = Buffer.alloc(0);
        if (rest.length > 0) feedWs(rest);
      } else {
        feedWs(chunk);
      }
    });

    sock.on('error', (err) => finish(err));
  });
}

export function probeAudioDurationSec(audioPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ], { encoding: 'utf8', windowsHide: true });
  return Number.parseFloat(out.trim()) || 0;
}

function splitForGoogleTts(text, maxLen = 175) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxLen && cur) {
      chunks.push(cur);
      cur = w;
    } else {
      cur = (cur ? cur + ' ' : '') + w;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function estimateWordTimingsFromText(text, totalMs) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^\p{L}\p{N}]/gu, '').length));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let cursor = 0;
  return tokens.map((tok, idx) => {
    const dur = Math.round((weights[idx] / totalWeight) * totalMs);
    const entry = { text: tok, offsetMs: cursor, durationMs: dur };
    cursor += dur;
    return entry;
  });
}

async function synthesizeGoogleFallbackSegment({ text, outMp3Path }) {
  const parts = splitForGoogleTts(text, 175);
  const bufs = [];
  for (const part of parts) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=ru&client=tw-ob&q=${encodeURIComponent(part)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Google TTS HTTP ${r.status}`);
    bufs.push(Buffer.from(await r.arrayBuffer()));
  }
  const merged = Buffer.concat(bufs);
  fs.writeFileSync(outMp3Path, merged);
  const durMs = Math.round(probeAudioDurationSec(outMp3Path) * 1000);
  return {
    engine: 'google-tts-fallback',
    audioPath: outMp3Path,
    words: estimateWordTimingsFromText(text, durMs),
    bytes: merged.length,
  };
}

function synthesizeWinRtFallbackSegment({ text, outMp3Path }) {
  const wavPath = outMp3Path.replace(/\.mp3$/i, '.wav');
  const txtPath = outMp3Path.replace(/\.mp3$/i, '.txt');
  fs.writeFileSync(txtPath, text, 'utf8');
  const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$pavel = $synth.AllVoices | Where-Object { $_.Language -eq 'ru-RU' -and $_.Gender -eq 'Male' } | Select-Object -First 1
if (-not $pavel) { $pavel = $synth.AllVoices | Where-Object { $_.Language -like 'ru*' } | Select-Object -First 1 }
if ($pavel) { $synth.Voice = $pavel }
$synth.Options.SpeakingRate = 1.15
$text = Get-Content -Raw -Encoding UTF8 '${txtPath.replace(/'/g, "''")}'
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod })[0]
$op = $synth.SynthesizeTextToStreamAsync($text)
$task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op))
$stream = $task.GetAwaiter().GetResult()
$reader = New-Object Windows.Storage.Streams.DataReader($stream)
$null = $reader.LoadAsync([uint32]$stream.Size).GetAwaiter().GetResult()
$bytes = New-Object byte[] $stream.Size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes('${wavPath.replace(/'/g, "''")}', $bytes)
`;
  execFileSync('powershell', ['-NoProfile', '-Command', psScript], { windowsHide: true, stdio: 'ignore' });
  execFileSync('ffmpeg', ['-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '96k', outMp3Path], { windowsHide: true, stdio: 'ignore' });
  try { fs.unlinkSync(wavPath); } catch {}
  try { fs.unlinkSync(txtPath); } catch {}
  const durMs = Math.round(probeAudioDurationSec(outMp3Path) * 1000);
  return {
    engine: 'winrt-pavel-fallback',
    audioPath: outMp3Path,
    words: estimateWordTimingsFromText(text, durMs),
    bytes: fs.statSync(outMp3Path).size,
  };
}

/**
 * Synthesizes an array of Russian voiceover segments with Edge Neural TTS v2 (+ fallbacks)
 * and measures exact audio durations.
 */
export async function synthesizeRussianVoiceover(segments, outDir, options = {}) {
  const voice = options.voice || 'ru-RU-DmitryNeural';
  const rate = options.rate || '+12%';
  const pitch = options.pitch || '+0Hz';
  fs.mkdirSync(outDir, { recursive: true });

  let serverUnixSec = null;
  try {
    serverUnixSec = await fetchEdgeServerUnixSec();
  } catch {}

  const results = [];
  for (const seg of segments) {
    const mp3Path = path.join(outDir, `${seg.id}.mp3`);
    const segRate = seg.rate || rate;
    const segPitch = seg.pitch || pitch;
    let res = null;
    let lastEdgeErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        res = await synthesizeEdgeNeuralSegment({
          text: seg.ttsText || seg.text,
          outMp3Path: mp3Path,
          voice,
          rate: segRate,
          pitch: segPitch,
          serverUnixSec,
        });
        break;
      } catch (edgeErr) {
        lastEdgeErr = edgeErr;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 350 * attempt));
      }
    }
    if (!res) {
      try {
        res = await synthesizeGoogleFallbackSegment({ text: seg.ttsText || seg.text, outMp3Path: mp3Path });
      } catch {
        res = synthesizeWinRtFallbackSegment({ text: seg.ttsText || seg.text, outMp3Path: mp3Path });
      }
      res.fallbackReason = lastEdgeErr?.message || 'edge_tts_failed';
    }

    const durationSec = probeAudioDurationSec(mp3Path);
    results.push({
      id: seg.id,
      displayText: seg.displayText || seg.text,
      ttsText: seg.ttsText || seg.text,
      durationSec,
      ...res,
    });
  }
  return results;
}
