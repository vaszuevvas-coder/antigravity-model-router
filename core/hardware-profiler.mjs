/**
 * @file hardware-profiler.mjs
 * @description Cross-platform hardware profiler (CPU, RAM, NVIDIA/AMD/Intel/Apple GPU, Ollama)
 * for safe zero-crash first-run auto-calibration and AI-assisted model tuning.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJsonSync, safeReadJsonSync, updateJsonAtomicSync } from './safe-json.mjs';
import { normalizeLang } from './i18n.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = join(__dirname, '..');
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
const GPU_PROBE_TTL_MS = 60 * 1000;

let memoryGpuProbeCache = { ts: 0, key: '', data: null };

function clampInt(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function classifyCpuVendor(modelStr = '', arch = '') {
  const lower = String(modelStr || '').toLowerCase();
  if (lower.includes('apple') || (arch === 'arm64' && process.platform === 'darwin')) return 'apple';
  if (lower.includes('intel')) return 'intel';
  if (lower.includes('amd') || lower.includes('ryzen') || lower.includes('epyc') || lower.includes('threadripper')) return 'amd';
  if (arch.startsWith('arm') || arch === 'aarch64') return 'arm';
  return 'other';
}

/**
 * Computes safe RAM cache budget (MB) based on total system memory.
 * @param {number} totalRamMb
 * @returns {number}
 */
export function computeRecommendedRamBudgetMb(totalRamMb) {
  const mb = Math.max(1024, Number(totalRamMb) || 8192);
  if (mb <= 8700) return 1024;    // <= 8 GB RAM -> 1 GB
  if (mb <= 12800) return 2048;   // 10-12 GB RAM -> 2 GB
  if (mb <= 17000) return 4096;   // 16 GB RAM -> 4 GB
  if (mb <= 25600) return 6144;   // 24 GB RAM -> 6 GB
  if (mb <= 34000) return 8192;   // 32 GB RAM -> 8 GB
  if (mb <= 52000) return 12288;  // 48 GB RAM -> 12 GB
  if (mb <= 72000) return 16384;  // 64 GB RAM -> 16 GB
  return 24576;                   // 96-128+ GB RAM -> 24 GB
}

/**
 * Computes safe CPU worker pool thread cap based on logical core count.
 * @param {number} logicalCores
 * @returns {number}
 */
export function computeRecommendedCpuThreads(logicalCores) {
  const cores = Math.max(1, Math.round(Number(logicalCores) || 4));
  if (cores <= 4) return 2;
  if (cores <= 8) return 4;
  if (cores <= 12) return 6;
  if (cores <= 16) return 10;
  if (cores <= 20) return 12;
  if (cores <= 24) return 16;
  return Math.min(24, cores - 8);
}

/**
 * Computes upper safe RAM cache budget ceiling (~50% of physical RAM, aligned to UI steps).
 * @param {number} totalRamMb
 * @returns {number}
 */
export function computeMaxRamBudgetMb(totalRamMb) {
  const mb = Math.max(1024, Number(totalRamMb) || 8192);
  if (mb <= 5120) return 2048;    // <= 5 GB RAM -> max 2 GB
  if (mb <= 8700) return 4096;    // 6-8 GB RAM -> max 4 GB
  if (mb <= 12800) return 6144;   // 10-12 GB RAM -> max 6 GB
  if (mb <= 17500) return 8192;   // 16 GB RAM -> max 8 GB
  if (mb <= 26000) return 12288;  // 24 GB RAM -> max 12 GB
  if (mb <= 35000) return 16384;  // 32 GB RAM -> max 16 GB
  if (mb <= 52000) return 24576;  // 48 GB RAM -> max 24 GB
  return 32768;                   // 64+ GB RAM -> max 32 GB
}

/**
 * Computes upper selectable GPU VRAM ceiling from physical GPU memory (with ~6% driver tolerance).
 * @param {object|null} [gpu=null]
 * @returns {number}
 */
export function computeMaxVramCapMb(gpu = null) {
  const totalMb = Math.max(0, Number(gpu?.totalMb) || 0);
  const isUsable = Boolean(gpu && (gpu.available || gpu.isDiscrete || gpu.vendor === 'apple') && totalMb >= 3500);
  if (!isUsable) return 4096;
  if (totalMb >= 30720) return 32768; // ~32+ GB
  if (totalMb >= 22528) return 24576; // ~24 GB
  if (totalMb >= 15360) return 16384; // ~16 GB (e.g. 16376 MB in nvidia-smi)
  if (totalMb >= 13312) return 14336; // ~14-15 GB
  if (totalMb >= 11264) return 12288; // ~12 GB
  if (totalMb >= 7168) return 8192;   // ~8 GB
  if (totalMb >= 5120) return 6144;   // ~6 GB
  return 4096;                        // ~4 GB
}

/**
 * Computes upper safe CPU pool thread ceiling matching resolveCpuThreadBudget().
 * @param {number} logicalCores
 * @returns {number}
 */
export function computeMaxCpuThreads(logicalCores) {
  const cores = Math.max(1, Math.round(Number(logicalCores) || 4));
  return Math.max(2, Math.min(64, cores - 4));
}

/**
 * Detects CPU brand/threads and system RAM without spawning external processes (<0.5ms).
 * @param {object} [opts]
 */
export function detectCpuAndRam(opts = {}) {
  const platform = opts.platformOverride || process.platform;
  const arch = opts.archOverride || process.arch;
  const cpus = Array.isArray(opts.cpusOverride) ? opts.cpusOverride : (os.cpus() || []);
  const logicalCores = Math.max(1, cpus.length || 4);
  const rawModel = String(cpus[0]?.model || 'Generic Multi-Core CPU').replace(/\s+/g, ' ').trim();
  const vendor = classifyCpuVendor(rawModel, arch);

  const totalBytes = Number(opts.totalMemBytesOverride ?? os.totalmem()) || (8 * 1024 ** 3);
  const freeBytes = Number(opts.freeMemBytesOverride ?? os.freemem()) || Math.round(totalBytes * 0.35);
  const totalRamMb = Math.max(1024, Math.round(totalBytes / (1024 * 1024)));
  const freeRamMb = Math.max(256, Math.round(freeBytes / (1024 * 1024)));
  const totalRamGb = Math.max(1, Math.round(totalRamMb / 1024));

  return {
    platform,
    arch,
    cpuModel: rawModel,
    cpuVendor: vendor,
    logicalCores,
    isLowPowerCpu: logicalCores <= 6,
    totalRamMb,
    freeRamMb,
    totalRamGb,
    recommendedRamBudgetMb: computeRecommendedRamBudgetMb(totalRamMb),
    recommendedCpuThreads: computeRecommendedCpuThreads(logicalCores),
  };
}

function classifyGpuAdapterName(name = '', totalMb = 0) {
  const raw = String(name || '').trim();
  const lower = raw.toLowerCase();

  const isVirtual = /(?:microsoft basic|remote desktop|parsec|hyper-v|vmware|virtualbox|citrix|spacedesk|luminon|indirect display)/i.test(lower);
  let vendor = 'other';
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/i.test(lower)) vendor = 'nvidia';
  else if (/\bamd\b|radeon|ryzen|firepro/i.test(lower)) vendor = 'amd';
  else if (/intel|arc\b|iris|uhd|hd graphics/i.test(lower)) vendor = 'intel';
  else if (/apple|m1|m2|m3|m4/i.test(lower)) vendor = 'apple';

  const looksIntegrated =
    vendor === 'intel'
      ? !/\barc\b/i.test(lower) || /\b(?:uhd|hd graphics|iris)\b/i.test(lower)
      : vendor === 'amd'
        ? (/\bradeon\(tm\)\s+graphics\b/i.test(lower) || (totalMb > 0 && totalMb <= 2048 && !/\brx\s*\d/i.test(lower)))
        : false;

  const isDiscrete = !isVirtual && (vendor === 'nvidia' || vendor === 'apple' || (!looksIntegrated && (vendor === 'amd' || vendor === 'intel') && totalMb >= 3500));

  let backendHint = 'cpu';
  if (vendor === 'nvidia') backendHint = 'cuda';
  else if (vendor === 'amd') backendHint = isDiscrete ? 'rocm_or_vulkan' : 'vulkan_igpu';
  else if (vendor === 'intel') backendHint = isDiscrete ? 'vulkan' : 'vulkan_igpu';
  else if (vendor === 'apple') backendHint = 'metal';

  return { vendor, isVirtual, isDiscrete, backendHint };
}

