#!/usr/bin/env node
/**
 * @file build-showroom.mjs
 * @description Generates a self-contained A/B/C Visual Showroom HTML page for comparing
 * UI designs, game animations/VFX, and video motion overlays with slow-motion (0.25x/0.5x/1x),
 * replay trigger, and alpha-checkerboard toggle.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeLang, readActiveUiLanguage } from '../../../core/i18n.mjs';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeSrcdoc(htmlStr) {
  return String(htmlStr ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function sanitizeExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 2048 || /[\r\n\0]/.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {}
  return '';
}

function formatSourceHostLabel(safeUrl) {
  try {
    const u = new URL(safeUrl);
    return u.hostname.replace(/^www\./i, '') || safeUrl;
  } catch {
    return safeUrl;
  }
}

function normalizeNotesText(rawNotes) {
  if (Array.isArray(rawNotes)) {
    return rawNotes
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .join(' • ');
  }
  return typeof rawNotes === 'string' ? rawNotes.trim() : '';
}

function resolveReferenceImageSrc(rawRef) {
  if (typeof rawRef !== 'string') return '';
  const trimmed = rawRef.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return '';
  if (/^(?:javascript|vbscript):/i.test(trimmed)) return '';
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^(?:https?:|file:)\/\//i.test(trimmed)) {
    return trimmed;
  }
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) {
      const st = fs.statSync(resolved);
      if (st.isFile() && st.size > 0 && st.size <= 8 * 1024 * 1024) {
        const ext = path.extname(resolved).toLowerCase();
        const mimeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
        };
        const mime = mimeMap[ext];
        if (mime) {
          return `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
        }
      }
    }
  } catch {}
  return trimmed;
}

/**
 * Wraps a variant's HTML/CSS/JS into a self-contained iframe document with Web Animations & CSS speed control.
 */
function buildVariantDocument(variant = {}) {
  const css = String(variant.css || '').replace(/<\/style/gi, '<\\/style');
  const refImgSrc = resolveReferenceImageSrc(variant.referenceImage);
  const fallbackStageHtml = refImgSrc
    ? `<img src="${escapeHtml(refImgSrc)}" alt="${escapeHtml(variant.label || 'Design Reference')}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.35);" />`
    : '<div class="demo-box">Variant Preview</div>';
  const html = String(variant.html || fallbackStageHtml).replace(/<\/script/gi, '&lt;/script');
  const js = String(variant.js || '').replace(/<\/script/gi, '<\\/script');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 16px; width: 100%; height: 100%;
    display: flex; align-items: center; justify-content: center;
    background: transparent; color: #f0f4f8;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    --anim-scale: 1;
  }
  ${css}
</style>
</head>
<body>
  <div id="stage-root" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
    ${html}
  </div>
  <script>
    const initialMarkup = document.getElementById('stage-root').innerHTML;
    let currentSpeed = 1;

    function applyPlaybackRate(rate) {
      currentSpeed = rate;
      document.documentElement.style.setProperty('--anim-scale', String(1 / rate));
      if (document.getAnimations) {
        for (const anim of document.getAnimations({ subtree: true })) {
          try { anim.playbackRate = rate; } catch {}
        }
      }
    }

    function runCustomScript() {
      try {
        ${js}
      } catch (e) {
        console.error(e);
      }
      requestAnimationFrame(() => applyPlaybackRate(currentSpeed));
    }

    window.addEventListener('message', (ev) => {
      if (!ev.data || typeof ev.data !== 'object') return;
      if (ev.data.type === 'REPLAY') {
        const root = document.getElementById('stage-root');
        root.innerHTML = '';
        void root.offsetWidth;
        root.innerHTML = initialMarkup;
        runCustomScript();
      } else if (ev.data.type === 'SPEED') {
        applyPlaybackRate(Number(ev.data.rate || 1));
      }
    });

    runCustomScript();
  </script>
