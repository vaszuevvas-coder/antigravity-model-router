#!/usr/bin/env node
/**
 * Сборщик релиза The Tunnel (antigravity-model-router):
 *  - очищает дистрибутив от кэшей, тестов и персональных путей;
 *  - формирует кроссплатформенный ZIP-архив с поддержкой UTF-8 имён;
 *  - генерирует фирменную иконку .ico и компилирует автономный Setup.exe для Windows (GUI + /S);
 *  - записывает SHA256SUMS.txt и release-manifest.json.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { buildPanelUi } from '../core/panel-ui-builder.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

const MANAGED_DIRS = ['agents', 'assets', 'core', 'rules', 'sidecars', 'skills'];
const ROOT_FILES = [
  'plugin.json',
  'package.json',
  'hooks.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'install.js',
  'install.bat',
  'install.sh',
  'Установить плагин.bat',
];
const SKIP_DIR_NAMES = new Set([
  '.cache',
  '.git',
  '.agents',
  'tests',
  'scratch',
  'dist',
  'build',
  'releases',
  'node_modules',
  'checkpoints',
  'backups',
  '.shadow',
  'ui-src',
  '--ws',
]);
const SKIP_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

const UNINSTALL_BAT_CONTENT = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal EnableExtensions EnableDelayedExpansion',
  'title Удаление The Tunnel',
  'cd /d "%~dp0"',
  '',
  'set "SILENT_MODE=0"',
  'for %%A in (%*) do (',
  '  if /I "%%~A"=="--silent" set "SILENT_MODE=1"',
  '  if /I "%%~A"=="/S" set "SILENT_MODE=1"',
  ')',
  '',
  'set "NODE_EXE="',
  'for /f "delims=" %%P in (\'where node.exe 2^>nul\') do (',
  '  if not defined NODE_EXE if exist "%%~P" set "NODE_EXE=%%~P"',
  ')',
  'if not defined NODE_EXE (',
  '  for %%D in (',
  '    "%ProgramFiles%\\nodejs"',
  '    "%ProgramFiles(x86)%\\nodejs"',
  '    "%LOCALAPPDATA%\\Programs\\nodejs"',
  '    "%NVM_SYMLINK%"',
  '    "%VOLTA_HOME%\\bin"',
  '    "%USERPROFILE%\\scoop\\apps\\nodejs\\current"',
  '  ) do (',
  '    if not defined NODE_EXE if not "%%~D"=="" if exist "%%~D\\node.exe" set "NODE_EXE=%%~D\\node.exe"',
  '  )',
  ')',
  '',
  'if not defined NODE_EXE (',
  '  echo [ОШИБКА] Node.js не найден. Запустите Setup.exe с параметром --uninstall или удалите папку плагина вручную.',
  '  if "!SILENT_MODE!"=="0" pause',
  '  exit /b 1',
  ')',
  '',
  '"%NODE_EXE%" "%~dp0install.js" --uninstall %*',
  'set "EXIT_CODE=!ERRORLEVEL!"',
  'if "!SILENT_MODE!"=="0" pause',
  'exit /b !EXIT_CODE!',
  '',
].join('\r\n');

/**
 * Приводит router-state.json к чистому состоянию по умолчанию перед упаковкой релиза.
 * @param {object} [rawState]
 * @returns {object}
 */