function probeWindowsWmiAndRegistryGpu(execFn) {
  const psScript = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
    '$ErrorActionPreference="SilentlyContinue";',
    '$reg=@();',
    'Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*" | ForEach-Object {',
    '  $n=$_."DriverDesc"; $q=$_."HardwareInformation.qwMemorySize"; [int64]$b=0;',
    '  if($q -is [byte[]]){ if($q.Length -ge 8){ $b=[BitConverter]::ToInt64($q,0) } elseif($q.Length -ge 4){ $b=[int64][BitConverter]::ToUInt32($q,0) } }',
    '  elseif($null -ne $q){ $b=[int64]($q -as [int64]) };',
    '  if($n){ $reg += [PSCustomObject]@{ name=[string]$n; bytes=$b } }',
    '};',
    'if($reg.Count -eq 0){',
    '  Get-CimInstance Win32_VideoController | ForEach-Object {',
    '    if($_.Name){ $reg += [PSCustomObject]@{ name=[string]$_.Name; bytes=[int64]($_.AdapterRAM -as [int64]) } }',
    '  }',
    '};',
    '$reg | ConvertTo-Json -Compress',
  ].join(' ');

  const out = execFn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { encoding: 'utf8', timeout: 1800, windowsHide: true }
  );
  const trimmed = String(out || '').trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .filter((x) => x && x.name)
    .map((x) => {
      const bytes = Math.max(0, Number(x.bytes) || 0);
      const totalMb = bytes > 0 ? Math.round(bytes / (1024 * 1024)) : 0;
      const meta = classifyGpuAdapterName(x.name, totalMb);
      return {
        name: String(x.name).trim(),
        totalMb,
        ...meta,
      };
    })
    .filter((x) => !x.isVirtual);
}

function probeLinuxSysfsGpu(sysfsDir = '/sys/class/drm', execFn = execFileSync) {
  if (!existsSync(sysfsDir)) return [];
  const entries = readdirSync(sysfsDir).filter((n) => /^card\d+$/.test(n));
  const adapters = [];

  for (const card of entries) {
    try {
      const devDir = join(sysfsDir, card, 'device');
      const vendorHex = existsSync(join(devDir, 'vendor'))
        ? readFileSync(join(devDir, 'vendor'), 'utf8').trim().toLowerCase()
        : '';
      const vramPath = join(devDir, 'mem_info_vram_total');
      const vramUsedPath = join(devDir, 'mem_info_vram_used');
      const totalBytes = existsSync(vramPath) ? Number(readFileSync(vramPath, 'utf8').trim()) || 0 : 0;
      const usedBytes = existsSync(vramUsedPath) ? Number(readFileSync(vramUsedPath, 'utf8').trim()) || 0 : 0;
      const totalMb = totalBytes > 0 ? Math.round(totalBytes / (1024 * 1024)) : 0;
      const usedMb = usedBytes > 0 ? Math.round(usedBytes / (1024 * 1024)) : 0;

      let vendor = 'other';
      let label = `Linux DRM ${card}`;
      if (vendorHex === '0x1002') {
        vendor = 'amd';
        label = totalMb >= 4096 ? 'AMD Radeon GPU' : 'AMD Radeon Graphics';
      } else if (vendorHex === '0x8086') {
        vendor = 'intel';
        label = totalMb >= 4096 ? 'Intel Arc GPU' : 'Intel Integrated Graphics';
      } else if (vendorHex === '0x10de') {
        vendor = 'nvidia';
        label = 'NVIDIA GPU';
      } else {
        continue;
      }

      const meta = classifyGpuAdapterName(label, totalMb);
      adapters.push({
        name: label,
        totalMb,
        usedMb,
        freeMb: totalMb > usedMb ? totalMb - usedMb : 0,
        vendor,
        isDiscrete: meta.isDiscrete || totalMb >= 4096,
        backendHint: meta.backendHint,
        vramReliable: totalMb > 0,
      });
    } catch {}
  }

  if (adapters.length > 0 && typeof execFn === 'function') {
    try {
      const lspciOut = execFn('lspci', [], { encoding: 'utf8', timeout: 800 });
      const vgaLines = String(lspciOut || '')
        .split(/\r?\n/)
        .filter((l) => /(?:VGA compatible controller|3D controller|Display controller)/i.test(l));
      for (const ad of adapters) {
        const matchLine = vgaLines.find((l) =>
          (ad.vendor === 'amd' && /AMD|ATI|Radeon/i.test(l)) ||
          (ad.vendor === 'intel' && /Intel/i.test(l))
        );
        if (matchLine) {
          const cleanName = matchLine.replace(/^[^:]+:\s*[^:]+:\s*/, '').trim();
          if (cleanName) ad.name = cleanName;
        }
      }
    } catch {}
  }

  return adapters;
}

function pickBestAdapter(adapters = []) {
  if (!Array.isArray(adapters) || adapters.length === 0) return null;
  const scored = [...adapters].sort((a, b) => {
    const discDiff = Number(Boolean(b.isDiscrete)) - Number(Boolean(a.isDiscrete));
    if (discDiff !== 0) return discDiff;
    return (Number(b.totalMb) || 0) - (Number(a.totalMb) || 0);
  });
  return scored[0] || null;
}

/**
 * Multi-vendor GPU detector (NVIDIA CUDA, AMD ROCm/Vulkan, Intel Arc/iGPU, Apple Metal, CPU fallback).
 * Never throws; caches non-NVIDIA results for 60s to avoid repeated shell probes.
 * @param {object} [opts]
 */