</body>
</html>`;
}

/**
 * Generates full A/B/C showroom HTML string from spec object.
 * @param {object} spec
 * @param {string} [spec.title='Витрина выбора дизайна и анимации (A / B / C)']
 * @param {Array<{ id?: string, label: string, subtitle?: string, html: string, css?: string, js?: string }>} [spec.variants=[]]
 * @returns {{ ok: boolean, html: string, variantCount: number }}
 */
export function generateShowroomHtml(spec = {}, options = {}) {
  if (!spec || typeof spec !== 'object') {
    return { ok: false, html: '', variantCount: 0 };
  }

  const showLang = normalizeLang(options.lang || spec.lang || readActiveUiLanguage(), 'en');
  const isEn = showLang === 'en';
  const title = String(spec.title || (isEn ? 'Design & Motion Showroom (A / B / C)' : 'Витрина вариантов дизайна и анимации (A / B / C)'));
  const hasExplicitVariants = Array.isArray(spec.variants) && spec.variants.length > 0;
  const hasExplicitRefs = Array.isArray(spec.references) && spec.references.length > 0;
  const rawVariants = hasExplicitVariants
    ? spec.variants
    : hasExplicitRefs
      ? spec.references
      : (isEn
          ? [
              {
                id: 'A',
                label: 'Variant A — Light Editorial Studio',
                subtitle: 'Warm paper canvas + high-contrast serif typography and asymmetric split grid',
                stageBg: '#f7f3eb',
                accentColor: '#c85a32',
                css: `body { background: #f7f3eb; color: #1c1917; } .editorial { width: 100%; max-width: 440px; padding: 18px 22px; border-radius: 6px; background: #fffdf9; border: 1.5px solid #1c1917; box-shadow: 5px 5px 0 #1c1917; display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; align-items: center; animation: reveal calc(0.42s * var(--anim-scale, 1)) cubic-bezier(0.16, 1, 0.3, 1) forwards; } @keyframes reveal { 0% { transform: translateY(12px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }`,
                html: `<div class="editorial"><div><div style="font-size:10px;color:#c85a32;letter-spacing:1.2px;font-weight:800;">EDITORIAL PAPER</div><div style="font-size:20px;font-weight:800;margin-top:4px;font-family:Georgia,serif;color:#1c1917;">Warm Studio</div><div style="font-size:12px;color:#57534e;margin-top:4px;">Crisp hierarchy and breathing room</div></div><div style="background:#f3ede2;border:1px solid #d6cfc2;padding:10px;border-radius:4px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#c85a32;">98.4%</div><div style="font-size:10px;color:#57534e;">Accuracy</div></div></div>`
              },
              {
                id: 'B',
                label: 'Variant B — Architectural Bento Dashboard',
                subtitle: 'Modular tile matrix + deep slate surfaces and cobalt accent',
                stageBg: '#eef2f6',
                accentColor: '#2563eb',
                css: `body { background: #eef2f6; color: #0f172a; } .bento { width: 100%; max-width: 450px; display: grid; grid-template-columns: 1.2fr 1fr; gap: 10px; animation: snapIn calc(0.36s * var(--anim-scale, 1)) cubic-bezier(0.22, 1, 0.36, 1) forwards; } .tile { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; box-shadow: 0 4px 12px rgba(15,23,42,0.06); } @keyframes snapIn { 0% { transform: scale(0.94); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }`,
                html: `<div class="bento"><div class="tile"><div style="font-size:10px;color:#2563eb;font-weight:700;">BENTO MATRIX</div><div style="font-size:18px;font-weight:800;margin-top:4px;color:#0f172a;">Modular Grid</div><div style="font-size:11px;color:#64748b;margin-top:4px;">Fast metric overview</div></div><div class="tile" style="background:#1e293b;color:#f8fafc;border-color:#1e293b;"><div style="font-size:10px;color:#93c5fd;">ACTIVITY</div><div style="font-size:20px;font-weight:800;margin-top:6px;">+42%</div></div></div>`
              },
              {
                id: 'C',
                label: 'Variant C — Atmospheric Obsidian & Amber',
                subtitle: 'Deep dark canvas + warm amber glow and fluid spring cascade',
                stageBg: '#12100e',
                accentColor: '#f59e0b',
                css: `body { background: #12100e; color: #fafaf9; } .studio-card { width: 100%; max-width: 430px; padding: 18px 24px; border-radius: 16px; background: linear-gradient(145deg, #1c1917 0%, #141210 100%); border: 1px solid rgba(245,158,11,0.35); box-shadow: 0 14px 32px rgba(0,0,0,0.55); animation: floatIn calc(0.48s * var(--anim-scale, 1)) cubic-bezier(0.34, 1.56, 0.64, 1) forwards; } @keyframes floatIn { 0% { transform: translateY(16px) scale(0.9); opacity: 0; } 100% { transform: translateY(0) scale(1); opacity: 1; } }`,
                html: `<div class="studio-card"><div style="font-size:10px;color:#f59e0b;font-weight:700;letter-spacing:0.8px;">OBSIDIAN & AMBER</div><div style="font-size:20px;font-weight:800;margin-top:6px;color:#fafaf9;">Cinematic Contrast</div><div style="font-size:12px;color:#a8a29e;margin-top:4px;">Deep shadows and warm tactile feedback</div></div>`
              }
            ]
          : [
              {
                id: 'A',
                label: 'Вариант A — Светлая редакционная студия',
                subtitle: 'Тёплый бумажный холст + контрастная типографика и асимметричная сплит-сетка',
                stageBg: '#f7f3eb',
                accentColor: '#c85a32',
                css: `body { background: #f7f3eb; color: #1c1917; } .editorial { width: 100%; max-width: 440px; padding: 18px 22px; border-radius: 6px; background: #fffdf9; border: 1.5px solid #1c1917; box-shadow: 5px 5px 0 #1c1917; display: grid; grid-template-columns: 1.3fr 1fr; gap: 14px; align-items: center; animation: reveal calc(0.42s * var(--anim-scale, 1)) cubic-bezier(0.16, 1, 0.3, 1) forwards; } @keyframes reveal { 0% { transform: translateY(12px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }`,
                html: `<div class="editorial"><div><div style="font-size:10px;color:#c85a32;letter-spacing:1.2px;font-weight:800;">EDITORIAL PAPER</div><div style="font-size:20px;font-weight:800;margin-top:4px;font-family:Georgia,serif;color:#1c1917;">Тёплая студия</div><div style="font-size:12px;color:#57534e;margin-top:4px;">Чистая иерархия и воздух</div></div><div style="background:#f3ede2;border:1px solid #d6cfc2;padding:10px;border-radius:4px;text-align:center;"><div style="font-size:18px;font-weight:800;color:#c85a32;">98.4%</div><div style="font-size:10px;color:#57534e;">Точность</div></div></div>`
              },
              {
                id: 'B',
                label: 'Вариант B — Архитектурный Bento-дашборд',
                subtitle: 'Модульная плиточная матрица + глубокий графит и кобальтовый акцент',
                stageBg: '#eef2f6',
                accentColor: '#2563eb',
                css: `body { background: #eef2f6; color: #0f172a; } .bento { width: 100%; max-width: 450px; display: grid; grid-template-columns: 1.2fr 1fr; gap: 10px; animation: snapIn calc(0.36s * var(--anim-scale, 1)) cubic-bezier(0.22, 1, 0.36, 1) forwards; } .tile { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; box-shadow: 0 4px 12px rgba(15,23,42,0.06); } @keyframes snapIn { 0% { transform: scale(0.94); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }`,
                html: `<div class="bento"><div class="tile"><div style="font-size:10px;color:#2563eb;font-weight:700;">BENTO MATRIX</div><div style="font-size:18px;font-weight:800;margin-top:4px;color:#0f172a;">Модульная сетка</div><div style="font-size:11px;color:#64748b;margin-top:4px;">Быстрый обзор метрик</div></div><div class="tile" style="background:#1e293b;color:#f8fafc;border-color:#1e293b;"><div style="font-size:10px;color:#93c5fd;">АКТИВНОСТЬ</div><div style="font-size:20px;font-weight:800;margin-top:6px;">+42%</div></div></div>`
              },
              {
                id: 'C',
                label: 'Вариант C — Атмосферный обсидиан и янтарь',
                subtitle: 'Глубокий тёмный холст + тёплое янтарное свечение и плавный каскад',
                stageBg: '#12100e',
                accentColor: '#f59e0b',
                css: `body { background: #12100e; color: #fafaf9; } .studio-card { width: 100%; max-width: 430px; padding: 18px 24px; border-radius: 16px; background: linear-gradient(145deg, #1c1917 0%, #141210 100%); border: 1px solid rgba(245,158,11,0.35); box-shadow: 0 14px 32px rgba(0,0,0,0.55); animation: floatIn calc(0.48s * var(--anim-scale, 1)) cubic-bezier(0.34, 1.56, 0.64, 1) forwards; } @keyframes floatIn { 0% { transform: translateY(16px) scale(0.9); opacity: 0; } 100% { transform: translateY(0) scale(1); opacity: 1; } }`,
                html: `<div class="studio-card"><div style="font-size:10px;color:#f59e0b;font-weight:700;letter-spacing:0.8px;">OBSIDIAN & AMBER</div><div style="font-size:20px;font-weight:800;margin-top:6px;color:#fafaf9;">Кинематографичный контраст</div><div style="font-size:12px;color:#a8a29e;margin-top:4px;">Глубокие тени и тёплый отклик</div></div>`
              }
            ]);

  const cardsHtml = rawVariants.slice(0, 6).map((v, idx) => {
    const theme = inferVariantVisualTheme(v, idx);
    const badge = escapeHtml(v.id || String.fromCharCode(65 + idx));
    const label = escapeHtml(v.label || `${isEn ? 'Variant' : 'Вариант'} ${badge}`);
    const sub = escapeHtml(v.subtitle || '');
    const srcdoc = escapeSrcdoc(buildVariantDocument(v));
    const stageBgStyle = escapeHtml(theme.stageBgCss || '#111318');
    const accentHexStyle = escapeHtml(theme.accentHex || '#3b82f6');
    const refImgSrc = resolveReferenceImageSrc(v.referenceImage);
    const safeUrl = sanitizeExternalUrl(v.sourceUrl);
    const notesText = normalizeNotesText(v.notes);
    const showThumbInMeta = Boolean(v.html && refImgSrc);
    const hasRefMeta = Boolean(showThumbInMeta || safeUrl || notesText);
    const refMetaHtml = hasRefMeta
      ? `
        <div class="variant-ref-meta">
          ${showThumbInMeta ? `<img class="ref-thumb" src="${escapeHtml(refImgSrc)}" alt="${isEn ? 'Reference' : 'Референс'} ${badge}">` : ''}
          <div class="ref-meta-body">
            ${safeUrl ? `<a class="ref-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">🔗 ${isEn ? 'Source' : 'Источник'}: ${escapeHtml(formatSourceHostLabel(safeUrl))}</a>` : ''}
            ${notesText ? `<div class="ref-notes">${escapeHtml(notesText)}</div>` : ''}
          </div>
        </div>`
      : '';

    return `
      <div class="variant-card" style="--v-accent: ${accentHexStyle};">
        <div class="variant-head">
          <div>
            <span class="variant-badge" style="color:${accentHexStyle};border-color:${accentHexStyle};background:${accentHexStyle}22;">${badge}</span>
            <strong class="variant-title">${label}</strong>
            ${sub ? `<div class="variant-sub">${sub}</div>` : ''}
          </div>
          <button type="button" class="btn-sm" onclick="replaySingle(${idx})">${isEn ? '↻ Replay' : '↻ Повтор'}</button>
        </div>
        <div class="stage-wrap" id="wrap-${idx}" style="background: ${stageBgStyle};">
          <iframe id="frame-${idx}" class="stage-frame" sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>
        </div>${refMetaHtml}
      </div>`;
  }).join('\n');

  const extraRefsHtml = (hasExplicitVariants && hasExplicitRefs)
    ? `
  <section class="ref-strip-section">
    <div class="ref-strip-title">🌐 ${isEn ? 'Source web references' : 'Исходные веб-референсы'}</div>
    <div class="ref-strip-grid">
      ${spec.references.slice(0, 6).map((r, rIdx) => {
        const rLabel = escapeHtml(r.label || `${isEn ? 'Reference' : 'Референс'} ${rIdx + 1}`);
        const rImg = resolveReferenceImageSrc(r.referenceImage);
        const rUrl = sanitizeExternalUrl(r.sourceUrl);
        const rNotes = normalizeNotesText(r.notes);
        return `
        <div class="ref-strip-card">
          ${rImg ? `<img class="ref-strip-img" src="${escapeHtml(rImg)}" alt="${rLabel}">` : ''}
          <div class="ref-meta-body">
            <strong class="variant-title">${rLabel}</strong>
            ${rUrl ? `<a class="ref-link" href="${escapeHtml(rUrl)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(formatSourceHostLabel(rUrl))}</a>` : ''}
            ${rNotes ? `<div class="ref-notes">${escapeHtml(rNotes)}</div>` : ''}
          </div>
        </div>`;
      }).join('\n')}
    </div>
  </section>`
    : '';

  const fullHtml = `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'ru'}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #111216;
    --panel: #181a20;
    --border: #2a2e39;
    --accent: #7c9cff;
    --text: #eceef2;
    --sub: #9499a6;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px; background: var(--bg); color: var(--text);
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .toolbar {
    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
    gap: 12px; padding: 12px 16px; background: var(--panel);
    border: 1px solid var(--border); border-radius: 10px; margin-bottom: 18px;
  }
  .toolbar-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  button {
    background: #22252f; color: var(--text); border: 1px solid var(--border);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
    transition: transform 0.12s ease, border-color 0.12s ease;
  }
  button:hover { border-color: var(--accent); }
  button:active { transform: translateY(1px); }
  button.active { background: rgba(124, 156, 255, 0.16); border-color: var(--accent); color: var(--accent); }
  .btn-primary { background: linear-gradient(135deg, #4f6bed, #3b52c9); border-color: var(--accent); color: #fff; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 16px;
  }
  .variant-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  .variant-head {
    padding: 10px 14px; border-bottom: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
  }
  .variant-badge {
    display: inline-block; background: rgba(124,156,255,0.16); color: var(--accent);
    border: 1px solid var(--accent); border-radius: 4px; padding: 1px 6px;
    font-size: 11px; font-weight: 800; margin-right: 6px;
  }
  .variant-title { font-size: 13px; }
  .variant-sub { font-size: 11px; color: var(--sub); margin-top: 2px; }
  .stage-wrap {
    height: 280px; position: relative; background: #090d14;
  }
  .stage-wrap.checkerboard {
    background-image:
      linear-gradient(45deg, #18202c 25%, transparent 25%),
      linear-gradient(-45deg, #18202c 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #18202c 75%),
      linear-gradient(-45deg, transparent 75%, #18202c 75%);
    background-size: 20px 20px;
    background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  }
  .stage-frame { width: 100%; height: 100%; border: 0; display: block; }
  .variant-ref-meta {
    padding: 9px 14px; border-top: 1px solid var(--border); background: rgba(12, 14, 19, 0.72);
    display: flex; align-items: flex-start; gap: 10px;
  }
  .ref-thumb {
    width: 64px; height: 44px; object-fit: cover; border-radius: 5px;
    border: 1px solid var(--border); flex-shrink: 0; background: #0d0f14;
  }
  .ref-meta-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
  .ref-link {
    color: var(--accent); font-size: 11.5px; font-weight: 600; text-decoration: none;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ref-link:hover { text-decoration: underline; }
  .ref-notes { font-size: 11px; color: var(--sub); line-height: 1.38; }
  .ref-strip-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
  .ref-strip-title { font-size: 13.5px; font-weight: 700; margin-bottom: 12px; color: var(--text); }
  .ref-strip-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px;
  }
  .ref-strip-card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 9px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .ref-strip-img {
    width: 100%; height: 140px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border);
  }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-title">🎨 ${escapeHtml(title)}</div>
    <div class="controls">
      <button type="button" class="btn-primary" onclick="replayAll()">${isEn ? '▶ Replay all' : '▶ Проиграть все (Replay)'}</button>
      <span style="font-size:12px;color:var(--sub);margin-left:4px;">${isEn ? 'Speed:' : 'Скорость:'}</span>
      <button type="button" class="speed-btn" data-rate="0.25" onclick="setSpeed(0.25)">0.25x</button>
      <button type="button" class="speed-btn" data-rate="0.5" onclick="setSpeed(0.5)">0.5x</button>
      <button type="button" class="speed-btn active" data-rate="1" onclick="setSpeed(1)">1x</button>
      <button type="button" id="bgBtn" onclick="toggleCheckerboard()">${isEn ? '🏁 Alpha grid (Video)' : '🏁 Альфа-сетка (Видео)'}</button>
    </div>
  </div>
  <div class="grid">
    ${cardsHtml}
  </div>${extraRefsHtml}
  <script>
    function replaySingle(idx) {
      const f = document.getElementById('frame-' + idx);
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'REPLAY' }, '*');
    }
    function replayAll() {
      document.querySelectorAll('.stage-frame').forEach((f) => {
        if (f.contentWindow) f.contentWindow.postMessage({ type: 'REPLAY' }, '*');
      });
    }
    function setSpeed(rate) {
      document.querySelectorAll('.speed-btn').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.rate) === rate);
      });
      document.querySelectorAll('.stage-frame').forEach((f) => {
        if (f.contentWindow) f.contentWindow.postMessage({ type: 'SPEED', rate }, '*');
      });
      replayAll();
    }
    function toggleCheckerboard() {
      const btn = document.getElementById('bgBtn');
      btn.classList.toggle('active');
      document.querySelectorAll('.stage-wrap').forEach((w) => w.classList.toggle('checkerboard'));
    }
  </script>
</body>
</html>`;

  return {
    ok: true,
    html: fullHtml,
    variantCount: rawVariants.slice(0, 6).length,
    variants: rawVariants.slice(0, 6)
  };
}