export function createSanitizedDefaultState(rawState = {}) {
  const base = rawState && typeof rawState === 'object' && !Array.isArray(rawState) ? { ...rawState } : {};
  for (const deprecated of ['recommendTeamwork', 'recommendSkills', 'activeSkillProfiles', 'splitExecution', 'chainOfDraft', 'workerModel']) {
    delete base[deprecated];
  }
  return {
    ...base,
    uiLanguage: 'en',
    hardwareProfiled: false,
    onboardingCompleted: false,
    gpuEnabled: false,
    gpuModelsDir: '',
    ramMaxBudgetMb: 4096,
    gpuMaxVramMb: 4096,
    gpuContextTokens: 4096,
    gpuPostEditCritic: true,
    cpuMaxThreads: 6,
    lspBridgeEnabled: true,
    sqliteKnowledgeEnabled: true,
    shadowWorktreeEnabled: true,
    runtimeWiretapEnabled: true,
    quotaPacerEnabled: true,
    composerVoiceEnabled: false,
    mutationGuardEnabled: false,
    federatedWorkspaces: [],
    floatingHudEnabled: false,
    skillModes: {},
    panelCollapsedCards: {
      swarmTelemetryCard: true,
      gpuRamCard: true,
      sentinelSectionCard: true,
    },
    panelOpenSpoilers: {},
    panelBlockOrder: [
      'smartProjectBanner',
      'agLiveProgressWrap',
      'smartComposerCard',
      'skillsSectionCard',
      'agentModeCard',
      'skillProfilesFieldset',
      'swarmTelemetryCard',
      'gpuRamCard',
      'sentinelSectionCard',
      'snapshotsBayesianSpoiler',
      'expertDetailsBox',
      'checkpointsCard',
      'intelligenceBayesianCard',
      'expertCircuitBox',
      'expertPitfallsBox',
      'expertKnowledgeBox',
      'expertGuardrailsCard',
      'expertProfileCard',
      'expertRamGpuFieldset',
    ],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Приводит mcp_config.json к портативному виду без локальных путей сборки.
 * @param {object} [rawMcp]
 * @returns {object}
 */
export function createSanitizedMcpConfig(rawMcp = {}) {
  const base = rawMcp && typeof rawMcp === 'object' && !Array.isArray(rawMcp)
    ? JSON.parse(JSON.stringify(rawMcp))
    : { mcpServers: {} };
  if (base?.mcpServers?.['ram-memory']) {
    base.mcpServers['ram-memory'].command = 'node';
    base.mcpServers['ram-memory'].args = [
      '--max-old-space-size=4096',
      './core/ram-memory-mcp.mjs',
    ];
  }
  return base;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const dosTime =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((d.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((Math.max(1980, d.getFullYear()) - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Собирает стандартный ZIP-буфер на чистом Node.js с UTF-8 флагом имён (0x0800).
 * @param {Array<{ name: string, data: Buffer, mode?: number, mtime?: Date }>} entries
 * @returns {Buffer}
 */
export function buildZipBuffer(entries = []) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanName) continue;
    const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data || '');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const crc = crc32(rawData);
    const deflated = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : rawData;
    const { dosTime, dosDate } = toDosDateTime(entry.mtime);
    const flags = 0x0800; // UTF-8 filename flag

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const unixMode = entry.mode || (cleanName.endsWith('.sh') ? 0o100755 : 0o100644);
    const externalAttrs = (((unixMode & 0xffff) << 16) | 0x20) >>> 0;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttrs, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralParts.length / 2, 8);
  eocd.writeUInt16LE(centralParts.length / 2, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function renderIconDib(size) {
  const rgba = new Uint8Array(size * size * 4);
  const scale = size / 128;

  const evalSample = (sx, sy) => {
    const u = sx / scale;
    const v = sy / scale;

    // Скруглённый квадрат (14..114, r=22) в стиле assets/logo.svg
    const rx = Math.max(Math.abs(u - 64) - 28, 0);
    const ry = Math.max(Math.abs(v - 64) - 28, 0);
    const sdfBox = Math.hypot(rx, ry) - 22;
    if (sdfBox > 1.2) return [0, 0, 0, 0];

    const tGrad = Math.max(0, Math.min(1, ((u - 14) + (v - 14)) / 200));
    let r = 40 + (30 - 40) * tGrad;
    let g = 42 + (31 - 42) * tGrad;
    let b = 54 + (41 - 54) * tGrad;
    const boxAlpha = Math.max(0, Math.min(1, 0.8 - sdfBox / 1.5)) * 255;

    // Фиолетовая обводка
    if (sdfBox > -3.4 && sdfBox < 0.8) {
      const borderA = Math.max(0, Math.min(1, 1 - Math.abs(sdfBox + 1.3) / 2.2));
      r = r * (1 - borderA) + 189 * borderA;
      g = g * (1 - borderA) + 147 * borderA;
      b = b * (1 - borderA) + 249 * borderA;
    }

    // Линии маршрутизации к Pro (верх) и Flash (низ)
    const dTop = Math.min(
      distToSegment(u, v, 42, 60, 64, 52),
      distToSegment(u, v, 64, 52, 88, 42)
    );
    if (dTop < 3.6) {
      const la = Math.max(0, Math.min(1, (3.6 - dTop) / 1.6));
      r = r * (1 - la) + 199 * la;
      g = g * (1 - la) + 135 * la;
      b = b * (1 - la) + 225 * la;
    }
    const dBot = Math.min(
      distToSegment(u, v, 42, 68, 64, 76),
      distToSegment(u, v, 64, 76, 88, 86)
    );
    if (dBot < 3.6) {
      const la = Math.max(0, Math.min(1, (3.6 - dBot) / 1.6));
      r = r * (1 - la) + 109 * la;
      g = g * (1 - la) + 242 * la;
      b = b * (1 - la) + 190 * la;
    }

    // Левый белый узел диспетчера
    const dHub = Math.hypot(u - 38, v - 64);
    if (dHub < 12) {
      const ca = Math.max(0, Math.min(1, (12 - dHub) / 1.8));
      r = r * (1 - ca) + 248 * ca;
      g = g * (1 - ca) + 248 * ca;
      b = b * (1 - ca) + 242 * ca;
    }

    // Верхний правый узел (Pro / Carbon)
    const dPro = Math.hypot(u - 90, v - 42);
    if (dPro < 14) {
      const ca = Math.max(0, Math.min(1, (14 - dPro) / 1.8));
      r = r * (1 - ca) + 226 * ca;
      g = g * (1 - ca) + 133 * ca;
      b = b * (1 - ca) + 220 * ca;
    }

    // Нижний правый узел (Flash / Hydrogen)
    const dFlash = Math.hypot(u - 90, v - 86);
    if (dFlash < 14) {
      const ca = Math.max(0, Math.min(1, (14 - dFlash) / 1.8));
      r = r * (1 - ca) + 108 * ca;
      g = g * (1 - ca) + 241 * ca;
      b = b * (1 - ca) + 188 * ca;
    }

    return [r, g, b, boxAlpha];
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (const oy of [0.25, 0.75]) {
        for (const ox of [0.25, 0.75]) {
          const [r, g, b, a] = evalSample(x + ox, y + oy);
          sr += r;
          sg += g;
          sb += b;
          sa += a;
        }
      }
      const idx = (y * size + x) * 4;
      rgba[idx] = Math.round(sb / 4);
      rgba[idx + 1] = Math.round(sg / 4);
      rgba[idx + 2] = Math.round(sr / 4);
      rgba[idx + 3] = Math.round(sa / 4);
    }
  }

  const andStride = Math.ceil(size / 32) * 4;
  const xorBytes = size * size * 4;
  const andBytes = andStride * size;
  const dib = Buffer.alloc(40 + xorBytes + andBytes);

  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(xorBytes + andBytes, 20);

  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const sIdx = (srcRow * size + x) * 4;
      const dIdx = 40 + (y * size + x) * 4;
      dib[dIdx] = rgba[sIdx];
      dib[dIdx + 1] = rgba[sIdx + 1];
      dib[dIdx + 2] = rgba[sIdx + 2];
      dib[dIdx + 3] = rgba[sIdx + 3];
      if (rgba[sIdx + 3] < 128) {
        const maskOffset = 40 + xorBytes + y * andStride + (x >> 3);
        dib[maskOffset] |= 0x80 >> (x & 7);
      }
    }
  }
  return dib;
}

/**
 * Генерирует многоразмерный Windows .ico (64x64 и 32x32, совместимый с csc.exe и Explorer).
 * @returns {Buffer}
 */
export function buildIconBuffer() {
  const sizes = [64, 32];
  const dibs = sizes.map((sz) => renderIconDib(sz));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);

  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const sz = sizes[i];
    const dib = dibs[i];
    const pos = 6 + i * 16;
    header[pos] = sz >= 256 ? 0 : sz;
    header[pos + 1] = sz >= 256 ? 0 : sz;
    header[pos + 2] = 0;
    header[pos + 3] = 0;
    header.writeUInt16LE(1, pos + 4);
    header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(dib.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += dib.length;
  }

  return Buffer.concat([header, ...dibs]);
}

function copyFilteredDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (SKIP_DIR_NAMES.has(entry.name) || SKIP_FILE_NAMES.has(entry.name)) continue;
    if (entry.name.endsWith('.log')) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyFilteredDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function collectFilesForZip(dir, relPrefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFilesForZip(full, rel));
    } else {
      let data = fs.readFileSync(full);
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.bat')) {
        const text = data.toString('utf8').replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
        data = Buffer.from(text, 'utf8');
      } else if (lower.endsWith('.sh')) {
        const text = data.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        data = Buffer.from(text, 'utf8');
      }
      const st = fs.statSync(full);
      out.push({
        rel,
        data,
        mtime: st.mtime,
        mode: lower.endsWith('.sh') ? 0o100755 : 0o100644,
      });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