export function probeAnyGpu(opts = {}) {
  const force = Boolean(opts.force);
  const platform = opts.platformOverride || process.platform;
  const arch = opts.archOverride || process.arch;
  const execFn = opts.execProbeFn || execFileSync;
  const cacheKey = `${platform}:${arch}:${opts.linuxSysfsDir || ''}`;
  const now = Date.now();

  if (
    !force &&
    !opts.nvidiaProbeFn &&
    !opts.execProbeFn &&
    memoryGpuProbeCache.data &&
    memoryGpuProbeCache.key === cacheKey &&
    now - memoryGpuProbeCache.ts < GPU_PROBE_TTL_MS
  ) {
    return memoryGpuProbeCache.data;
  }

  // 1. NVIDIA fast-path via nvidia-smi (exact live VRAM + temperature)
  try {
    if (typeof opts.nvidiaProbeFn === 'function') {
      const nv = opts.nvidiaProbeFn();
      if (nv && nv.available) {
        const enriched = {
          available: true,
          vendor: 'nvidia',
          isDiscrete: true,
          backendHint: 'cuda',
          vramReliable: true,
          name: nv.name,
          totalMb: Number(nv.totalMb) || 0,
          usedMb: Number(nv.usedMb) || 0,
          freeMb: Number(nv.freeMb) || 0,
          tempC: Number(nv.tempC) || 0,
          utilPct: Number(nv.utilPct) || 0,
        };
        return enriched;
      }
    } else {
      const out = execFn(
        'nvidia-smi',
        [
          '--query-gpu=name,memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu',
          '--format=csv,noheader,nounits',
        ],
        { encoding: 'utf8', timeout: 1000, windowsHide: true }
      ).trim();
      const firstLine = out.split(/\r?\n/)[0] || '';
      const parts = firstLine.split(',').map((s) => s.trim());
      if (parts.length >= 4 && parts[0]) {
        const res = {
          available: true,
          vendor: 'nvidia',
          isDiscrete: true,
          backendHint: 'cuda',
          vramReliable: true,
          name: parts[0],
          totalMb: Number(parts[1]) || 0,
          usedMb: Number(parts[2]) || 0,
          freeMb: Number(parts[3]) || 0,
          tempC: Number(parts[4]) || 0,
          utilPct: Number(parts[5]) || 0,
        };
        memoryGpuProbeCache = { ts: now, key: cacheKey, data: res };
        return res;
      }
    }
  } catch {}

  // 2. macOS Apple Silicon Unified Memory fast-path
  if (platform === 'darwin' && arch === 'arm64') {
    const totalMemBytes = Number(opts.totalMemBytesOverride ?? os.totalmem()) || (16 * 1024 ** 3);
    const totalSysMb = Math.round(totalMemBytes / (1024 * 1024));
    const unifiedGpuMb = Math.max(4096, Math.round(totalSysMb * 0.65));
    const cpuModel = String(os.cpus()?.[0]?.model || 'Apple Silicon').trim();
    const res = {
      available: true,
      vendor: 'apple',
      isDiscrete: true,
      backendHint: 'metal',
      vramReliable: true,
      name: `${cpuModel} (Unified Memory)`,
      totalMb: unifiedGpuMb,
      usedMb: 0,
      freeMb: unifiedGpuMb,
      tempC: 0,
      utilPct: 0,
    };
    memoryGpuProbeCache = { ts: now, key: cacheKey, data: res };
    return res;
  }

  // 3. Windows AMD Radeon / Intel Arc / iGPU probe via Registry QWORD + CIM
  if (platform === 'win32') {
    try {
      const adapters = probeWindowsWmiAndRegistryGpu(execFn);
      const best = pickBestAdapter(adapters);
      if (best) {
        const usable = Boolean(best.isDiscrete && best.totalMb >= 3500);
        const res = {
          available: usable,
          vendor: best.vendor,
          isDiscrete: Boolean(best.isDiscrete),
          backendHint: best.backendHint,
          vramReliable: best.totalMb > 0,
          name: best.name,
          totalMb: best.totalMb,
          usedMb: 0,
          freeMb: usable ? Math.max(0, best.totalMb - 1024) : 0,
          tempC: 0,
          utilPct: 0,
        };
        memoryGpuProbeCache = { ts: now, key: cacheKey, data: res };
        return res;
      }
    } catch {}
  }

  // 4. Linux AMD / Intel DRM sysfs probe
  if (platform === 'linux') {
    try {
      const adapters = probeLinuxSysfsGpu(opts.linuxSysfsDir || '/sys/class/drm', execFn);
      const best = pickBestAdapter(adapters);
      if (best) {
        const usable = Boolean(best.isDiscrete && best.totalMb >= 3500);
        const res = {
          available: usable,
          vendor: best.vendor,
          isDiscrete: Boolean(best.isDiscrete),
          backendHint: best.backendHint,
          vramReliable: Boolean(best.vramReliable),
          name: best.name,
          totalMb: best.totalMb,
          usedMb: best.usedMb || 0,
          freeMb: best.freeMb || (usable ? Math.max(0, best.totalMb - 1024) : 0),
          tempC: 0,
          utilPct: 0,
        };
        memoryGpuProbeCache = { ts: now, key: cacheKey, data: res };
        return res;
      }
    } catch {}
  }

  const fallback = {
    available: false,
    vendor: 'none',
    isDiscrete: false,
    backendHint: 'cpu',
    vramReliable: false,
    name: 'Дискретная GPU не обнаружена (режим CPU + RAM)',
    nameEn: 'No discrete GPU detected (CPU + RAM mode)',
    totalMb: 0,
    usedMb: 0,
    freeMb: 0,
    tempC: 0,
    utilPct: 0,
  };
  memoryGpuProbeCache = { ts: now, key: cacheKey, data: fallback };
  return fallback;
}

function findOllamaBinaryPassive() {
  if (process.platform === 'win32') {
    const candidates = [
      join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
      'C:\\Program Files\\Ollama\\ollama.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    try {
      const out = execFileSync('where.exe', ['ollama'], { encoding: 'utf8', timeout: 700, windowsHide: true }).trim();
      const first = out.split(/\r?\n/)[0]?.trim();
      if (first && existsSync(first)) return first;
    } catch {}
    return null;
  }
  try {
    const out = execFileSync('which', ['ollama'], { encoding: 'utf8', timeout: 700 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function fetchJsonFast(endpoint, urlPath, timeoutMs = 550) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlPath, endpoint);
    } catch {
      return resolve({ ok: false });
    }
    const mod = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = mod.request(
      {
        hostname: u.hostname,
        port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try {
            const data = raw ? JSON.parse(raw) : {};
            finish({ ok: res.statusCode >= 200 && res.statusCode < 300, data });
          } catch {
            finish({ ok: false });
          }
        });
      }
    );
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      finish({ ok: false });
    });
    req.on('error', () => finish({ ok: false }));
    req.end();
  });
}

/**
 * Passively checks whether Ollama is installed and what models are already pulled (does NOT spawn Ollama).
 * @param {object} [opts]
 */