// ============================================================================
// DETERMINISTIC VISUAL PREVIEW PNG ENGINE (Headless Browser + Pure-Node Fallback)
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(typeStr, dataBuf) {
  const typeBuf = Buffer.from(typeStr, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuf.length, 0);
  const crcInput = Buffer.concat([typeBuf, dataBuf]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, dataBuf, crcBuf]);
}

function encodeRgbaToPngBuffer(width, height, rgba) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // Filter type 0 (None)
    const srcStart = y * width * 4;
    rgba.copy(raw, rowStart + 1, srcStart, srcStart + width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
}

// 5x7 bitmap font supporting ASCII + Russian Cyrillic (uppercase & lowercase mapped cleanly)
const GLYPHS_5X7 = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
  '—': [0, 0, 0, 31, 0, 0, 0],
  '+': [0, 4, 4, 31, 4, 4, 0],
  ':': [0, 12, 12, 0, 12, 12, 0],
  '.': [0, 0, 0, 0, 0, 12, 12],
  ',': [0, 0, 0, 0, 4, 4, 8],
  '/': [1, 2, 4, 8, 16, 0, 0],
  '(': [2, 4, 8, 8, 8, 4, 2],
  ')': [8, 4, 2, 2, 2, 4, 8],
  '!': [4, 4, 4, 4, 0, 0, 4],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 6, 8, 16, 31],
  '3': [31, 2, 4, 6, 1, 17, 14],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  'A': [14, 17, 17, 31, 17, 17, 17],
  'B': [30, 17, 17, 30, 17, 17, 30],
  'C': [14, 17, 16, 16, 16, 17, 14],
  'D': [28, 18, 17, 17, 17, 18, 28],
  'E': [31, 16, 16, 30, 16, 16, 31],
  'F': [31, 16, 16, 30, 16, 16, 16],
  'G': [14, 17, 16, 23, 17, 17, 15],
  'H': [17, 17, 17, 31, 17, 17, 17],
  'I': [14, 4, 4, 4, 4, 4, 14],
  'J': [7, 2, 2, 2, 2, 18, 12],
  'K': [17, 18, 20, 24, 20, 18, 17],
  'L': [16, 16, 16, 16, 16, 16, 31],
  'M': [17, 27, 21, 21, 17, 17, 17],
  'N': [17, 25, 21, 19, 17, 17, 17],
  'O': [14, 17, 17, 17, 17, 17, 14],
  'P': [30, 17, 17, 30, 16, 16, 16],
  'Q': [14, 17, 17, 17, 21, 18, 13],
  'R': [30, 17, 17, 30, 20, 18, 17],
  'S': [15, 16, 16, 14, 1, 1, 30],
  'T': [31, 4, 4, 4, 4, 4, 4],
  'U': [17, 17, 17, 17, 17, 17, 14],
  'V': [17, 17, 17, 17, 17, 10, 4],
  'W': [17, 17, 17, 21, 21, 27, 17],
  'X': [17, 17, 10, 4, 10, 17, 17],
  'Y': [17, 17, 10, 4, 4, 4, 4],
  'Z': [31, 1, 2, 4, 8, 16, 31],
  // Cyrillic
  'А': [14, 17, 17, 31, 17, 17, 17],
  'Б': [31, 16, 16, 30, 17, 17, 30],
  'В': [30, 17, 17, 30, 17, 17, 30],
  'Г': [31, 16, 16, 16, 16, 16, 16],
  'Д': [6, 10, 10, 10, 10, 31, 17],
  'Е': [31, 16, 16, 30, 16, 16, 31],
  'Ё': [10, 31, 16, 30, 16, 16, 31],
  'Ж': [21, 21, 14, 4, 14, 21, 21],
  'З': [14, 17, 1, 6, 1, 17, 14],
  'И': [17, 17, 19, 21, 25, 17, 17],
  'Й': [4, 17, 19, 21, 25, 17, 17],
  'К': [17, 18, 20, 24, 20, 18, 17],
  'Л': [7, 9, 9, 9, 9, 9, 17],
  'М': [17, 27, 21, 21, 17, 17, 17],
  'Н': [17, 17, 17, 31, 17, 17, 17],
  'О': [14, 17, 17, 17, 17, 17, 14],
  'П': [31, 17, 17, 17, 17, 17, 17],
  'Р': [30, 17, 17, 30, 16, 16, 16],
  'С': [14, 17, 16, 16, 16, 17, 14],
  'Т': [31, 4, 4, 4, 4, 4, 4],
  'У': [17, 17, 17, 15, 1, 17, 14],
  'Ф': [4, 14, 21, 21, 14, 4, 4],
  'Х': [17, 17, 10, 4, 10, 17, 17],
  'Ц': [18, 18, 18, 18, 18, 31, 1],
  'Ч': [17, 17, 17, 15, 1, 1, 1],
  'Ш': [21, 21, 21, 21, 21, 21, 31],
  'Щ': [21, 21, 21, 21, 21, 31, 1],
  'Ъ': [24, 8, 8, 14, 9, 9, 14],
  'Ы': [17, 17, 17, 29, 19, 19, 29],
  'Ь': [16, 16, 16, 30, 17, 17, 30],
  'Э': [14, 17, 1, 7, 1, 17, 14],
  'Ю': [18, 21, 21, 29, 21, 21, 18],
  'Я': [15, 17, 17, 15, 5, 9, 17]
};