function findCscCompiler() {
  if (process.platform !== 'win32') return '';
  const winDir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

function buildInstallerCSharpSource(version) {
  const safeVersion = String(version || '3.31.0').replace(/[^0-9A-Za-z._-]/g, '');
  // Строго C# 5.0 (без $"" интерполяции, ?., ??=, nameof, auto-property initializers)
  return `using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AntigravityModelRouterSetup
{
    internal sealed class SetupOptions
    {
        public bool Silent;
        public bool Uninstall;
        public string TargetDir;
    }

    internal static class Program
    {
        private const string PluginName = "antigravity-model-router";
        private const string PluginVersion = "${safeVersion}";
        private const string ResourceName = "Antigravity.Payload.zip";

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            SetupOptions opts = ParseArgs(args);
            if (opts.Silent)
            {
                return RunSilent(opts);
            }

            try
            {
                SetProcessDPIAware();
            }
            catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (SetupForm form = new SetupForm(opts))
            {
                Application.Run(form);
                return form.ExitCode;
            }
        }

        internal static SetupOptions ParseArgs(string[] args)
        {
            SetupOptions opts = new SetupOptions();
            opts.Silent = false;
            opts.Uninstall = false;
            opts.TargetDir = "";
            if (args == null) return opts;

            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i] != null ? args[i].Trim() : "";
                if (a.Length == 0) continue;
                string lower = a.ToLowerInvariant();
                if (lower == "--silent" || lower == "/s")
                {
                    opts.Silent = true;
                }
                else if (lower == "--uninstall" || lower == "uninstall" || lower == "/u")
                {
                    opts.Uninstall = true;
                }
                else if (lower == "--target" && i + 1 < args.Length)
                {
                    opts.TargetDir = args[++i].Trim();
                }
                else if (lower.StartsWith("--target="))
                {
                    opts.TargetDir = a.Substring("--target=".Length).Trim();
                }
            }
            return opts;
        }

        internal static string ResolveTargetDir(string customTarget)
        {
            if (!string.IsNullOrWhiteSpace(customTarget))
            {
                return Path.GetFullPath(customTarget);
            }
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".gemini", "config", "plugins", PluginName);
        }

        internal static string FindNodeExecutable()
        {
            List<string> candidates = new List<string>();
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] pathDirs = pathEnv.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string dir in pathDirs)
            {
                candidates.Add(Path.Combine(dir.Trim(), "node.exe"));
            }
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"));
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"));
            string nvmSymlink = Environment.GetEnvironmentVariable("NVM_SYMLINK");
            if (!string.IsNullOrEmpty(nvmSymlink))
            {
                candidates.Add(Path.Combine(nvmSymlink, "node.exe"));
            }
            string voltaHome = Environment.GetEnvironmentVariable("VOLTA_HOME");
            if (!string.IsNullOrEmpty(voltaHome))
            {
                candidates.Add(Path.Combine(voltaHome, "bin", "node.exe"));
            }
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            candidates.Add(Path.Combine(userProfile, "scoop", "apps", "nodejs", "current", "node.exe"));
            candidates.Add(Path.Combine(userProfile, "scoop", "apps", "nodejs-lts", "current", "node.exe"));

            foreach (string c in candidates)
            {
                try
                {
                    if (!string.IsNullOrEmpty(c) && File.Exists(c))
                    {
                        return c;
                    }
                }
                catch { }
            }
            return "";
        }

        internal static string GetNodeVersion(string nodeExe)
        {
            if (string.IsNullOrEmpty(nodeExe) || !File.Exists(nodeExe)) return "";
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = "-v";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                using (Process proc = Process.Start(psi))
                {
                    string ver = proc.StandardOutput.ReadToEnd().Trim();
                    proc.WaitForExit(3000);
                    return ver;
                }
            }
            catch
            {
                return "";
            }
        }

        internal static bool HasWinget()
        {
            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string wingetApp = Path.Combine(localApp, "Microsoft", "WindowsApps", "winget.exe");
            if (File.Exists(wingetApp)) return true;
            string pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] dirs = pathEnv.Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string d in dirs)
            {
                if (File.Exists(Path.Combine(d.Trim(), "winget.exe"))) return true;
            }
            return false;
        }

        internal static string ExtractPayloadToTemp(Action<string> log)
        {
            string tempDir = Path.Combine(Path.GetTempPath(), "ag-router-setup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream stream = asm.GetManifestResourceStream(ResourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("Встроенный архив плагина не найден в ресурсах.");
                }
                using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read, false, Encoding.UTF8))
                {
                    string tempDirFull = Path.GetFullPath(tempDir);
                    if (!tempDirFull.EndsWith(Path.DirectorySeparatorChar.ToString()))
                    {
                        tempDirFull += Path.DirectorySeparatorChar;
                    }
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        if (string.IsNullOrEmpty(rel) || rel.EndsWith(Path.DirectorySeparatorChar.ToString()))
                        {
                            continue;
                        }
                        string destPath = Path.GetFullPath(Path.Combine(tempDir, rel));
                        if (!destPath.StartsWith(tempDirFull, StringComparison.OrdinalIgnoreCase))
                        {
                            throw new InvalidOperationException("Обнаружен небезопасный путь в архиве: " + entry.FullName);
                        }
                        string parent = Path.GetDirectoryName(destPath);
                        if (!string.IsNullOrEmpty(parent))
                        {
                            Directory.CreateDirectory(parent);
                        }
                        entry.ExtractToFile(destPath, true);
                    }
                }
            }
            if (log != null)
            {
                log("[✓] Файлы плагина v" + PluginVersion + " распакованы во временную папку.");
            }
            return tempDir;
        }

        internal static int RunExternalProcess(string fileName, string arguments, string workingDir, Action<string> log)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = fileName;
            psi.Arguments = arguments;
            if (!string.IsNullOrEmpty(workingDir))
            {
                psi.WorkingDirectory = workingDir;
            }
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            using (Process proc = new Process())
            {
                proc.StartInfo = psi;
                proc.OutputDataReceived += (s, e) =>
                {
                    if (e.Data != null && log != null) log(e.Data);
                };
                proc.ErrorDataReceived += (s, e) =>
                {
                    if (e.Data != null && log != null) log("[ERR] " + e.Data);
                };
                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();
                proc.WaitForExit();
                return proc.ExitCode;
            }
        }

        internal static string QuoteArg(string val)
        {
            if (string.IsNullOrEmpty(val)) return "\\"\\"";
            return "\\"" + val.Replace("\\"", "\\\\\\"") + "\\"";
        }

        internal static int ExecuteInstallOrUninstall(SetupOptions opts, Action<string> log)
        {
            string targetDir = ResolveTargetDir(opts.TargetDir);
            string nodeExe = FindNodeExecutable();

            if (opts.Uninstall)
            {
                if (!string.IsNullOrEmpty(nodeExe))
                {
                    string tempDir = "";
                    try
                    {
                        tempDir = ExtractPayloadToTemp(null);
                        string installJs = Path.Combine(tempDir, "install.js");
                        string args = QuoteArg(installJs) + " --uninstall --target " + QuoteArg(targetDir);
                        if (opts.Silent) args += " --silent";
                        return RunExternalProcess(nodeExe, args, tempDir, log);
                    }
                    finally
                    {
                        TryDeleteDirectory(tempDir);
                    }
                }
                return UninstallFallbackWithoutNode(targetDir, log);
            }

            if (string.IsNullOrEmpty(nodeExe))
            {
                if (opts.Silent && HasWinget())
                {
                    if (log != null) log("[i] Node.js не найден. Установка OpenJS.NodeJS.LTS через winget...");
                    RunExternalProcess("winget", "install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements", "", log);
                    nodeExe = FindNodeExecutable();
                }
                if (string.IsNullOrEmpty(nodeExe))
                {
                    if (log != null) log("[ОШИБКА] Node.js v22+ не найден. Установите Node.js LTS с https://nodejs.org/");
                    return 2;
                }
            }

            string extractDir = "";
            try
            {
                extractDir = ExtractPayloadToTemp(log);
                string installJsPath = Path.Combine(extractDir, "install.js");
                string nodeArgs = QuoteArg(installJsPath) + " --target " + QuoteArg(targetDir);
                if (opts.Silent) nodeArgs += " --silent";
                return RunExternalProcess(nodeExe, nodeArgs, extractDir, log);
            }
            finally
            {
                TryDeleteDirectory(extractDir);
            }
        }

        internal static int UninstallFallbackWithoutNode(string targetDir, Action<string> log)
        {
            if (!Directory.Exists(targetDir))
            {
                if (log != null) log("[i] Плагин не найден в: " + targetDir);
                return 0;
            }
            string statePath = Path.Combine(targetDir, "router-state.json");
            if (File.Exists(statePath))
            {
                string parentDir = Path.GetDirectoryName(targetDir);
                if (!string.IsNullOrEmpty(parentDir))
                {
                    string backupPath = Path.Combine(parentDir, PluginName + "-state.backup.json");
                    File.Copy(statePath, backupPath, true);
                    if (log != null) log("[✓] Резервная копия настроек сохранена: " + backupPath);
                }
            }
            Directory.Delete(targetDir, true);
            if (log != null) log("[✓] Плагин удалён из: " + targetDir);
            return 0;
        }

        internal static void TryDeleteDirectory(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return;
            try
            {
                if (Directory.Exists(dir))
                {
                    Directory.Delete(dir, true);
                }
            }
            catch { }
        }

        private static int RunSilent(SetupOptions opts)
        {
            return ExecuteInstallOrUninstall(opts, (line) =>
            {
                try { Console.WriteLine(line); } catch { }
            });
        }
    }

    internal sealed class SetupForm : Form
    {
        private readonly SetupOptions _opts;
        private readonly string _targetDir;
        private Label _lblPluginStatus;
        private Label _lblNodeStatus;
        private Label _lblAntigravityStatus;
        private Label _lblTargetPath;
        private TextBox _txtLog;
        private Button _btnInstall;
        private Button _btnUninstall;
        private Button _btnOpenDir;
        private Button _btnClose;
        private bool _busy;

        public int ExitCode;

        public SetupForm(SetupOptions opts)
        {
            _opts = opts != null ? opts : new SetupOptions();
            _targetDir = Program.ResolveTargetDir(_opts.TargetDir);
            ExitCode = 0;
            InitializeUi();
            RefreshDiagnostics();
        }

        private void InitializeUi()
        {
            Color bgCanvas = Color.FromArgb(247, 246, 242);
            Color bgCard = Color.White;
            Color borderSubtle = Color.FromArgb(228, 226, 218);
            Color textPrimary = Color.FromArgb(24, 24, 27);
            Color textMuted = Color.FromArgb(82, 82, 91);
            Color accentTeal = Color.FromArgb(15, 118, 110);

            Text = "Установка The Tunnel v${safeVersion}";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = true;
            ClientSize = new Size(640, 480);
            BackColor = bgCanvas;
            Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);

            try
            {
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) this.Icon = exeIcon;
            }
            catch { }

            Label lblTitle = new Label();
            lblTitle.Text = "The Tunnel · Диспетчер моделей ИИ";
            lblTitle.Font = new Font("Segoe UI", 14f, FontStyle.Bold);
            lblTitle.ForeColor = textPrimary;
            lblTitle.AutoSize = true;
            lblTitle.Location = new Point(24, 18);
            Controls.Add(lblTitle);

            Label lblSubtitle = new Label();
            lblSubtitle.Text = "Автоматическая установка и обновление плагина v${safeVersion} (3D-автопилот, RAM-кэш, Ollama GPU)";
            lblSubtitle.ForeColor = textMuted;
            lblSubtitle.AutoSize = true;
            lblSubtitle.Location = new Point(26, 48);
            Controls.Add(lblSubtitle);

            Panel card = new Panel();
            card.BackColor = bgCard;
            card.Location = new Point(24, 80);
            card.Size = new Size(592, 136);
            card.Paint += (s, e) =>
            {
                using (Pen pen = new Pen(borderSubtle, 1f))
                {
                    e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
                }
            };
            Controls.Add(card);

            _lblPluginStatus = AddInfoRow(card, "Статус плагина:", "...", 16);
            _lblNodeStatus = AddInfoRow(card, "Среда Node.js:", "...", 44);
            _lblAntigravityStatus = AddInfoRow(card, "Google Antigravity:", "...", 72);
            _lblTargetPath = AddInfoRow(card, "Папка установки:", _targetDir, 100);

            _txtLog = new TextBox();
            _txtLog.Multiline = true;
            _txtLog.ReadOnly = true;
            _txtLog.ScrollBars = ScrollBars.Vertical;
            _txtLog.BackColor = Color.FromArgb(250, 250, 248);
            _txtLog.ForeColor = textPrimary;
            _txtLog.Font = new Font("Consolas", 9f, FontStyle.Regular);
            _txtLog.BorderStyle = BorderStyle.FixedSingle;
            _txtLog.Location = new Point(24, 228);
            _txtLog.Size = new Size(592, 182);
            _txtLog.Text = "Готово к установке. Нажмите кнопку ниже, чтобы начать.";
            Controls.Add(_txtLog);

            _btnInstall = new Button();
            _btnInstall.Text = "Установить плагин";
            _btnInstall.BackColor = accentTeal;
            _btnInstall.ForeColor = Color.White;
            _btnInstall.FlatStyle = FlatStyle.Flat;
            _btnInstall.FlatAppearance.BorderSize = 0;
            _btnInstall.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            _btnInstall.Location = new Point(24, 424);
            _btnInstall.Size = new Size(190, 36);
            _btnInstall.Cursor = Cursors.Hand;
            _btnInstall.Click += (s, e) => StartInstallFlow();
            Controls.Add(_btnInstall);

            _btnUninstall = CreateSecondaryButton("Удалить", new Point(226, 424), new Size(110, 36), bgCard, borderSubtle, textPrimary);
            _btnUninstall.Click += (s, e) => StartUninstallFlow();
            Controls.Add(_btnUninstall);

            _btnOpenDir = CreateSecondaryButton("Открыть папку", new Point(348, 424), new Size(138, 36), bgCard, borderSubtle, textPrimary);
            _btnOpenDir.Click += (s, e) => OpenTargetFolder();
            Controls.Add(_btnOpenDir);

            _btnClose = CreateSecondaryButton("Закрыть", new Point(498, 424), new Size(118, 36), bgCard, borderSubtle, textPrimary);
            _btnClose.Click += (s, e) => Close();
            Controls.Add(_btnClose);
        }

        private Label AddInfoRow(Panel parent, string caption, string initialValue, int y)
        {
            Label lblCap = new Label();
            lblCap.Text = caption;
            lblCap.ForeColor = Color.FromArgb(82, 82, 91);
            lblCap.Font = new Font("Segoe UI", 9f, FontStyle.Bold);
            lblCap.Location = new Point(16, y);
            lblCap.Size = new Size(134, 22);
            parent.Controls.Add(lblCap);

            Label lblVal = new Label();
            lblVal.Text = initialValue;
            lblVal.ForeColor = Color.FromArgb(24, 24, 27);
            lblVal.Font = new Font("Segoe UI", 9f, FontStyle.Regular);
            lblVal.Location = new Point(154, y);
            lblVal.Size = new Size(424, 22);
            lblVal.AutoEllipsis = true;
            parent.Controls.Add(lblVal);
            return lblVal;
        }

        private Button CreateSecondaryButton(string text, Point loc, Size size, Color back, Color border, Color fore)
        {
            Button btn = new Button();
            btn.Text = text;
            btn.BackColor = back;
            btn.ForeColor = fore;
            btn.FlatStyle = FlatStyle.Flat;
            btn.FlatAppearance.BorderColor = border;
            btn.FlatAppearance.BorderSize = 1;
            btn.Location = loc;
            btn.Size = size;
            btn.Cursor = Cursors.Hand;
            return btn;
        }

        private void RefreshDiagnostics()
        {
            bool installed = File.Exists(Path.Combine(_targetDir, "plugin.json"));
            _lblPluginStatus.Text = installed ? "Установлен (можно обновить с сохранением настроек)" : "Не установлен";
            _btnInstall.Text = installed ? "Обновить плагин" : "Установить плагин";
            _btnUninstall.Enabled = !_busy && Directory.Exists(_targetDir);

            string nodeExe = Program.FindNodeExecutable();
            if (!string.IsNullOrEmpty(nodeExe))
            {
                string ver = Program.GetNodeVersion(nodeExe);
                _lblNodeStatus.Text = "Найден (" + (ver.Length > 0 ? ver : nodeExe) + ")";
            }
            else
            {
                _lblNodeStatus.Text = Program.HasWinget()
                    ? "Не найден (доступна автоустановка через winget)"
                    : "Не найден (требуется Node.js LTS)";
            }

            string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string agExe = Path.Combine(localApp, "Programs", "antigravity", "Antigravity.exe");
            string geminiDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".gemini");
            if (File.Exists(agExe))
            {
                _lblAntigravityStatus.Text = "Найден (Antigravity.exe)";
            }
            else if (Directory.Exists(geminiDir))
            {
                _lblAntigravityStatus.Text = "Профиль ~/.gemini обнаружен";
            }
            else
            {
                _lblAntigravityStatus.Text = "Профиль ~/.gemini будет создан автоматически";
            }
            _lblTargetPath.Text = _targetDir;
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _btnInstall.Enabled = !busy;
            _btnOpenDir.Enabled = !busy;
            _btnClose.Enabled = !busy;
            _btnUninstall.Enabled = !busy && Directory.Exists(_targetDir);
        }

        private void AppendLog(string line)
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                BeginInvoke((Action)(() => AppendLog(line)));
                return;
            }
            if (_txtLog.TextLength > 0)
            {
                _txtLog.AppendText(Environment.NewLine);
            }
            _txtLog.AppendText(line);
        }

        private void StartInstallFlow()
        {
            if (_busy) return;
            string nodeExe = Program.FindNodeExecutable();
            bool installWingetNode = false;
            if (string.IsNullOrEmpty(nodeExe))
            {
                if (!Program.HasWinget())
                {
                    MessageBox.Show(
                        this,
                        "Node.js не найден в системе. Пожалуйста, установите Node.js LTS с сайта https://nodejs.org/ и повторите запуск.",
                        "Требуется Node.js",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return;
                }
                DialogResult ans = MessageBox.Show(
                    this,
                    "Для работы плагина требуется Node.js LTS.\\nУстановить OpenJS.NodeJS.LTS автоматически через winget прямо сейчас?",
                    "Автоустановка Node.js",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (ans != DialogResult.Yes) return;
                installWingetNode = true;
            }

            _txtLog.Clear();
            SetBusy(true);
            AppendLog("Запуск установки The Tunnel...");

            Thread worker = new Thread(() =>
            {
                int code = 0;
                try
                {
                    if (installWingetNode)
                    {
                        AppendLog("[i] Установка OpenJS.NodeJS.LTS через winget...");
                        int wgCode = Program.RunExternalProcess(
                            "winget",
                            "install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements",
                            "",
                            AppendLog
                        );
                        if (wgCode != 0)
                        {
                            AppendLog("[WARN] winget завершился с кодом " + wgCode + ". Проверяем наличие Node.js...");
                        }
                    }
                    SetupOptions runOpts = new SetupOptions();
                    runOpts.Silent = false;
                    runOpts.Uninstall = false;
                    runOpts.TargetDir = _targetDir;
                    code = Program.ExecuteInstallOrUninstall(runOpts, AppendLog);
                }
                catch (Exception ex)
                {
                    code = 1;
                    AppendLog("[ОШИБКА] " + ex.Message);
                }
                ExitCode = code;
                if (!IsDisposed)
                {
                    BeginInvoke((Action)(() =>
                    {
                        SetBusy(false);
                        RefreshDiagnostics();
                        if (code == 0)
                        {
                            MessageBox.Show(
                                this,
                                "Плагин The Tunnel успешно установлен.\\nПерезапустите Google Antigravity для применения изменений.",
                                "Установка завершена",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Information
                            );
                        }
                        else
                        {
                            MessageBox.Show(
                                this,
                                "Установка завершилась с ошибкой (код " + code + "). Подробности смотрите в журнале.",
                                "Ошибка установки",
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Error
                            );
                        }
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void StartUninstallFlow()
        {
            if (_busy) return;
            DialogResult confirm = MessageBox.Show(
                this,
                "Удалить плагин из папки:\\n" + _targetDir + "\\n\\nРезервная копия настроек router-state.json будет сохранена рядом с папкой плагина.",
                "Подтверждение удаления",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (confirm != DialogResult.Yes) return;

            _txtLog.Clear();
            SetBusy(true);
            AppendLog("Удаление плагина...");

            Thread worker = new Thread(() =>
            {
                int code = 0;
                try
                {
                    SetupOptions runOpts = new SetupOptions();
                    runOpts.Silent = false;
                    runOpts.Uninstall = true;
                    runOpts.TargetDir = _targetDir;
                    code = Program.ExecuteInstallOrUninstall(runOpts, AppendLog);
                }
                catch (Exception ex)
                {
                    code = 1;
                    AppendLog("[ОШИБКА] " + ex.Message);
                }
                ExitCode = code;
                if (!IsDisposed)
                {
                    BeginInvoke((Action)(() =>
                    {
                        SetBusy(false);
                        RefreshDiagnostics();
                    }));
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void OpenTargetFolder()
        {
            string openPath = Directory.Exists(_targetDir) ? _targetDir : Path.GetDirectoryName(_targetDir);
            if (!string.IsNullOrEmpty(openPath) && Directory.Exists(openPath))
            {
                Process.Start("explorer.exe", openPath);
            }
            else
            {
                MessageBox.Show(this, "Папка ещё не создана: " + openPath, "Информация", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
    }
}
`;
}

/**
 * Собирает релизные пакеты (ZIP + автономный Setup.exe на Windows + SHA256SUMS.txt).
 * @param {{ repoRoot?: string, outDir?: string, zipOnly?: boolean, silent?: boolean }} [options]
 */
export function buildReleasePackages(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_REPO_ROOT);
  const outDir = path.resolve(options.outDir || path.join(repoRoot, 'dist'));
  const zipOnly = Boolean(options.zipOnly);
  const log = options.silent ? () => {} : (...args) => console.log(...args);

  const pluginJsonPath = path.join(repoRoot, 'plugin.json');
  const pkgJsonPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pluginJsonPath) || !fs.existsSync(pkgJsonPath)) {
    throw new Error('Отсутствуют plugin.json или package.json в корне репозитория');
  }
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const version = String(pluginJson.version || pkgJson.version || '3.31.0');
  if (pluginJson.version && pkgJson.version && pluginJson.version !== pkgJson.version) {
    throw new Error(`Несовпадение версий: plugin.json=${pluginJson.version}, package.json=${pkgJson.version}`);
  }

  buildPanelUi({ repoRoot });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-pack-'));
  try {
    const stageDir = path.join(tmpRoot, 'antigravity-model-router');
    fs.mkdirSync(stageDir, { recursive: true });

    for (const fileName of ROOT_FILES) {
      const srcFile = path.join(repoRoot, fileName);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(stageDir, fileName));
      }
    }
    for (const dirName of MANAGED_DIRS) {
      const srcSub = path.join(repoRoot, dirName);
      if (fs.existsSync(srcSub)) {
        copyFilteredDir(srcSub, path.join(stageDir, dirName));
      }
    }

    // Санитизация конфигов внутри дистрибутива (без изменения рабочих файлов репозитория)
    let rawState = {};
    try {
      rawState = JSON.parse(fs.readFileSync(path.join(repoRoot, 'router-state.json'), 'utf8'));
    } catch {}
    fs.writeFileSync(
      path.join(stageDir, 'router-state.json'),
      JSON.stringify(createSanitizedDefaultState(rawState), null, 2) + '\n',
      'utf8'
    );

    let rawMcp = {};
    try {
      rawMcp = JSON.parse(fs.readFileSync(path.join(repoRoot, 'mcp_config.json'), 'utf8'));
    } catch {}
    fs.writeFileSync(
      path.join(stageDir, 'mcp_config.json'),
      JSON.stringify(createSanitizedMcpConfig(rawMcp), null, 2) + '\n',
      'utf8'
    );

    fs.writeFileSync(path.join(stageDir, 'Удалить плагин.bat'), UNINSTALL_BAT_CONTENT, 'utf8');

    const stagedFiles = collectFilesForZip(stageDir);
    fs.mkdirSync(outDir, { recursive: true });

    const expectedZipName = `The-Tunnel-v${version}.zip`;
    const expectedExeName = `The-Tunnel-v${version}-Setup.exe`;
    for (const entryName of fs.readdirSync(outDir)) {
      if (!/^(?:The-Tunnel|Antigravity-Model-Router)-v.+\.(?:zip|exe)$/i.test(entryName)) continue;
      const keepCurrentExe = zipOnly && entryName === expectedExeName;
      if (entryName !== expectedZipName && !keepCurrentExe) {
        try {
          fs.unlinkSync(path.join(outDir, entryName));
        } catch {}
      }
    }

    const zipFileName = expectedZipName;
    const zipOutPath = path.join(outDir, zipFileName);
    const portableZipEntries = stagedFiles.map((item) => ({
      name: `antigravity-model-router/${item.rel}`,
      data: item.data,
      mtime: item.mtime,
      mode: item.mode,
    }));
    const zipBuffer = buildZipBuffer(portableZipEntries);
    fs.writeFileSync(zipOutPath, zipBuffer);
    log(`[✓] Собран портативный архив: ${zipOutPath} (${(zipBuffer.length / 1024).toFixed(1)} КБ)`);

    let exeOutPath = '';
    const cscPath = !zipOnly ? findCscCompiler() : '';
    if (!zipOnly && cscPath) {
      const payloadZipPath = path.join(tmpRoot, 'payload.zip');
      const payloadEntries = stagedFiles.map((item) => ({
        name: item.rel,
        data: item.data,
        mtime: item.mtime,
        mode: item.mode,
      }));
      fs.writeFileSync(payloadZipPath, buildZipBuffer(payloadEntries));

      const iconPath = path.join(tmpRoot, 'app.ico');
      fs.writeFileSync(iconPath, buildIconBuffer());

      const csPath = path.join(tmpRoot, 'Installer.cs');
      const csSource = buildInstallerCSharpSource(version);
      // UTF-8 BOM обязателен, чтобы csc.exe корректно читал кириллицу
      fs.writeFileSync(csPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csSource, 'utf8')]));

      const exeFileName = `The-Tunnel-v${version}-Setup.exe`;
      exeOutPath = path.join(outDir, exeFileName);
      execFileSync(
        cscPath,
        [
          '/nologo',
          '/optimize+',
          '/target:winexe',
          `/out:${exeOutPath}`,
          `/win32icon:${iconPath}`,
          `/resource:${payloadZipPath},Antigravity.Payload.zip`,
          '/r:System.dll',
          '/r:System.Core.dll',
          '/r:System.Drawing.dll',
          '/r:System.Windows.Forms.dll',
          '/r:System.IO.Compression.dll',
          '/r:System.IO.Compression.FileSystem.dll',
          csPath,
        ],
        { encoding: 'utf8', timeout: 30000 }
      );
      const exeStat = fs.statSync(exeOutPath);
      log(`[✓] Собран автономный установщик: ${exeOutPath} (${(exeStat.size / 1024).toFixed(1)} КБ)`);
    } else if (!zipOnly && process.platform === 'win32') {
      log('[WARN] csc.exe (.NET Framework 4.x) не найден — сборка .exe пропущена, создан только ZIP.');
    }

    const artifacts = [];
    for (const filePath of [exeOutPath, zipOutPath].filter(Boolean)) {
      const buf = fs.readFileSync(filePath);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      artifacts.push({
        fileName: path.basename(filePath),
        path: filePath,
        bytes: buf.length,
        kb: Number((buf.length / 1024).toFixed(1)),
        sha256,
      });
    }

    const sumsPath = path.join(outDir, 'SHA256SUMS.txt');
    fs.writeFileSync(
      sumsPath,
      artifacts.map((a) => `${a.sha256}  ${a.fileName}`).join('\n') + '\n',
      'utf8'
    );

    const manifestPath = path.join(outDir, 'release-manifest.json');
    const manifest = {
      name: pluginJson.name || 'antigravity-model-router',
      version,
      builtAt: new Date().toISOString(),
      stagedFileCount: stagedFiles.length,
      artifacts,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    log(`[✓] Контрольные суммы записаны: ${sumsPath}`);

    return {
      ok: true,
      version,
      outDir,
      zipPath: zipOutPath,
      exePath: exeOutPath,
      sumsPath,
      manifestPath,
      stagedFileCount: stagedFiles.length,
      artifacts,
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function parsePackCliArgs(argv = process.argv.slice(2)) {
  const opts = { zipOnly: false, outDir: '', silent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i] || '').trim();
    if (a === '--zip-only') opts.zipOnly = true;
    else if (a === '--silent') opts.silent = true;
    else if (a === '--out' && i + 1 < argv.length) opts.outDir = String(argv[++i] || '').trim();
    else if (a.startsWith('--out=')) opts.outDir = a.slice('--out='.length).trim();
  }
  return opts;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(__filename);
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();

if (isMain) {
  const cli = parsePackCliArgs(process.argv.slice(2));
  buildReleasePackages({
    zipOnly: cli.zipOnly,
    outDir: cli.outDir || undefined,
    silent: cli.silent,
  });
}