export async function probeOllamaSummary(opts = {}) {
  const endpoint = String(opts.endpoint || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const binaryPath = typeof opts.binaryProbeFn === 'function' ? opts.binaryProbeFn() : findOllamaBinaryPassive();
  const tagsRes = typeof opts.httpProbeFn === 'function'
    ? await opts.httpProbeFn(endpoint, '/api/tags')
    : await fetchJsonFast(endpoint, '/api/tags', 550);

  const downloadedModels = Array.isArray(tagsRes?.data?.models)
    ? tagsRes.data.models.map((m) => ({
        name: String(m.name || ''),
        sizeGb: Number(((Number(m.size) || 0) / (1024 ** 3)).toFixed(2)),
      }))
    : [];

  return {
    installed: Boolean(binaryPath || tagsRes?.ok),
    binaryPath: binaryPath || null,
    running: Boolean(tagsRes?.ok),
    downloadedModels,
  };
}

export const HF_GGUF_FALLBACK_MAP = Object.freeze({
  'qwen3:4b': { hfTag: 'hf.co/Qwen/Qwen3-4B-GGUF:Q4_K_M', approxDiskGb: 2.5, role: 'chat' },
  'qwen3:1.7b': { hfTag: 'hf.co/Qwen/Qwen3-1.7B-GGUF:Q4_K_M', approxDiskGb: 1.4, role: 'chat' },
  'qwen2.5-coder:3b': { hfTag: 'hf.co/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M', approxDiskGb: 1.9, role: 'chat' },
  'gemma4:12b': { hfTag: '', approxDiskGb: 8.0, role: 'chat' },
  'qwen3-embedding:0.6b': { hfTag: 'hf.co/Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0', approxDiskGb: 0.64, role: 'embed' },
  'qwen3-embedding:4b': { hfTag: 'hf.co/Qwen/Qwen3-Embedding-4B-GGUF:Q4_K_M', approxDiskGb: 2.5, role: 'embed' },
  'qwen3-embedding:8b': { hfTag: 'hf.co/Qwen/Qwen3-Embedding-8B-GGUF:Q4_K_M', approxDiskGb: 4.7, role: 'embed' },
});

function normProfilerOllamaTag(name = '') {
  const clean = String(name || '').trim().toLowerCase();
  if (!clean) return '';
  return clean.includes(':') ? clean : `${clean}:latest`;
}

/**
 * Resolves the optimal Chat + Embed Ollama model pair for a given VRAM budget (MB) without RAM swap.
 * @param {number} [vramCapMb=4096]
 */
export function resolveGpuModelPairForVramCap(vramCapMb = 4096) {
  const cap = Math.max(2048, Number(vramCapMb) || 4096);
  if (cap >= 20480) {
    return {
      vramCapMb: cap,
      tierKey: 'ultra_20gb_plus',
      labelRu: 'Ультра (20+ ГБ): gemma4:12b + qwen3-embedding:8b',
      labelEn: 'Ultra (20+ GB): gemma4:12b + qwen3-embedding:8b',
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:8b',
      gpuContextTokens: 16384,
      estTotalVramMb: 14500,
    };
  }
  if (cap >= 14336) {
    return {
      vramCapMb: cap,
      tierKey: 'workstation_14_16gb',
      labelRu: 'Максимум 16 ГБ (14–16 ГБ): gemma4:12b + qwen3-embedding:4b',
      labelEn: 'Max 16 GB (14–16 GB): gemma4:12b + qwen3-embedding:4b',
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:4b',
      gpuContextTokens: 16384,
      estTotalVramMb: 12100,
    };
  }
  if (cap >= 12288) {
    return {
      vramCapMb: cap,
      tierKey: 'large_chat_12gb',
      labelRu: 'Крупный чат (12 ГБ): gemma4:12b + qwen3-embedding:0.6b',
      labelEn: 'Large Chat (12 GB): gemma4:12b + qwen3-embedding:0.6b',
      gpuChatModel: 'gemma4:12b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuContextTokens: 12288,
      estTotalVramMb: 10100,
    };
  }
  if (cap >= 8192) {
    return {
      vramCapMb: cap,
      tierKey: 'balanced_8_10gb',
      labelRu: 'Средний (8–10 ГБ): qwen3:4b + qwen3-embedding:4b',
      labelEn: 'Balanced (8–10 GB): qwen3:4b + qwen3-embedding:4b',
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:4b',
      gpuContextTokens: 12288,
      estTotalVramMb: 5800,
    };
  }
  return {
    vramCapMb: cap,
    tierKey: 'compact_4_6gb',
    labelRu: 'Компакт (4–6 ГБ): qwen3:4b + qwen3-embedding:0.6b',
    labelEn: 'Compact (4–6 GB): qwen3:4b + qwen3-embedding:0.6b',
    gpuChatModel: 'qwen3:4b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
    gpuContextTokens: 8192,
    estTotalVramMb: 3850,
  };
}

/**
 * Builds a deduplicated cascade download bundle covering all VRAM tiers up to the physical GPU VRAM.
 * @param {number} [totalVramMb=0]
 * @param {{ mode?: 'cascade'|'active_only', selectedCapMb?: number, downloadedModels?: Array }} [opts={}]
 */
export function buildGpuCascadeBundleForHardware(
  totalVramMb = 0,
  { mode = 'cascade', selectedCapMb = 0, downloadedModels = [] } = {}
) {
  const rawTotal = Math.max(0, Number(totalVramMb) || 0);
  const effectivePhysicalMb = rawTotal > 0 ? rawTotal : Math.max(4096, Number(selectedCapMb) || 4096);
  let maxUsableCapMb = 4096;
  if (effectivePhysicalMb >= 20480) maxUsableCapMb = 20480;
  else if (effectivePhysicalMb >= 15360) maxUsableCapMb = 14336;
  else if (effectivePhysicalMb >= 11264) maxUsableCapMb = 12288;
  else if (effectivePhysicalMb >= 7168) maxUsableCapMb = 8192;

  const installedSet = new Set();
  for (const item of Array.isArray(downloadedModels) ? downloadedModels : []) {
    const rawName = typeof item === 'string' ? item : (item?.name || item?.model || '');
    const norm = normProfilerOllamaTag(rawName);
    if (norm) installedSet.add(norm);
  }

  const tierCaps = [4096, 8192, 12288, 14336, 20480];
  const selectedCaps = mode === 'active_only'
    ? [Math.max(4096, Number(selectedCapMb) || maxUsableCapMb)]
    : tierCaps.filter((c) => c <= maxUsableCapMb);

  const orderedTags = [];
  const seenTags = new Set();
  for (const cap of selectedCaps) {
    const pair = resolveGpuModelPairForVramCap(cap);
    for (const tag of [pair.gpuEmbedModel, pair.gpuChatModel]) {
      const norm = normProfilerOllamaTag(tag);
      if (!norm || seenTags.has(norm)) continue;
      seenTags.add(norm);
      orderedTags.push(tag);
    }
  }

  const models = orderedTags.map((name) => {
    const norm = normProfilerOllamaTag(name);
    const meta = HF_GGUF_FALLBACK_MAP[norm] || { hfTag: '', approxDiskGb: 2.5, role: /embed/i.test(norm) ? 'embed' : 'chat' };
    return {
      name,
      role: meta.role,
      approxDiskGb: Number(meta.approxDiskGb || 0),
      hfFallbackTag: meta.hfTag || '',
      alreadyDownloaded: installedSet.has(norm),
    };
  });

  const missingModels = models.filter((m) => !m.alreadyDownloaded);
  const approxMissingDiskGb = Number(missingModels.reduce((s, m) => s + (m.approxDiskGb || 0), 0).toFixed(2));
  const approxTotalDiskGb = Number(models.reduce((s, m) => s + (m.approxDiskGb || 0), 0).toFixed(2));

  return {
    mode: mode === 'active_only' ? 'active_only' : 'cascade',
    maxUsableCapMb,
    models,
    missingModels,
    approxMissingDiskGb,
    approxTotalDiskGb,
  };
}

/**
 * Generates deterministic, zero-crash router-state recommendations for any PC & subscription tier.
 * @param {object} params
 */
export function recommendHardwareSettings({
  system = detectCpuAndRam(),
  gpu = { available: false, vendor: 'none', isDiscrete: false, totalMb: 0 },
  ollama = { installed: false, running: false, downloadedModels: [] },
  subscriptionTier = 'pro',
} = {}) {
  const cleanSub = subscriptionTier === 'ultra' ? 'ultra' : 'pro';
  const vramMb = Math.max(0, Number(gpu?.totalMb) || 0);
  const isUsableGpu = Boolean(gpu?.available && (gpu?.isDiscrete || gpu?.vendor === 'apple') && vramMb >= 4096);
  const downloaded = Array.isArray(ollama?.downloadedModels) ? ollama.downloadedModels : [];
  const downloadedSet = new Set(downloaded.map((m) => normProfilerOllamaTag(m?.name || m?.model || '')).filter(Boolean));

  let tierId = 'cpu_ram_only';
  let tierLabelRu = 'Контур CPU + RAM (без нагрузки на видеокарту)';
  let tierLabelEn = 'CPU + RAM Pipeline (no GPU load)';
  let gpuPreset = {
    gpuMaxVramMb: 4096,
    gpuChatModel: 'qwen3:4b',
    gpuEmbedModel: 'qwen3-embedding:0.6b',
    gpuEmbedKeepAlive: '90m',
    gpuContextTokens: 4096,
    gpuAutoDistillLogs: false,
    gpuSemanticSearch: false,
  };

  if (isUsableGpu && vramMb >= 11264) {
    tierId = 'workstation_12gb_plus';
    const capMb = vramMb >= 15360 ? 14336 : 12288;
    const pair = resolveGpuModelPairForVramCap(capMb);
    const preferredEmbed =
      downloadedSet.size > 0 &&
      !downloadedSet.has(normProfilerOllamaTag(pair.gpuEmbedModel)) &&
      downloadedSet.has('qwen3-embedding:0.6b')
        ? 'qwen3-embedding:0.6b'
        : pair.gpuEmbedModel;
    const vramGb = Math.round(vramMb / 1024);
    tierLabelRu = `Мощная GPU (${vramGb} ГБ VRAM) · Полная дистилляция логов + семантический индекс`;
    tierLabelEn = `High-VRAM GPU (${vramGb} GB VRAM) · Full log distillation + semantic index`;
    gpuPreset = {
      gpuMaxVramMb: capMb,
      gpuChatModel: pair.gpuChatModel,
      gpuEmbedModel: preferredEmbed,
      gpuEmbedKeepAlive: '90m',
      gpuContextTokens: pair.gpuContextTokens,
      gpuAutoDistillLogs: true,
      gpuSemanticSearch: true,
    };
  } else if (isUsableGpu && vramMb >= 7168) {
    tierId = 'mid_gpu_8gb';
    const vramGb = Math.round(vramMb / 1024);
    tierLabelRu = `Средняя GPU (${vramGb} ГБ VRAM) · Облегчённая модель 4B без свопа в ОЗУ`;
    tierLabelEn = `Mid-Range GPU (${vramGb} GB VRAM) · Lightweight 4B model with zero RAM swap`;
    gpuPreset = {
      gpuMaxVramMb: 6144,
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEmbedKeepAlive: '90m',
      gpuContextTokens: 8192,
      gpuAutoDistillLogs: true,
      gpuSemanticSearch: true,
    };
  } else if (isUsableGpu && vramMb >= 4096) {
    tierId = 'entry_gpu_4_6gb';
    const vramGb = Math.round(vramMb / 1024);
    tierLabelRu = `Начальная GPU (${vramGb} ГБ VRAM) · Компактный индекс 0.6B + 4B`;
    tierLabelEn = `Entry GPU (${vramGb} GB VRAM) · Compact 0.6B + 4B pipeline`;
    gpuPreset = {
      gpuMaxVramMb: 4096,
      gpuChatModel: 'qwen3:4b',
      gpuEmbedModel: 'qwen3-embedding:0.6b',
      gpuEmbedKeepAlive: '45m',
      gpuContextTokens: 8192,
      gpuAutoDistillLogs: false,
      gpuSemanticSearch: true,
    };
  }

  // Respect already-downloaded compatible chat model in Ollama if it fits VRAM
  const maxModelSizeGb = Math.max(1.5, (gpuPreset.gpuMaxVramMb - 1024) / 1024);
  const matchingPulledChat = downloaded.find(
    (m) =>
      m.name &&
      !/embed/i.test(m.name) &&
      m.sizeGb > 0.5 &&
      m.sizeGb <= maxModelSizeGb &&
      /^(?:gemma4|qwen3|llama3|mistral|deepseek|phi4)/i.test(m.name)
  );
  if (matchingPulledChat && tierId !== 'workstation_12gb_plus') {
    gpuPreset.gpuChatModel = matchingPulledChat.name;
  }

  const gpuAutoEnable = Boolean(isUsableGpu && ollama?.installed);

  let vendorTipRu = 'Вся экономия токенов работает через многопоточный CPU и In-RAM буфер — видеокарта не требуется.';
  let vendorTipEn = 'Full token savings work via multi-threaded CPU and In-RAM buffer — no GPU required.';
  if (gpu?.vendor === 'nvidia' && isUsableGpu) {
    vendorTipRu = ollama?.installed
      ? 'Обнаружена NVIDIA CUDA + Ollama: готово к аппаратному ускорению без доп. настроек.'
      : 'Обнаружена видеокарта NVIDIA, но Ollama не установлена — GPU-помощник безопасно выключен (можно включить после установки Ollama).';
    vendorTipEn = ollama?.installed
      ? 'NVIDIA CUDA + Ollama detected: ready for hardware acceleration out of the box.'
      : 'NVIDIA GPU detected, but Ollama is not installed yet — GPU assistant safely disabled until Ollama is installed.';
  } else if (gpu?.vendor === 'amd') {
    vendorTipRu = isUsableGpu
      ? 'Видеокарта AMD Radeon: Ollama поддерживает ускорение через ROCm / Vulkan (при необходимости задайте OLLAMA_VULKAN=1).'
      : 'Встроенная графика AMD: тяжёлые модели отключены во избежание тормозов, активен быстрый контур CPU + RAM.';
    vendorTipEn = isUsableGpu
      ? 'AMD Radeon GPU: Ollama supports ROCm / Vulkan acceleration (set OLLAMA_VULKAN=1 if needed).'
      : 'Integrated AMD graphics: heavy GPU models disabled to prevent slowdowns; fast CPU + RAM pipeline is active.';
  } else if (gpu?.vendor === 'intel') {
    vendorTipRu = isUsableGpu
      ? 'Видеокарта Intel Arc: для аппаратного ускорения в Ollama рекомендуется режим Vulkan (OLLAMA_VULKAN=1).'
      : 'Интегрированная графика Intel: GPU-модели отключены, чтобы не отнимать системную ОЗУ; активен CPU + RAM.';
    vendorTipEn = isUsableGpu
      ? 'Intel Arc GPU: Vulkan mode (OLLAMA_VULKAN=1) is recommended for hardware acceleration in Ollama.'
      : 'Integrated Intel graphics: GPU models disabled to preserve system RAM; fast CPU + RAM pipeline is active.';
  } else if (gpu?.vendor === 'apple') {
    vendorTipRu = 'Apple Silicon (Metal Unified Memory): общее скоростное поле памяти идеально подходит для локальных моделей Ollama.';
    vendorTipEn = 'Apple Silicon (Metal Unified Memory): shared high-bandwidth memory is ideal for local Ollama models.';
  }

  const subPreset =
    cleanSub === 'ultra'
      ? {
          subscriptionTier: 'ultra',
          strategy: 'auto_balance',
          heavyThreshold: 'M',
          swarmMode: 'auto_xl',
          swarmWorkerTier: 'hydrogen_auto',
          orchestratorSmartSynergy: true,
        }
      : {
          subscriptionTier: 'pro',
          strategy: 'flash_dispatcher',
          heavyThreshold: 'L',
          swarmMode: 'auto_xl',
          swarmWorkerTier: 'hydrogen_auto',
          orchestratorSmartSynergy: true,
        };

  const cpuAutoEnable = !system.isLowPowerCpu;

  const recommendedPatch = {
    ...subPreset,
    ramCacheEnabled: system.totalRamMb >= 6000,
    ramMaxBudgetMb: system.recommendedRamBudgetMb,
    cpuMulticoreEnabled: cpuAutoEnable,
    cpuMaxThreads: system.recommendedCpuThreads,
    gpuEnabled: gpuAutoEnable,
    gpuMaxVramMb: gpuPreset.gpuMaxVramMb,
    gpuChatModel: gpuPreset.gpuChatModel,
    gpuEmbedModel: gpuPreset.gpuEmbedModel,
    gpuEmbedKeepAlive: gpuPreset.gpuEmbedKeepAlive,
    gpuContextTokens: gpuPreset.gpuContextTokens,
    gpuAutoDistillLogs: gpuAutoEnable ? gpuPreset.gpuAutoDistillLogs : false,
    gpuSemanticSearch: gpuAutoEnable ? gpuPreset.gpuSemanticSearch : false,
  };

  const cascadeBundle = buildGpuCascadeBundleForHardware(vramMb, {
    mode: 'cascade',
    selectedCapMb: gpuPreset.gpuMaxVramMb,
    downloadedModels: downloaded,
  });

  const ceilings = computeHardwareCeilings({ system, gpu });

  return {
    tierId,
    tierLabelRu,
    tierLabelEn,
    gpuViable: isUsableGpu,
    gpuAutoEnable,
    vendorTipRu,
    vendorTipEn,
    cascadeBundle,
    ceilings,
    gpuEnabledPreset: {
      gpuEnabled: true,
      ...gpuPreset,
    },
    recommendedPatch,
  };
}

function readCachedGpuFast(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const now = Date.now();
  if (memoryGpuProbeCache.data && now - memoryGpuProbeCache.ts < GPU_PROBE_TTL_MS) {
    return memoryGpuProbeCache.data;
  }
  try {
    const cacheFile = join(pluginRoot, '.cache', 'hardware-profile.json');
    if (existsSync(cacheFile)) {
      const cached = safeReadJsonSync(cacheFile, () => null, { selfHeal: false });
      if (cached?.gpu && cached.scannedAt && now - Date.parse(cached.scannedAt) < PROFILE_CACHE_TTL_MS) {
        return cached.gpu;
      }
    }
  } catch {}
  return probeAnyGpu({ force: false });
}

/**
 * Computes deterministic hardware ceilings for VRAM, In-RAM cache, and CPU pool threads.
 * @param {object} [opts]
 */
export function computeHardwareCeilings({ system = null, gpu = undefined, pluginRoot = DEFAULT_PLUGIN_ROOT } = {}) {
  const sys = system || detectCpuAndRam();
  const gpuInfo = gpu !== undefined ? gpu : readCachedGpuFast(pluginRoot);
  const totalRamMb = Math.max(1024, Number(sys?.totalRamMb) || 8192);
  const logicalCores = Math.max(1, Math.round(Number(sys?.logicalCores) || 4));
  const gpuTotalVramMb = Math.max(0, Number(gpuInfo?.totalMb) || 0);
  const gpuAvailable = Boolean(
    gpuInfo && (gpuInfo.available || gpuInfo.isDiscrete || gpuInfo.vendor === 'apple') && gpuTotalVramMb >= 3500
  );
  return {
    totalRamMb,
    totalRamGb: Math.max(1, Math.round(totalRamMb / 1024)),
    logicalCores,
    gpuAvailable,
    gpuName: String(gpuInfo?.name || ''),
    gpuTotalVramMb,
    maxVramMb: computeMaxVramCapMb(gpuInfo),
    maxRamBudgetMb: computeMaxRamBudgetMb(totalRamMb),
    maxCpuThreads: computeMaxCpuThreads(logicalCores),
    recommendedRamBudgetMb: Number(sys?.recommendedRamBudgetMb) || computeRecommendedRamBudgetMb(totalRamMb),
    recommendedCpuThreads: Number(sys?.recommendedCpuThreads) || computeRecommendedCpuThreads(logicalCores),
  };
}

/**
 * Clamps persisted/incoming hardware limits to physical machine ceilings.
 * @param {object} [settings={}]
 * @param {object|null} [ceilings=null]
 */
export function clampSettingsToHardwareCeilings(settings = {}, ceilings = null) {
  if (!settings || typeof settings !== 'object') return {};
  const c = ceilings || computeHardwareCeilings();
  const next = { ...settings };
  if (next.ramMaxBudgetMb !== undefined) {
    next.ramMaxBudgetMb = clampInt(next.ramMaxBudgetMb, 512, c.maxRamBudgetMb, Math.min(4096, c.maxRamBudgetMb));
  }
  if (next.gpuMaxVramMb !== undefined) {
    next.gpuMaxVramMb = clampInt(next.gpuMaxVramMb, 2048, c.maxVramMb, Math.min(4096, c.maxVramMb));
  }
  if (next.cpuMaxThreads !== undefined) {
    next.cpuMaxThreads = clampInt(next.cpuMaxThreads, 1, c.maxCpuThreads, Math.min(6, c.maxCpuThreads));
  }
  return next;
}

/**
 * Returns true when `dirPath` points to an active Antigravity plugin directory
 * (e.g. `~/.gemini/config/plugins/<name>` or `.agents/plugins/<name>`), so direct
 * `git clone` installations inside `plugins/` still calibrate `mcp_config.json`.
 * @param {string} [dirPath]
 * @returns {boolean}
 */
export function isActivePluginInstallDir(dirPath = '') {
  if (!dirPath || typeof dirPath !== 'string') return false;
  const norm = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return /(?:^|\/)(?:\.gemini\/(?:config|antigravity)\/plugins|\.?agents?\/plugins)\/[^/]+$/i.test(norm);
}

/**
 * Updates --max-old-space-size and GPU eager tool flags in mcp_config.json safely if the file exists.
 * @param {string} [pluginRoot]
 * @param {number} [ramMaxBudgetMb]
 * @param {{ resolveAbsoluteEntry?: boolean, gpuEnabled?: boolean, forceInGitRepo?: boolean }} [options]
 */
export function syncMcpRamBudget(pluginRoot = DEFAULT_PLUGIN_ROOT, ramMaxBudgetMb = 4096, options = {}) {
  const mcpPath = join(pluginRoot, 'mcp_config.json');
  if (!existsSync(mcpPath)) return false;
  const isInstalledDir = isActivePluginInstallDir(pluginRoot);
  const isDevGitRepo = existsSync(join(pluginRoot, '.git')) && !isInstalledDir && !options?.forceInGitRepo;
  if (isDevGitRepo) return true;
  const safeMb = clampInt(ramMaxBudgetMb, 512, 32768, 4096);
  const resolveAbs = Boolean(options?.resolveAbsoluteEntry || isInstalledDir) && !isDevGitRepo;
  const hasGpuFlag = typeof options?.gpuEnabled === 'boolean';
  try {
    const raw = safeReadJsonSync(mcpPath, () => null, { selfHeal: false });
    const serverCfg = raw?.mcpServers?.['ram-memory'];
    const args = serverCfg?.args;
    if (!Array.isArray(args)) return false;
    const absEntry = join(pluginRoot, 'core', 'ram-memory-mcp.mjs');
    const nextArgs = args.map((arg) => {
      if (typeof arg !== 'string') return arg;
      if (arg.startsWith('--max-old-space-size=')) {
        return `--max-old-space-size=${safeMb}`;
      }
      if (resolveAbs && /(?:^|[\\/])ram-memory-mcp\.mjs$/i.test(arg)) {
        return absEntry;
      }
      return arg;
    });
    if (!nextArgs.some((a) => typeof a === 'string' && a.startsWith('--max-old-space-size='))) {
      nextArgs.unshift(`--max-old-space-size=${safeMb}`);
    }
    const argsUnchanged = nextArgs.length === args.length && nextArgs.every((a, i) => a === args[i]);

    let toolsChanged = false;
    if (hasGpuFlag && serverCfg?.tools && typeof serverCfg.tools === 'object') {
      const targetEager = options.gpuEnabled;
      for (const gpuToolName of ['gpu_distill', 'gpu_semantic_search']) {
        const curToolCfg = serverCfg.tools[gpuToolName];
        if (curToolCfg && typeof curToolCfg === 'object') {
          if (curToolCfg.eager !== targetEager) {
            serverCfg.tools[gpuToolName] = { ...curToolCfg, eager: targetEager };
            toolsChanged = true;
          }
        } else {
          serverCfg.tools[gpuToolName] = { eager: targetEager };
          toolsChanged = true;
        }
      }
    }

    if (argsUnchanged && !toolsChanged) {
      return true;
    }
    raw.mcpServers['ram-memory'].args = nextArgs;
    atomicWriteJsonSync(mcpPath, raw, { spaces: 2 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collects full hardware passport with `.cache/hardware-profile.json` caching.
 * @param {object} [opts]
 */
export async function getHardwareProfile(opts = {}) {
  const pluginRoot = opts.pluginRoot || DEFAULT_PLUGIN_ROOT;
  const cacheDir = join(pluginRoot, '.cache');
  const cacheFile = join(cacheDir, 'hardware-profile.json');
  const force = Boolean(opts.force);
  const subscriptionTier = opts.subscriptionTier === 'ultra' ? 'ultra' : 'pro';

  if (!force && existsSync(cacheFile)) {
    const cached = safeReadJsonSync(cacheFile, () => null, { selfHeal: false });
    if (cached && cached.scannedAt && Date.now() - Date.parse(cached.scannedAt) < PROFILE_CACHE_TTL_MS) {
      const recommendation = recommendHardwareSettings({
        system: cached.system,
        gpu: cached.gpu,
        ollama: cached.ollama,
        subscriptionTier,
      });
      return {
        ...cached,
        hardwareCeilings: recommendation.ceilings || computeHardwareCeilings({ system: cached.system, gpu: cached.gpu, pluginRoot }),
        recommendation,
        fromCache: true,
      };
    }
  }

  const system = detectCpuAndRam(opts);
  const gpu = probeAnyGpu({ force, ...opts });
  const ollama = await probeOllamaSummary(opts);
  const recommendation = recommendHardwareSettings({
    system,
    gpu,
    ollama,
    subscriptionTier,
  });

  const payload = {
    scannedAt: new Date().toISOString(),
    system,
    gpu,
    ollama,
    hardwareCeilings: recommendation.ceilings || computeHardwareCeilings({ system, gpu, pluginRoot }),
    recommendation,
    fromCache: false,
  };

  try {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    atomicWriteJsonSync(cacheFile, payload, { spaces: 2 });
  } catch {}

  return payload;
}

/**
 * One-time safe auto-calibration for brand-new installations (`onboardingCompleted === false && !hardwareProfiled`).
 * Never overwrites settings of already-onboarded users.
 * @param {object} [opts]
 */
export async function ensureHardwareCalibratedOnce(opts = {}) {
  const pluginRoot = opts.pluginRoot || DEFAULT_PLUGIN_ROOT;
  const statePath = opts.statePath || join(pluginRoot, 'router-state.json');
  if (!existsSync(statePath)) return { calibrated: false, reason: 'missing_state' };

  const cur = safeReadJsonSync(statePath, () => ({}), { selfHeal: true }) || {};
  if (cur.hardwareProfiled === true) {
    return { calibrated: false, reason: 'already_profiled' };
  }
  if (cur.onboardingCompleted === true) {
    updateJsonAtomicSync(statePath, () => cur, (prev) => ({
      ...prev,
      hardwareProfiled: true,
      subscriptionTier: prev.subscriptionTier === 'ultra' ? 'ultra' : 'pro',
    }));
    return { calibrated: false, reason: 'existing_user_preserved' };
  }

  const profile = await getHardwareProfile({
    ...opts,
    pluginRoot,
    subscriptionTier: cur.subscriptionTier === 'ultra' ? 'ultra' : 'pro',
  });
  const rec = profile.recommendation.recommendedPatch;

  const updated = updateJsonAtomicSync(statePath, () => cur, (prev) => ({
    ...prev,
    ...rec,
    hardwareProfiled: true,
    updatedAt: new Date().toISOString(),
  }));

  syncMcpRamBudget(pluginRoot, updated.ramMaxBudgetMb, {
    resolveAbsoluteEntry: true,
    gpuEnabled: Boolean(updated.gpuEnabled),
  });
  return { calibrated: true, profile, state: updated };
}

/**
 * Builds a structured Russian prompt with the PC Hardware Passport so the user can optimize
 * actual up-to-date models & router-state.json in 1 click via Antigravity chat without touching code.
 * @param {object} profile
 * @param {object} [currentState={}]
 */
export function buildAiHardwareTuningPrompt(profile = {}, currentState = {}, opts = {}) {
  const isEn = normalizeLang(opts?.lang ?? currentState?.uiLanguage, 'ru') === 'en';
  const sys = profile.system || {};
  const gpu = profile.gpu || {};
  const oll = profile.ollama || {};
  const sub = currentState.subscriptionTier === 'ultra'
    ? 'Ultra / Max'
    : (isEn ? 'Pro (preserve quota)' : 'Pro (беречь квоту)');

  const passport = {
    os: `${sys.platform || process.platform} (${sys.arch || process.arch})`,
    subscriptionTier: sub,
    cpu: {
      model: sys.cpuModel || 'Unknown CPU',
      vendor: sys.cpuVendor || 'other',
      logicalThreads: sys.logicalCores || 4,
    },
    ram: {
      totalGb: sys.totalRamGb || Math.round((sys.totalRamMb || 8192) / 1024),
      freeMb: sys.freeRamMb || 0,
      currentRamBudgetMb: currentState.ramMaxBudgetMb || sys.recommendedRamBudgetMb || 4096,
    },
    gpu: {
      name: isEn ? (gpu.nameEn || gpu.name || 'Unknown') : (gpu.name || 'Unknown'),
      vendor: gpu.vendor || 'none',
      isDiscrete: Boolean(gpu.isDiscrete),
      vramMb: gpu.totalMb || 0,
      backendHint: gpu.backendHint || 'cpu',
    },
    ollama: {
      installed: Boolean(oll.installed),
      running: Boolean(oll.running),
      downloadedModels: Array.isArray(oll.downloadedModels) ? oll.downloadedModels.map((m) => `${m.name} (${m.sizeGb}GB)`) : [],
    },
  };

  if (isEn) {
    return [
      'Auto-optimize my The Tunnel (antigravity-model-router) plugin settings for this machine hardware passport:',
      '```json',
      JSON.stringify(passport, null, 2),
      '```',
      'What to do:',
      `1. Evaluate my CPU, RAM capacity, GPU (NVIDIA / AMD / Intel / Apple / integrated), and subscription tier (${sub}).`,
      '2. Check currently available local Ollama models (chat/log distillation + lightweight multilingual embeddings) that strictly fit inside my VRAM limit without RAM swapping or freezes (accounting for CUDA / ROCm / Vulkan / Metal, or disable GPU models if CPU+RAM is optimal).',
      '3. Update ONLY the configuration file `~/.gemini/config/plugins/antigravity-model-router/router-state.json` (and memory limit in `mcp_config.json` if changing `ramMaxBudgetMb`). STRICTLY DO NOT modify plugin source files (`core/*.mjs`, `sidecars/*`) so updates remain clean.',
      '4. Briefly summarize in English which limits were configured and which `ollama pull ...` commands (or env vars like `OLLAMA_VULKAN=1` for AMD/Intel) to run if needed.',
    ].join('\n');
  }

  return [
    'Проведи авто-оптимизацию моих настроек плагина The Tunnel (antigravity-model-router) под характеристики этого компьютера:',
    '```json',
    JSON.stringify(passport, null, 2),
    '```',
    'Что нужно сделать:',
    '1. Оцени мой CPU, объём ОЗУ, видеокарту (NVIDIA / AMD / Intel / Apple / встроенная) и тариф подписки (' + sub + ').',
    '2. Проверь актуальные на сегодня локальные модели Ollama (чат/дистилляция логов + лёгкий мультиязычный эмбеддер), которые гарантированно поместятся в мою видеопамять без свопа и фризов (учитывая специфику CUDA / ROCm / Vulkan / Metal, либо отключи GPU-модели, если выгоднее работать только на CPU+RAM).',
    '3. Обнови ТОЛЬКО конфигурационный файл `~/.gemini/config/plugins/antigravity-model-router/router-state.json` (и лимит памяти в `mcp_config.json`, если меняешь `ramMaxBudgetMb`). СТРОГО НЕ изменяй исходный код плагина (`core/*.mjs`, `sidecars/*`), чтобы не нарушить совместимость обновлений.',
    '4. Кратко напиши на русском, какие лимиты выставлены и какие команды `ollama pull ...` (или переменные вроде `OLLAMA_VULKAN=1` для AMD/Intel) стоит выполнить при желании.',
  ].join('\n');
}

/**
 * Builds a structured Russian prompt with installed Ollama models & GPU limits
 * so the user can review and send it to search for newer/better local models.
 * @param {object} [profile={}]
 * @param {object} [currentState={}]
 * @param {object|null} [gpuSnapshot=null]
 */
function buildOllamaModelPromptContext(profile = {}, currentState = {}, gpuSnapshot = null) {
  const sys = profile.system || {};
  const gpu = gpuSnapshot?.hardware?.available ? gpuSnapshot.hardware : (profile.gpu || {});
  const oll = gpuSnapshot?.ollama || profile.ollama || {};
  const downloadedRaw = Array.isArray(oll.downloadedModels) ? oll.downloadedModels : [];
  const loadedRaw = Array.isArray(oll.loadedModels) ? oll.loadedModels : [];

  const installedModels = downloadedRaw
    .filter((m) => m && m.name)
    .map((m) => (m.sizeGb ? `${m.name} (${m.sizeGb} GB)` : String(m.name)));
  const activeVramModels = loadedRaw
    .filter((m) => m && m.name)
    .map((m) => (m.vramMb ? `${m.name} (${(m.vramMb / 1024).toFixed(1)} GB VRAM)` : String(m.name)));

  const currentChat = String(currentState.gpuChatModel || gpuSnapshot?.config?.gpuChatModel || 'gemma4:12b').trim();
  const currentEmbed = String(currentState.gpuEmbedModel || gpuSnapshot?.config?.gpuEmbedModel || 'qwen3-embedding:0.6b').trim();
  const vramCapMb = Number(currentState.gpuMaxVramMb || gpuSnapshot?.config?.gpuMaxVramMb || 4096);
  const capGb = Math.max(2, Math.round(vramCapMb / 1024));

  const summary = {
    gpu: {
      name: gpu.name || 'Unknown',
      vendor: gpu.vendor || 'none',
      totalVramMb: gpu.totalMb || 0,
      configuredLimitMb: vramCapMb,
      backendHint: gpu.backendHint || 'cpu',
    },
    ramTotalGb: sys.totalRamGb || Math.round((sys.totalRamMb || 8192) / 1024),
    activeRouterModels: {
      gpuChatModel: currentChat,
      gpuEmbedModel: currentEmbed,
      gpuContextTokens: Number(currentState.gpuContextTokens || gpuSnapshot?.config?.gpuContextTokens || 4096),
    },
    installedOllamaModels: installedModels,
    loadedInVramNow: activeVramModels,
  };

  return { summary, installedModels, currentChat, currentEmbed, vramCapMb, capGb };
}

export function buildAiModelSearchPrompt(profile = {}, currentState = {}, gpuSnapshot = null, opts = {}) {
  const isEn = normalizeLang(opts?.lang ?? currentState?.uiLanguage, 'ru') === 'en';
  const { summary, installedModels, currentChat, currentEmbed, capGb } = buildOllamaModelPromptContext(
    profile,
    currentState,
    gpuSnapshot
  );

  if (isEn) {
    const installedText = installedModels.length > 0 ? installedModels.join(', ') : 'none installed / Ollama sleeping';
    return [
      'Find up-to-date local Ollama models for my hardware and check whether my current pair should be upgraded:',
      '```json',
      JSON.stringify(summary, null, 2),
      '```',
      'What to do:',
      `1. Account for currently installed models (${installedText}) and active router pair: chat/distillation — \`${currentChat}\`, embedder — \`${currentEmbed}\` within a \`${capGb} GB\` VRAM limit.`,
      '2. Search Ollama library / web for newer or higher-quality alternatives for both roles: a fast log/code distillation model (`gpuChatModel`) + a compact multilingual embedder (`gpuEmbedModel`) that strictly fit my VRAM limit without RAM swapping.',
      '3. Briefly compare top candidates against my current models (code quality, EN/multilingual quality, speed, VRAM footprint) and provide ready `ollama pull ...` commands.',
      '4. After my confirmation (or if requested right away), pull the selected models and update only `~/.gemini/config/plugins/antigravity-model-router/router-state.json` (`gpuChatModel` / `gpuEmbedModel`) without modifying plugin source code.',
    ].join('\n');
  }

  return [
    'Найди актуальные на сегодня локальные модели Ollama для моего ПК и проверь, стоит ли обновить текущие:',
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    'Что нужно сделать:',
    `1. Учти установленные сейчас модели (${installedModels.length > 0 ? installedModels.join(', ') : 'список пуст / Ollama спит'}) и выбранную пару в роутере: чат/сжатие — \`${currentChat}\`, эмбеддер — \`${currentEmbed}\` при лимите \`${capGb} ГБ\` VRAM.`,
    '2. Поищи в сети / библиотеке Ollama более свежие или более качественные аналоги для двух ролей: быстрая модель для дистилляции логов и кода (`gpuChatModel`) + компактный мультиязычный эмбеддер (`gpuEmbedModel`), которые гарантированно влезут в мой лимит VRAM без выгрузки в ОЗУ.',
    '3. Кратко сравни кандидатов с моими текущими моделями (качество RU/EN и кода, скорость, объём VRAM) и дай готовые команды `ollama pull ...` для установки.',
    '4. После моего подтверждения (или если я попрошу сразу) скачай выбранные модели и обнови только `~/.gemini/config/plugins/antigravity-model-router/router-state.json` (`gpuChatModel` / `gpuEmbedModel`), не изменяя исходный код плагина.',
  ].join('\n');
}

export function buildVramFitModelPrompt(profile = {}, currentState = {}, gpuSnapshot = null, opts = {}) {
  const isEn = normalizeLang(opts?.lang ?? currentState?.uiLanguage, 'ru') === 'en';
  const { summary, installedModels, currentChat, currentEmbed, vramCapMb, capGb } = buildOllamaModelPromptContext(
    profile,
    currentState,
    gpuSnapshot
  );
  const vramFit = gpuSnapshot?.vramFit || null;
  const recommendedPull =
    vramFit?.recommendedPullModel || (vramCapMb < 11264 ? 'qwen3:4b' : 'gemma4:12b');
  const installedListText = installedModels.length > 0
    ? installedModels.join(', ')
    : (isEn ? 'none installed / Ollama sleeping' : 'список пуст / Ollama спит');

  if (isEn) {
    return [
      `I capped VRAM to **${capGb} GB (${vramCapMb} MB)**, and none of the installed Ollama models (${installedListText}) fit as a log/code distillation chat model alongside \`${currentEmbed}\` (current \`${currentChat}\` is blocked).`,
      '```json',
      JSON.stringify(summary, null, 2),
      '```',
      'What to do:',
      `1. Recommend 2–3 compact Ollama models for \`gpuChatModel\` (distilling logs, stacktraces, and code) that fit strictly inside **${capGb} GB VRAM** together with \`${currentEmbed}\` without swapping to system RAM (consider \`${recommendedPull}\` and modern equivalents of similar footprint).`,
      '2. List each candidate’s exact VRAM footprint and ready `ollama pull ...` commands.',
      '3. After my confirmation (or immediately if I ask), pull the chosen model with `ollama pull` and update `gpuChatModel` in `~/.gemini/config/plugins/antigravity-model-router/router-state.json` without editing plugin source code.',
    ].join('\n');
  }

  return [
    `Я ограничил лимит видеопамяти до **${capGb} ГБ (${vramCapMb} МБ)**, но среди установленных моделей Ollama (${installedListText}) нет чат-модели для сжатия логов и кода, которая помещается в этот лимит вместе с эмбеддером \`${currentEmbed}\` (текущая \`${currentChat}\` заблокирована).`,
    '```json',
    JSON.stringify(summary, null, 2),
    '```',
    'Что нужно сделать:',
    `1. Подбери 2–3 лучшие компактные модели Ollama для роли \`gpuChatModel\` (сжатие логов, стектрейсов и кода), которые гарантированно поместятся в **${capGb} ГБ VRAM** вместе с \`${currentEmbed}\` без свопа в системную ОЗУ (рассмотри \`${recommendedPull}\` и актуальные аналоги такого же объёма).`,
    '2. Укажи точный размер в VRAM каждой модели и готовые команды `ollama pull ...` для скачивания.',
    '3. После моего подтверждения (или сразу, если я скажу) скачай выбранную модель через `ollama pull` и обнови `gpuChatModel` в `~/.gemini/config/plugins/antigravity-model-router/router-state.json`, не изменяя исходный код плагина.',
  ].join('\n');
}