function blendPixel(rgba, width, height, x, y, r, g, b, a = 255) {
  const ix = x | 0;
  const iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= width || iy >= height || a <= 0) return;
  const idx = (iy * width + ix) * 4;
  if (a >= 255) {
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = 255;
    return;
  }
  const alpha = a / 255;
  const inv = 1 - alpha;
  rgba[idx] = Math.round(r * alpha + rgba[idx] * inv);
  rgba[idx + 1] = Math.round(g * alpha + rgba[idx + 1] * inv);
  rgba[idx + 2] = Math.round(b * alpha + rgba[idx + 2] * inv);
  rgba[idx + 3] = 255;
}

function drawRoundedRect(rgba, width, height, rx, ry, rw, rh, radius, fillColor, borderColor = null, borderWidth = 1) {
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(rw, rh) / 2)));
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(width - 1, Math.ceil(rx + rw));
  const y1 = Math.min(height - 1, Math.ceil(ry + rh));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let dx = 0;
      let dy = 0;
      if (x < rx + r) dx = (rx + r) - x;
      else if (x > rx + rw - r - 1) dx = x - (rx + rw - r - 1);
      if (y < ry + r) dy = (ry + r) - y;
      else if (y > ry + rh - r - 1) dy = y - (ry + rh - r - 1);

      const dist = Math.hypot(dx, dy);
      if (dist > r + 0.75) continue;

      const edgeAlpha = dist > r - 0.5 ? Math.max(0, Math.min(1, (r + 0.5 - dist))) : 1;
      if (fillColor) {
        const [fr, fg, fb, fa = 255] = fillColor;
        let mr = fr;
        let mg = fg;
        let mb = fb;
        if (fillColor.length >= 7) {
          const t = (y - ry) / Math.max(1, rh);
          mr = Math.round(fr + (fillColor[4] - fr) * t);
          mg = Math.round(fg + (fillColor[5] - fg) * t);
          mb = Math.round(fb + (fillColor[6] - fb) * t);
        }
        blendPixel(rgba, width, height, x, y, mr, mg, mb, Math.round(fa * edgeAlpha));
      }

      if (borderColor && borderWidth > 0) {
        const insideCorner = dx > 0 || dy > 0;
        const isBorder = insideCorner
          ? (dist >= r - borderWidth - 0.3 && dist <= r + 0.5)
          : (x < rx + borderWidth || x >= rx + rw - borderWidth || y < ry + borderWidth || y >= ry + rh - borderWidth);
        if (isBorder) {
          const [br, bg, bb, ba = 255] = borderColor;
          blendPixel(rgba, width, height, x, y, br, bg, bb, Math.round(ba * edgeAlpha));
        }
      }
    }
  }
}

function drawBitmapText(rgba, width, height, text, startX, startY, scale = 2, color = [240, 246, 252, 255], maxChars = 42) {
  const clean = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);

  let cx = startX;
  const [r, g, b, a = 255] = color;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i].toUpperCase();
    const rows = GLYPHS_5X7[ch] || GLYPHS_5X7[' '];
    for (let row = 0; row < 7; row++) {
      const bits = rows[row];
      for (let col = 0; col < 5; col++) {
        if ((bits >> (4 - col)) & 1) {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              blendPixel(rgba, width, height, cx + col * scale + sx, startY + row * scale + sy, r, g, b, a);
            }
          }
        }
      }
    }
    cx += 6 * scale;
    if (cx + 5 * scale >= width - 12) break;
  }
}

function parseHexColor(hex, fallback) {
  const m = String(hex || '').match(/#([0-9a-fA-F]{6})/);
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function rgbaToHex(rgba) {
  if (!Array.isArray(rgba) || rgba.length < 3) return '#3b82f6';
  const toH = (n) => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${toH(rgba[0])}${toH(rgba[1])}${toH(rgba[2])}`;
}

function inferVariantVisualTheme(variant = {}, idx = 0) {
  const safeVariant = variant && typeof variant === 'object' && !Array.isArray(variant) ? variant : {};
  const safeIdx = Number.isFinite(Number(idx)) ? Math.max(0, Math.floor(Number(idx))) : 0;
  // Diverse default worlds (Light Editorial Paper, Daylight Bento Studio, Deep Obsidian Amber)
  // used ONLY if the variant CSS/spec does not define its own colors.
  const presets = [
    {
      name: 'EDITORIAL LIGHT STUDIO',
      stageBgCss: '#f7f3eb',
      bgTop: [247, 243, 235],
      bgBot: [238, 231, 218],
      cardFill: [255, 253, 249, 255, 250, 246, 238],
      accent: [200, 90, 50, 255],
      secondary: [160, 68, 36, 235],
      border: [28, 25, 23, 220],
      textPrimary: [28, 25, 23, 255],
      textSub: [87, 83, 78, 255],
      radius: 6,
      layoutMode: 'editorial',
      motionLabel: 'EDITORIAL REVEAL  0.42S'
    },
    {
      name: 'ARCHITECTURAL BENTO',
      stageBgCss: '#eef2f6',
      bgTop: [238, 242, 246],
      bgBot: [226, 232, 240],
      cardFill: [255, 255, 255, 255, 248, 250, 252],
      accent: [37, 99, 235, 255],
      secondary: [29, 78, 216, 235],
      border: [203, 213, 225, 255],
      textPrimary: [15, 23, 42, 255],
      textSub: [100, 116, 139, 255],
      radius: 12,
      layoutMode: 'bento',
      motionLabel: 'CRISP SNAP-IN  0.36S'
    },
    {
      name: 'OBSIDIAN & AMBER',
      stageBgCss: '#12100e',
      bgTop: [22, 19, 17],
      bgBot: [14, 12, 10],
      cardFill: [28, 25, 23, 255, 20, 18, 16],
      accent: [245, 158, 11, 255],
      secondary: [217, 119, 6, 235],
      border: [245, 158, 11, 140],
      textPrimary: [250, 250, 249, 255],
      textSub: [168, 162, 158, 255],
      radius: 16,
      layoutMode: 'card',
      motionLabel: 'FLUID CASCADE  0.48S'
    }
  ];

  const base = { ...presets[safeIdx % presets.length] };
  const cssStr = String(safeVariant.css || '');
  const htmlStr = String(safeVariant.html || '');
  const cssAndHtml = `${cssStr} ${htmlStr}`;

  // 1. Detect explicit stageBg from variant.stageBg or body/html/:root/.stage background in CSS
  let detectedBgHex = safeVariant.stageBg ? String(safeVariant.stageBg).match(/#[0-9a-fA-F]{6}/)?.[0] : null;
  if (!detectedBgHex) {
    const bodyBgMatch = cssStr.match(/(?:body|html|:root|\.stage)\s*\{[^}]*?background(?:-color)?:\s*([^;\}]+)/i);
    if (bodyBgMatch) {
      const h = bodyBgMatch[1].match(/#[0-9a-fA-F]{6}/);
      if (h) detectedBgHex = h[0];
    }
  }
  if (!detectedBgHex) {
    const anyBgMatch = cssStr.match(/background(?:-color)?:\s*(#[0-9a-fA-F]{6})/i);
    if (anyBgMatch) detectedBgHex = anyBgMatch[1];
  }

  if (detectedBgHex) {
    const bgRgb = parseHexColor(detectedBgHex, null);
    if (bgRgb) {
      base.stageBgCss = detectedBgHex;
      base.bgTop = [bgRgb[0], bgRgb[1], bgRgb[2]];
      base.bgBot = [
        Math.max(0, bgRgb[0] - 12),
        Math.max(0, bgRgb[1] - 12),
        Math.max(0, bgRgb[2] - 12)
      ];
    }
  }

  const stageLum = 0.299 * base.bgTop[0] + 0.587 * base.bgTop[1] + 0.114 * base.bgTop[2];
  const isLightStage = stageLum > 150;
  base.isLightStage = isLightStage;

  if (isLightStage) {
    base.textPrimary = [20, 22, 26, 255];
    base.textSub = [90, 96, 108, 255];
    base.cardFill = [255, 255, 255, 255, 248, 249, 250];
    base.border = [200, 206, 216, 255];
  } else {
    base.textPrimary = [244, 246, 250, 255];
    base.textSub = [150, 158, 170, 255];
    const cR = Math.min(255, base.bgTop[0] + 14);
    const cG = Math.min(255, base.bgTop[1] + 15);
    const cB = Math.min(255, base.bgTop[2] + 18);
    base.cardFill = [cR, cG, cB, 255, Math.max(0, cR - 8), Math.max(0, cG - 8), Math.max(0, cB - 8)];
  }

  // 2. Detect explicit or best contrasting accent color
  let bestAccent = variant.accentColor ? parseHexColor(variant.accentColor, null) : null;
  if (!bestAccent) {
    const hexes = cssAndHtml.match(/#[0-9a-fA-F]{6}/g) || [];
    let bestScore = 0;
    for (const h of hexes) {
      if (detectedBgHex && h.toLowerCase() === detectedBgHex.toLowerCase()) continue;
      const rgbaColor = parseHexColor(h, null);
      if (!rgbaColor) continue;
      const lum = 0.299 * rgbaColor[0] + 0.587 * rgbaColor[1] + 0.114 * rgbaColor[2];
      const maxC = Math.max(rgbaColor[0], rgbaColor[1], rgbaColor[2]);
      const minC = Math.min(rgbaColor[0], rgbaColor[1], rgbaColor[2]);
      const sat = maxC - minC;
      const contrast = Math.abs(lum - stageLum);
      if (sat >= 40 && contrast >= 35) {
        const score = sat * 1.4 + contrast;
        if (score > bestScore) {
          bestScore = score;
          bestAccent = rgbaColor;
        }
      }
    }
  }
  if (bestAccent) {
    base.accent = bestAccent;
    base.secondary = [
      Math.max(0, bestAccent[0] - 25),
      Math.max(0, bestAccent[1] - 25),
      Math.max(0, bestAccent[2] - 25),
      240
    ];
    if (!isLightStage) {
      base.border = [bestAccent[0], bestAccent[1], bestAccent[2], 145];
    }
  }

  base.accentHex = rgbaToHex(base.accent);

  const radMatch = cssStr.match(/border-radius:\s*(\d+)px/i);
  if (radMatch) {
    base.radius = Math.max(0, Math.min(28, Number(radMatch[1])));
  }

  if (safeVariant.layout) {
    base.layoutMode = String(safeVariant.layout);
  } else if (/bento|grid-template-columns|tile/i.test(cssAndHtml)) {
    base.layoutMode = safeIdx % 2 === 0 ? 'editorial' : 'bento';
  }

  return base;
}

function renderVariantCardOnCanvas(rgba, canvasW, canvasH, offsetX, offsetY, cardW, cardH, variant, idx, lang = '') {
  const safeVariant = variant && typeof variant === 'object' && !Array.isArray(variant) ? variant : {};
  const isEnCard = normalizeLang(lang || safeVariant.lang || readActiveUiLanguage(), 'en') === 'en';
  const safeIdx = Number.isFinite(Number(idx)) ? Math.max(0, Math.floor(Number(idx))) : 0;
  const theme = inferVariantVisualTheme(safeVariant, safeIdx);
  const badge = String(safeVariant.id || String.fromCharCode(65 + safeIdx)).slice(0, 2);
  const title = String(safeVariant.label || `${isEnCard ? 'Variant' : 'Вариант'} ${badge}`);
  const subtitle = String(safeVariant.subtitle || theme.name);

  // Extract readable text snippets from variant.html
  const htmlTexts = String(safeVariant.html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .split(/<[^>]+>/)
    .map((s) => s.trim())
    .filter(Boolean);
  const innerTag = htmlTexts[0] || theme.name;
  const innerHeading = htmlTexts[1] || title;
  const innerDesc = htmlTexts[2] || subtitle;
  const innerMetric = htmlTexts[3] || `${isEnCard ? 'SELECT' : 'ВЫБРАТЬ'} ${badge}`;

  // 1. Outer frame background with vertical gradient matching variant's light/dark stageBg
  drawRoundedRect(
    rgba,
    canvasW,
    canvasH,
    offsetX,
    offsetY,
    cardW,
    cardH,
    14,
    [theme.bgTop[0], theme.bgTop[1], theme.bgTop[2], 255, theme.bgBot[0], theme.bgBot[1], theme.bgBot[2]],
    theme.isLightStage ? [203, 213, 225, 255] : [48, 54, 61, 255],
    2
  );

  // Subtle ambient glow behind centerpiece
  const cx = offsetX + cardW * 0.5;
  const cy = offsetY + cardH * 0.58;
  const glowR = Math.min(cardW, cardH) * 0.42;
  const maxGlowAlpha = theme.isLightStage ? 22 : 42;
  for (let y = Math.max(offsetY + 52, Math.floor(cy - glowR)); y < Math.min(offsetY + cardH - 8, Math.ceil(cy + glowR)); y++) {
    for (let x = Math.max(offsetX + 8, Math.floor(cx - glowR)); x < Math.min(offsetX + cardW - 8, Math.ceil(cx + glowR)); x++) {
      const d = Math.hypot(x - cx, y - cy) / glowR;
      if (d < 1) {
        const a = Math.round((1 - d) * (1 - d) * maxGlowAlpha);
        blendPixel(rgba, canvasW, canvasH, x, y, theme.accent[0], theme.accent[1], theme.accent[2], a);
      }
    }
  }

  // 2. Top Header Bar (kept dark showroom chrome for clear A/B/C label legibility)
  drawRoundedRect(rgba, canvasW, canvasH, offsetX + 2, offsetY + 2, cardW - 4, 54, 12, [22, 27, 34, 255], null, 0);
  drawRoundedRect(rgba, canvasW, canvasH, offsetX + 2, offsetY + 54, cardW - 4, 2, 0, [48, 54, 61, 255], null, 0);

  // Variant Badge Pill (A / B / C)
  drawRoundedRect(
    rgba,
    canvasW,
    canvasH,
    offsetX + 16,
    offsetY + 13,
    34,
    28,
    7,
    [theme.accent[0], theme.accent[1], theme.accent[2], 55],
    theme.accent,
    2
  );
  drawBitmapText(rgba, canvasW, canvasH, badge, offsetX + 28, offsetY + 20, 2, [255, 255, 255, 255], 2);

  // Variant Title & Subtitle
  drawBitmapText(rgba, canvasW, canvasH, title, offsetX + 60, offsetY + 13, 2, [240, 246, 252, 255], 38);
  drawBitmapText(rgba, canvasW, canvasH, subtitle, offsetX + 60, offsetY + 34, 1, [160, 170, 182, 255], 76);

  // 3. Stage Layout Mockup (Distinct geometry per layoutMode: 'editorial', 'bento', or 'card')
  const stageW = Math.min(cardW - 56, 480);
  const stageH = 198;
  const stageX = offsetX + Math.round((cardW - stageW) / 2);
  const stageY = offsetY + 84;

  if (theme.layoutMode === 'editorial') {
    // Editorial Asymmetric Split Layout (Sharp/hard-offset shadow + 2 columns)
    drawRoundedRect(rgba, canvasW, canvasH, stageX + 5, stageY + 5, stageW, stageH, theme.radius, [28, 25, 23, theme.isLightStage ? 180 : 140], null, 0);
    drawRoundedRect(rgba, canvasW, canvasH, stageX, stageY, stageW, stageH, theme.radius, theme.cardFill, theme.border, 2);

    const leftW = Math.round(stageW * 0.58);
    drawBitmapText(rgba, canvasW, canvasH, innerTag, stageX + 20, stageY + 22, 1, theme.accent, 26);
    drawBitmapText(rgba, canvasW, canvasH, innerHeading, stageX + 20, stageY + 44, 3, theme.textPrimary, 16);
    drawBitmapText(rgba, canvasW, canvasH, innerDesc, stageX + 20, stageY + 82, 1, theme.textSub, 34);

    // Editorial CTA button
    drawRoundedRect(rgba, canvasW, canvasH, stageX + 20, stageY + 136, 148, 36, Math.min(6, theme.radius), theme.accent, null, 0);
    drawBitmapText(rgba, canvasW, canvasH, `${isEnCard ? 'CONCEPT' : 'КОНЦЕПТ'} ${badge}`, stageX + 36, stageY + 148, 2, [255, 255, 255, 255], 12);

    // Right side metric/feature box
    const rightX = stageX + leftW + 10;
    const rightW = stageW - leftW - 28;
    drawRoundedRect(
      rgba,
      canvasW,
      canvasH,
      rightX,
      stageY + 20,
      rightW,
      stageH - 40,
      Math.max(4, theme.radius - 2),
      [theme.accent[0], theme.accent[1], theme.accent[2], 24],
      [theme.accent[0], theme.accent[1], theme.accent[2], 110],
      1
    );
    drawBitmapText(rgba, canvasW, canvasH, innerMetric, rightX + 14, stageY + 66, 2, theme.accent, 12);
    drawBitmapText(rgba, canvasW, canvasH, isEnCard ? 'PALETTE ACCENT' : 'АКЦЕНТ ПАЛИТРЫ', rightX + 14, stageY + 98, 1, theme.textSub, 18);
  } else if (theme.layoutMode === 'bento') {
    // Bento Multi-Tile Grid Layout (3 modular tiles)
    const gap = 10;
    const col1W = Math.round((stageW - gap) * 0.6);
    const col2W = stageW - gap - col1W;
    const rowH = Math.round((stageH - gap) / 2);

    // Main left bento tile
    drawRoundedRect(rgba, canvasW, canvasH, stageX, stageY, col1W, stageH, theme.radius, theme.cardFill, theme.border, 2);
    drawRoundedRect(rgba, canvasW, canvasH, stageX + 16, stageY + 18, 96, 20, 5, [theme.accent[0], theme.accent[1], theme.accent[2], 32], null, 0);
    drawBitmapText(rgba, canvasW, canvasH, innerTag, stageX + 24, stageY + 25, 1, theme.accent, 18);
    drawBitmapText(rgba, canvasW, canvasH, innerHeading, stageX + 16, stageY + 52, 2, theme.textPrimary, 18);
    drawBitmapText(rgba, canvasW, canvasH, innerDesc, stageX + 16, stageY + 80, 1, theme.textSub, 30);
    drawRoundedRect(rgba, canvasW, canvasH, stageX + 16, stageY + 140, 136, 34, 8, theme.accent, null, 0);
    drawBitmapText(rgba, canvasW, canvasH, `${isEnCard ? 'SELECT' : 'ВЫБРАТЬ'} ${badge}`, stageX + 32, stageY + 151, 2, [255, 255, 255, 255], 12);

    // Top-right accent tile
    const col2X = stageX + col1W + gap;
    drawRoundedRect(rgba, canvasW, canvasH, col2X, stageY, col2W, rowH, theme.radius, theme.accent, null, 0);
    drawBitmapText(rgba, canvasW, canvasH, badge, col2X + 16, stageY + 18, 3, [255, 255, 255, 255], 4);
    drawBitmapText(rgba, canvasW, canvasH, innerMetric, col2X + 16, stageY + 54, 1, [255, 255, 255, 230], 18);

    // Bottom-right secondary tile
    const row2Y = stageY + rowH + gap;
    drawRoundedRect(rgba, canvasW, canvasH, col2X, row2Y, col2W, rowH, theme.radius, theme.cardFill, theme.border, 2);
    drawBitmapText(rgba, canvasW, canvasH, `R:${theme.radius}PX`, col2X + 16, row2Y + 22, 2, theme.textPrimary, 12);
    drawBitmapText(rgba, canvasW, canvasH, theme.accentHex.toUpperCase(), col2X + 16, row2Y + 52, 1, theme.accent, 12);
  } else {
    // Focused Hero / Atmospheric Card Layout
    drawRoundedRect(rgba, canvasW, canvasH, stageX + 4, stageY + 8, stageW, stageH, theme.radius, [4, 7, 14, 140], null, 0);
    drawRoundedRect(rgba, canvasW, canvasH, stageX, stageY, stageW, stageH, theme.radius, theme.cardFill, theme.border, 2);

    drawRoundedRect(
      rgba,
      canvasW,
      canvasH,
      stageX + 24,
      stageY + 22,
      Math.min(stageW - 48, Math.max(110, innerTag.length * 8 + 20)),
      22,
      6,
      [theme.accent[0], theme.accent[1], theme.accent[2], 36],
      [theme.accent[0], theme.accent[1], theme.accent[2], 130],
      1
    );
    drawBitmapText(rgba, canvasW, canvasH, innerTag, stageX + 34, stageY + 29, 1, theme.accent, 34);
    drawBitmapText(rgba, canvasW, canvasH, innerHeading, stageX + 24, stageY + 58, 3, theme.textPrimary, 22);
    drawBitmapText(rgba, canvasW, canvasH, innerDesc, stageX + 24, stageY + 96, 1, theme.textSub, 46);

    const btnW = 168;
    const btnH = 38;
    const btnX = stageX + 24;
    const btnY = stageY + 138;
    drawRoundedRect(
      rgba,
      canvasW,
      canvasH,
      btnX,
      btnY,
      btnW,
      btnH,
      Math.min(12, Math.max(4, theme.radius)),
      [theme.accent[0], theme.accent[1], theme.accent[2], 240, theme.secondary[0], theme.secondary[1], theme.secondary[2]],
      [255, 255, 255, 90],
      1
    );
    drawBitmapText(rgba, canvasW, canvasH, `${isEnCard ? 'SELECT' : 'ВЫБРАТЬ'} ${badge}`, btnX + 24, btnY + 12, 2, [255, 255, 255, 255], 14);

    const chipW = 128;
    const chipX = stageX + stageW - chipW - 24;
    drawRoundedRect(rgba, canvasW, canvasH, chipX, btnY + 4, chipW, 30, 8, [theme.accent[0], theme.accent[1], theme.accent[2], 24], theme.border, 1);
    drawBitmapText(rgba, canvasW, canvasH, `${theme.accentHex.toUpperCase()}`, chipX + 20, btnY + 15, 1, theme.textPrimary, 16);
  }

  // 4. Bottom Footer Bar (Theme & Palette summary)
  drawRoundedRect(
    rgba,
    canvasW,
    canvasH,
    offsetX + 16,
    offsetY + cardH - 36,
    cardW - 32,
    24,
    6,
    [22, 27, 34, 220],
    [48, 54, 61, 180],
    1
  );
  drawBitmapText(
    rgba,
    canvasW,
    canvasH,
    `BG: ${String(theme.stageBgCss).toUpperCase()} | ACCENT: ${theme.accentHex.toUpperCase()} | ${theme.motionLabel}`,
    offsetX + 26,
    offsetY + cardH - 27,
    1,
    [210, 218, 228, 255],
    56
  );
}

export function renderVariantPreviewPngBuffer(variant = {}, idx = 0, width = 600, height = 340, lang = '') {
  const safeVariant = variant && typeof variant === 'object' && !Array.isArray(variant) ? variant : {};
  const safeIdx = Number.isFinite(Number(idx)) ? Math.max(0, Math.floor(Number(idx))) : 0;
  const safeW = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.min(2400, Math.max(64, Math.floor(Number(width)))) : 600;
  const safeH = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.min(2400, Math.max(64, Math.floor(Number(height)))) : 340;
  const rgba = Buffer.alloc(safeW * safeH * 4, 0);
  renderVariantCardOnCanvas(rgba, safeW, safeH, 0, 0, safeW, safeH, safeVariant, safeIdx, lang);
  return encodeRgbaToPngBuffer(safeW, safeH, rgba);
}

export function renderOverviewGridPngBuffer(variants = [], cardW = 560, cardH = 340, lang = '') {
  const safeList = Array.isArray(variants) ? variants : [];
  const list = safeList.slice(0, 3);
  const safeCardW = Number.isFinite(Number(cardW)) && Number(cardW) > 0 ? Math.min(1600, Math.max(64, Math.floor(Number(cardW)))) : 560;
  const safeCardH = Number.isFinite(Number(cardH)) && Number(cardH) > 0 ? Math.min(1600, Math.max(64, Math.floor(Number(cardH)))) : 340;
  const gap = 16;
  const pad = 16;
  const totalW = pad * 2 + Math.max(1, list.length) * safeCardW + Math.max(0, list.length - 1) * gap;
  const totalH = pad * 2 + safeCardH;
  const rgba = Buffer.alloc(totalW * totalH * 4, 0);

  // Fill neutral showroom canvas background
  drawRoundedRect(rgba, totalW, totalH, 0, 0, totalW, totalH, 0, [24, 24, 28, 255], null, 0);

  list.forEach((v, idx) => {
    const ox = pad + idx * (safeCardW + gap);
    renderVariantCardOnCanvas(rgba, totalW, totalH, ox, pad, safeCardW, safeCardH, v, idx, lang);
  });

  return encodeRgbaToPngBuffer(totalW, totalH, rgba);
}

export function findHeadlessBrowserExecutable() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function buildSnapshotStandaloneHtml(variant = {}, idx = 0, lang = '') {
  const isEnSnap = normalizeLang(lang || variant?.lang || readActiveUiLanguage(), 'en') === 'en';
  const theme = inferVariantVisualTheme(variant, idx);
  const badge = escapeHtml(variant.id || String.fromCharCode(65 + idx));
  const label = escapeHtml(variant.label || `${isEnSnap ? 'Variant' : 'Вариант'} ${badge}`);
  const sub = escapeHtml(variant.subtitle || '');
  const css = String(variant.css || '');
  const refImgSrc = resolveReferenceImageSrc(variant.referenceImage);
  const safeUrl = sanitizeExternalUrl(variant.sourceUrl);
  const notesText = normalizeNotesText(variant.notes);
  const fallbackStageHtml = refImgSrc
    ? `<img src="${escapeHtml(refImgSrc)}" alt="${label}" style="max-width:100%;max-height:100%;object-fit:contain;border-radius:8px;" />`
    : '<div class="demo-box">Variant Preview</div>';
  const html = String(variant.html || fallbackStageHtml);
  const stageBgCss = escapeHtml(theme.stageBgCss || '#12100e');
  const accentHex = escapeHtml(theme.accentHex || '#3b82f6');
  const stageTextColor = theme.isLightStage ? '#1c1917' : '#e6edf3';
  const refFooterHtml = (safeUrl || notesText)
    ? `<div style="padding:6px 14px;border-top:1px solid #2a2e39;background:#14161c;font-size:11px;color:#9499a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeUrl ? `<span style="color:${accentHex};font-weight:700;margin-right:8px;">${escapeHtml(formatSourceHostLabel(safeUrl))}</span>` : ''}${escapeHtml(notesText)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="${isEnSnap ? 'en' : 'ru'}">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after {
    box-sizing: border-box;
    animation-delay: -60s !important;
    animation-duration: 0.001s !important;
    transition-duration: 0.001s !important;
  }
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: #111216; color: #eceef2;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
  }
  .frame-shell {
    width: 100%; height: 100%; display: flex; flex-direction: column;
    border: 2px solid #2a2e39; border-radius: 12px; overflow: hidden; background: #181a20;
  }
  .head {
    padding: 12px 16px; border-bottom: 1px solid #2a2e39; background: #181a20;
    display: flex; align-items: center; gap: 10px;
  }
  .badge {
    background: ${accentHex}28; color: ${accentHex}; border: 1px solid ${accentHex};
    border-radius: 6px; padding: 2px 8px; font-size: 13px; font-weight: 800;
  }
  .title { font-size: 15px; font-weight: 700; color: #f4f5f8; }
  .sub { font-size: 12px; color: #9499a6; margin-top: 2px; }
  .stage {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 20px; background: ${stageBgCss}; color: ${stageTextColor};
    position: relative; overflow: hidden;
  }
  ${css}
</style>
</head>
<body>
  <div class="frame-shell">
    <div class="head">
      <span class="badge">${badge}</span>
      <div>
        <div class="title">${label}</div>
        ${sub ? `<div class="sub">${sub}</div>` : ''}
      </div>
    </div>
    <div class="stage">${html}</div>${refFooterHtml}
  </div>
</body>
</html>`;
}

/**
 * Generates visual PNG previews for each variant + an overview comparison PNG + Markdown carousel.
 * Uses headless Edge/Chrome when available and falls back to the built-in pure-Node PNG renderer.
 */
export function generateShowroomVisualPreviews(spec = {}, outputDir, options = {}) {
  const safeOpts = options && typeof options === 'object' ? options : {};
  const safeSpec = spec && typeof spec === 'object' ? spec : {};
  const prevLang = normalizeLang(safeOpts.lang || safeSpec.lang || readActiveUiLanguage(), 'en');
  const isEnPrev = prevLang === 'en';
  const res = generateShowroomHtml(safeSpec, { lang: prevLang });
  if (!res.ok) return { ok: false, screenshots: [], overviewScreenshot: '', carouselMarkdown: '' };

  fs.mkdirSync(outputDir, { recursive: true });
  const variants = res.variants || [];
  const screenshots = [];
  const browserExe = safeOpts.fastPng ? null : findHeadlessBrowserExecutable();
  let tmpProfileDir = null;

  if (browserExe) {
    try {
      tmpProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-showroom-shot-'));
    } catch {
      tmpProfileDir = null;
    }
  }

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const badge = String(v.id || String.fromCharCode(65 + i)).replace(/[^a-zA-Z0-9_-]/g, '') || String(i + 1);
    const pngPath = path.join(outputDir, `variant-${badge}.png`);
    let capturedByBrowser = false;

    if (browserExe && tmpProfileDir) {
      try {
        const snapHtmlPath = path.join(tmpProfileDir, `snap-${badge}.html`);
        fs.writeFileSync(snapHtmlPath, buildSnapshotStandaloneHtml(v, i, prevLang), 'utf8');
        const fileUrl = pathToFileURL(snapHtmlPath).href;
        execFileSync(
          browserExe,
          [
            '--headless',
            '--disable-gpu',
            '--hide-scrollbars',
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${path.join(tmpProfileDir, `prof-${i}`)}`,
            '--window-size=600,340',
            `--screenshot=${pngPath}`,
            fileUrl
          ],
          { timeout: 6000, stdio: 'ignore' }
        );
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500) {
          capturedByBrowser = true;
        }
      } catch {}
    }

    if (!capturedByBrowser) {
      const pngBuf = renderVariantPreviewPngBuffer(v, i, 600, 340);
      fs.writeFileSync(pngPath, pngBuf);
    }
    screenshots.push(pngPath);
  }

  const overviewPath = path.join(outputDir, 'showroom-overview.png');
  let overviewCapturedByBrowser = false;
  if (browserExe && tmpProfileDir) {
    try {
      const overviewSnapHtml = res.html
        .replace(/--anim-scale:\s*1;/g, '--anim-scale: 0.0001; } *, *::before, *::after { animation-delay: -60s !important; animation-duration: 0.001s !important; transition-duration: 0.001s !important;')
        .replace(
          '<style>',
          '<style>*, *::before, *::after { animation-delay: -60s !important; animation-duration: 0.001s !important; transition-duration: 0.001s !important; } .grid { grid-template-columns: repeat(3, 1fr) !important; }'
        );
      const overviewHtmlPath = path.join(tmpProfileDir, 'snap-overview.html');
      fs.writeFileSync(overviewHtmlPath, overviewSnapHtml, 'utf8');
      const fileUrl = pathToFileURL(overviewHtmlPath).href;
      execFileSync(
        browserExe,
        [
          '--headless',
          '--disable-gpu',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${path.join(tmpProfileDir, 'prof-overview')}`,
          '--window-size=1440,420',
          `--screenshot=${overviewPath}`,
          fileUrl
        ],
        { timeout: 7000, stdio: 'ignore' }
      );
      if (fs.existsSync(overviewPath) && fs.statSync(overviewPath).size > 1000) {
        overviewCapturedByBrowser = true;
      }
    } catch {}
  }
  if (!overviewCapturedByBrowser) {
    const overviewBuf = renderOverviewGridPngBuffer(variants, 560, 340, prevLang);
    fs.writeFileSync(overviewPath, overviewBuf);
  }

  if (tmpProfileDir) {
    try {
      fs.rmSync(tmpProfileDir, { recursive: true, force: true });
    } catch {}
  }

  const toArtifactImgPath = (p) => {
    const clean = String(p || '').replace(/\\/g, '/');
    return clean.startsWith('/') ? clean : `/${clean}`;
  };

  const slides = variants.map((v, i) => {
    const badge = String(v.id || String.fromCharCode(65 + i));
    const label = v.label || `${isEnPrev ? 'Variant' : 'Вариант'} ${badge}`;
    const sub = v.subtitle ? ` — ${v.subtitle}` : '';
    const normPath = toArtifactImgPath(screenshots[i]);
    const safeUrl = sanitizeExternalUrl(v.sourceUrl);
    const notesText = normalizeNotesText(v.notes);
    const lines = [`![${label}](${normPath})`, `**${label}**${sub}`];
    if (notesText) lines.push(`- **${isEnPrev ? 'Technique breakdown' : 'Разбор приёмов'}:** ${notesText}`);
    if (safeUrl) lines.push(`- 🔗 ${isEnPrev ? 'Source' : 'Источник'}: [${formatSourceHostLabel(safeUrl)}](${safeUrl})`);
    return lines.join('\n');
  });

  const normOverview = toArtifactImgPath(overviewPath);
  const carouselMarkdown = [
    `![${isEnPrev ? 'Compare variants A / B / C' : 'Сравнение вариантов A / B / C'}](${normOverview})`,
    '',
    '````carousel',
    slides.join('\n<!-- slide -->\n'),
    '````'
  ].join('\n');

  return {
    ok: true,
    screenshots,
    overviewScreenshot: overviewPath,
    carouselMarkdown
  };
}

export function openFileInDefaultBrowser(filePath) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '""', filePath], { detached: false, windowsHide: true, stdio: 'ignore' });
      child.unref();
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [filePath], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      const child = spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

// CLI Runner
const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = path.resolve(fileURLToPath(import.meta.url));
  const arg = path.resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const rawArgs = process.argv.slice(2);
  let spec = {};
  let outPath = path.resolve(process.cwd(), '.cache', 'preview-showroom.html');
  let artifactDir = '';
  let shouldOpen = false;
  let fastPng = false;
  let cliLang = '';
  const positional = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node build-showroom.mjs [spec.json] [out.html] [--artifact-dir <dir>] [--lang en|ru] [--open] [--fast-png] [--demo]'
      );
      process.exit(0);
    } else if (arg === '--open') {
      shouldOpen = true;
    } else if (arg === '--fast-png') {
      fastPng = true;
    } else if (arg === '--lang' && rawArgs[i + 1]) {
      cliLang = rawArgs[++i];
    } else if (arg.startsWith('--lang=')) {
      cliLang = arg.slice('--lang='.length);
    } else if (arg === '--artifact-dir' && rawArgs[i + 1]) {
      artifactDir = path.resolve(rawArgs[++i]);
    } else if (arg.startsWith('--artifact-dir=')) {
      artifactDir = path.resolve(arg.slice('--artifact-dir='.length));
    } else if (arg !== '--demo' && !arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (positional[0] && fs.existsSync(positional[0])) {
    try {
      spec = JSON.parse(fs.readFileSync(positional[0], 'utf8'));
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: `Invalid JSON spec: ${e.message}` }));
      process.exit(1);
    }
    if (positional[1]) outPath = path.resolve(positional[1]);
  } else if (positional[0]) {
    outPath = path.resolve(positional[0]);
  }

  if (artifactDir) {
    outPath = path.join(artifactDir, path.basename(outPath));
  }

  const resolvedCliLang = normalizeLang(cliLang || spec.lang || readActiveUiLanguage(), 'en');
  const outDir = artifactDir || path.dirname(outPath);
  const res = generateShowroomHtml(spec, { lang: resolvedCliLang });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, res.html, 'utf8');

  const previews = generateShowroomVisualPreviews(spec, outDir, { fastPng, lang: resolvedCliLang });
  const opened = shouldOpen ? openFileInDefaultBrowser(outPath) : false;

  console.log(
    JSON.stringify({
      ok: true,
      outPath,
      variantCount: res.variantCount,
      screenshots: previews.screenshots,
      overviewScreenshot: previews.overviewScreenshot,
      carouselMarkdown: previews.carouselMarkdown,
      opened
    })
  );
}
