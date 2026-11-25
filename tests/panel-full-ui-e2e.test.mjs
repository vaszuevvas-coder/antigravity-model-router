import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  COLLAPSIBLE_PANEL_CARD_IDS,
  DEFAULT_PANEL_BLOCK_ORDER,
  DEFAULT_STATE,
  PANEL_SPOILER_IDS,
  collectTelemetry,
  loadState,
  startSidecarPanel,
} from '../sidecars/panel/server.mjs';
import { normalizeModelProfile, resolveEffectivePreTaskGatePolicy, evaluateSelectorMatchForTask } from '../core/model-profile.mjs';
import { classifyTaskAndPruneTools } from '../core/tool-pruner.mjs';
import { evaluateSwarmRoutingDirective } from '../core/swarm-controller.mjs';
import { createShadowCheckpoint } from '../core/shadow-guard.mjs';
import { createShadowWorktree } from '../core/shadow-worktree.mjs';
import { recordErrorFingerprint, getCircuitState } from '../core/circuit-breaker.mjs';
import { recordPitfall, listPitfalls } from '../core/pitfall-ledger.mjs';
import { recordModelOutcome, recordFileFragility, getBayesianSummary } from '../core/bayesian-router.mjs';
import { checkCommandSecurity, checkFileSecurity } from '../core/security-guard.mjs';
import { handlePreToolUse } from '../core/hook-runner.mjs';
import { loadCpuConfig, resolveCpuThreadBudget, shutdownCpuPool } from '../core/cpu-worker-pool.mjs';
import { destroyOllamaKeepAliveAgents, loadGpuConfig } from '../core/gpu/gpu-shared-state.mjs';
import { BackgroundSentinel } from '../core/background-sentinel.mjs';
import { knowledgeHub } from '../core/sqlite-knowledge-hub.mjs';

process.env.TUNNEL_TEST_ISOLATE_INSTALLED = '1';
delete process.env.ANTIGRAVITY_LS_ADDRESS;
delete process.env.ANTIGRAVITY_CSRF_TOKEN;
delete process.env.ANTIGRAVITY_AGENTAPI_EXE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const UI_HTML_PATH = path.join(REPO_ROOT, 'sidecars', 'panel', 'ui.html');
const LIVE_INSTALLED_STATE = path.join(
  os.homedir(),
  '.gemini',
  'config',
  'plugins',
  'antigravity-model-router',
  'router-state.json'
);
const LIVE_INSTALLED_MCP = path.join(
  os.homedir(),
  '.gemini',
  'config',
  'plugins',
  'antigravity-model-router',
  'mcp_config.json'
);

function sha256FileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeFileSnapshots(paths) {
  const snaps = new Map();
  for (const p of paths) {
    snaps.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null);
  }
  return snaps;
}

function restoreFileSnapshots(snaps) {
  for (const [p, buf] of snaps.entries()) {
    try {
      if (buf === null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } else {
        if (fs.existsSync(p) && fs.readFileSync(p).equals(buf)) continue;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, buf);
      }
    } catch {}
  }
}

async function waitFor(predicateFn, timeoutMs = 4000, stepMs = 15, label = '') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await predicateFn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  const msg = typeof label === 'function' ? label() : label;
  throw new Error(`waitFor timeout after ${timeoutMs}ms${msg ? ` (${msg})` : ''}`);
}

// ---------------------------------------------------------------------------
// Minimal HTML-to-DOM + Selector Engine for running real compiled ui.html
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'circle', 'path', 'rect', 'line', 'svg']);

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseTagAttrs(attrStr = '') {
  const attrs = Object.create(null);
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1];
    const rawVal = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    attrs[key] = decodeHtmlEntities(rawVal);
  }
  return attrs;
}

class MockClassList {
  constructor(el) {
    this._el = el;
  }
  _tokens() {
    const raw = String(this._el._attrs.class || '').trim();
    return raw ? raw.split(/\s+/).filter(Boolean) : [];
  }
  _save(tokens) {
    this._el._attrs.class = tokens.join(' ');
  }
  contains(cls) {
    return this._tokens().includes(cls);
  }
  add(...list) {
    const set = new Set(this._tokens());
    for (const c of list) if (c) set.add(c);
    this._save(Array.from(set));
  }
  remove(...list) {
    const rm = new Set(list);
    this._save(this._tokens().filter((t) => !rm.has(t)));
  }
  toggle(cls, force) {
    const has = this.contains(cls);
    const shouldAdd = force === undefined ? !has : Boolean(force);
    if (shouldAdd) this.add(cls);
    else this.remove(cls);
    return shouldAdd;
  }
}

class MockStyle {
  constructor() {
    this._props = Object.create(null);
  }
  setProperty(k, v) {
    this._props[k] = String(v);
  }
  getPropertyValue(k) {
    return this._props[k] || '';
  }
}

function createDatasetProxy(el) {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      const kebab = prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      return el._attrs['data-' + kebab];
    },
    set(_target, prop, value) {
      if (typeof prop !== 'string') return false;
      const kebab = prop.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
      el._attrs['data-' + kebab] = String(value);
      return true;
    },
  });
}

function matchesSimpleSelector(el, sel) {
  if (!el || !el.tagName) return false;
  let s = sel.trim();
  if (!s) return false;

  const notMatches = [];
  s = s.replace(/:not\(([^)]+)\)/g, (_m, inner) => {
    notMatches.push(inner.trim());
    return '';
  });

  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
  if (tagMatch) {
    if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
    s = s.slice(tagMatch[0].length);
  }

  for (const idM of s.matchAll(/#([a-zA-Z0-9_-]+)/g)) {
    if (el.id !== idM[1]) return false;
  }
  for (const clsM of s.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!el.classList.contains(clsM[1])) return false;
  }
  for (const attrM of s.matchAll(/\[([a-zA-Z0-9_:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)) {
    const aName = attrM[1];
    const hasVal = attrM[2] !== undefined || attrM[3] !== undefined || attrM[4] !== undefined;
    const expected = attrM[2] ?? attrM[3] ?? attrM[4] ?? '';
    const actual = el.getAttribute(aName);
    if (actual === null) return false;
    if (hasVal && actual !== expected) return false;
  }
  for (const neg of notMatches) {
    if (matchesSimpleSelector(el, neg)) return false;
  }
  return true;
}

function matchesSelectorChain(el, selector) {
  const parts = selector.split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const directChildChunks = part.split(/\s*>\s*/);
    if (directChildChunks.length > 1) {
      let cur = el;
      let ok = true;
      for (let i = directChildChunks.length - 1; i >= 0; i--) {
        const subTokens = directChildChunks[i].trim().split(/\s+/);
        if (!cur || !matchesSimpleSelector(cur, subTokens[subTokens.length - 1])) {
          ok = false;
          break;
        }
        if (i > 0) cur = cur.parentElement;
      }
      if (ok) return true;
      continue;
    }

    const tokens = part.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (!matchesSimpleSelector(el, tokens[tokens.length - 1])) continue;
    if (tokens.length === 1) return true;
    let cur = el.parentElement;
    let idx = tokens.length - 2;
    while (cur && idx >= 0) {
      if (matchesSimpleSelector(cur, tokens[idx])) idx--;
      cur = cur.parentElement;
    }
    if (idx < 0) return true;
  }
  return false;
}

class MockElement {
  constructor(tagName, doc, attrs = {}) {
    this.tagName = String(tagName || 'div').toUpperCase();
    this._doc = doc;
    this._attrs = Object.create(null);
    for (const [k, v] of Object.entries(attrs)) {
      this._attrs[k] = v;
    }
    this.children = [];
    this.parentNode = null;
    this.classList = new MockClassList(this);
    this.style = new MockStyle();
    this.dataset = createDatasetProxy(this);
    this._listeners = new Map();
    this._textContent = '';
    this.checked = Object.hasOwn(attrs, 'checked');
    this.disabled = Object.hasOwn(attrs, 'disabled');
    this.hidden = Object.hasOwn(attrs, 'hidden');
    this.open = Object.hasOwn(attrs, 'open');
    this._value = attrs.value !== undefined ? String(attrs.value) : '';
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollTop = 0;
    this.scrollHeight = 56;
    this.clientWidth = 320;
    this.tabIndex = 0;
  }

  get id() {
    return this._attrs.id || '';
  }
  set id(v) {
    this._attrs.id = String(v || '');
  }
  get type() {
    return this._attrs.type || (this.tagName === 'BUTTON' ? 'submit' : '');
  }
  set type(v) {
    this._attrs.type = String(v || '');
  }
  get className() {
    return this._attrs.class || '';
  }
  set className(v) {
    this._attrs.class = String(v || '');
  }
  get title() {
    return this._attrs.title || '';
  }
  set title(v) {
    this._attrs.title = String(v || '');
  }
  get parentElement() {
    return this.parentNode && this.parentNode.tagName ? this.parentNode : null;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 && idx + 1 < this.parentNode.children.length ? this.parentNode.children[idx + 1] : null;
  }
  get options() {
    return this.children.filter((c) => c.tagName === 'OPTION');
  }
  get selectedIndex() {
    const opts = this.options;
    const idx = opts.findIndex((o) => o.value === this._value);
    return idx >= 0 ? idx : (opts.length > 0 ? 0 : -1);
  }
  get value() {
    if (this.tagName === 'SELECT') {
      const opts = this.options;
      if (this._value && opts.some((o) => o.value === this._value)) return this._value;
      return opts[0] ? opts[0].value : this._value;
    }
    if (this.tagName === 'OPTION') {
      return this._attrs.value !== undefined ? this._attrs.value : this.textContent;
    }
    return this._value;
  }
  set value(v) {
    const str = String(v ?? '');
    this._value = str;
    if (this.tagName === 'OPTION') this._attrs.value = str;
    if (this.tagName === 'TEXTAREA' || this.tagName === 'INPUT') {
      this.selectionStart = str.length;
      this.selectionEnd = str.length;
    }
  }
  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return (this._textContent || '') + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.children = [];
    this._textContent = String(v ?? '');
  }
  get innerHTML() {
    return this._innerHTML || this.textContent;
  }
  set innerHTML(html) {
    this._innerHTML = String(html || '');
    this.children = [];
    this._textContent = '';
    if (!html) return;
    parseHtmlIntoParent(html, this, this._doc);
  }

  getAttribute(k) {
    if (k === 'class') return this._attrs.class ?? null;
    if (k === 'open') return this.open ? '' : null;
    if (k === 'hidden') return this.hidden ? '' : null;
    if (k === 'disabled') return this.disabled ? '' : null;
    return Object.hasOwn(this._attrs, k) ? String(this._attrs[k]) : null;
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k === 'open') this.open = true;
    if (k === 'hidden') this.hidden = true;
    if (k === 'disabled') this.disabled = true;
    if (k === 'value') this._value = String(v);
  }
  hasAttribute(k) {
    return Object.hasOwn(this._attrs, k);
  }
  removeAttribute(k) {
    delete this._attrs[k];
    if (k === 'open') this.open = false;
    if (k === 'hidden') this.hidden = false;
    if (k === 'disabled') this.disabled = false;
  }

  appendChild(child) {
    if (!child) return child;
    if (child.parentNode && child.parentNode !== this) {
      child.parentNode.removeChild(child);
    } else if (child.parentNode === this) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.children.indexOf(refNode);
    newNode.parentNode = this;
    if (idx === -1) this.children.push(newNode);
    else this.children.splice(idx, 0, newNode);
    return newNode;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(node) {
    if (node === this) return true;
    for (const c of this.children) {
      if (c.contains(node)) return true;
    }
    return false;
  }
  closest(sel) {
    let cur = this;
    while (cur && cur.tagName) {
      if (matchesSelectorChain(cur, sel)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const visit = (node) => {
      for (const c of node.children) {
        if (matchesSelectorChain(c, sel)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  addEventListener(ev, fn) {
    if (!this._listeners.has(ev)) this._listeners.set(ev, []);
    this._listeners.get(ev).push(fn);
  }
  removeEventListener(ev, fn) {
    const list = this._listeners.get(ev);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }
  dispatchEvent(ev) {
    const eventObj = ev && typeof ev === 'object' ? ev : { type: String(ev) };
    if (!eventObj.target) eventObj.target = this;
    if (!eventObj.currentTarget) eventObj.currentTarget = this;
    if (typeof eventObj.preventDefault !== 'function') {
      eventObj.preventDefault = () => {
        eventObj.defaultPrevented = true;
      };
    }
    if (typeof eventObj.stopPropagation !== 'function') {
      eventObj.stopPropagation = () => {
        eventObj._stopped = true;
      };
    }
    let cur = this;
    while (cur) {
      eventObj.currentTarget = cur;
      const list = cur._listeners ? cur._listeners.get(eventObj.type) : null;
      if (list) {
        for (const fn of list.slice()) {
          fn.call(cur, eventObj);
        }
      }
      if (eventObj._stopped || eventObj.bubbles === false) break;
      cur = cur.parentNode;
    }
    return !eventObj.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent({ type: 'change', bubbles: true });
      return;
    }
    this.dispatchEvent({ type: 'click', bubbles: true });
  }
  focus() {
    this._doc.activeElement = this;
  }
  select() {}
  setSelectionRange(a, b) {
    this.selectionStart = Number(a || 0);
    this.selectionEnd = Number(b || 0);
  }
  scrollIntoView() {}
  getBoundingClientRect() {
    return { top: 20, bottom: 50, left: 10, right: 200, width: 190, height: 30 };
  }
}

function parseHtmlIntoParent(html, rootParent, doc) {
  const clean = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '');
  const stack = [rootParent];
  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(clean)) !== null) {
    const parent = stack[stack.length - 1];
    if (m[3] !== undefined) {
      const txt = decodeHtmlEntities(m[3]);
      if (txt.trim()) {
        parent._textContent += txt;
      }
      continue;
    }
    const rawTag = m[0];
    const tag = m[1].toLowerCase();
    const isClose = rawTag.startsWith('</');
    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const selfClose = rawTag.endsWith('/>') || VOID_TAGS.has(tag);
    const el = new MockElement(tag, doc, parseTagAttrs(m[2] || ''));
    parent.appendChild(el);
    if (!selfClose) {
      stack.push(el);
    }
  }
}

function createPanelDomHarness(uiHtml, originUrl, sidecarToken, extraOpts = {}) {
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(uiHtml);
  const bodyHtml = bodyMatch ? bodyMatch[1] : uiHtml;
  const scriptMatches = [...uiHtml.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  const inlineJs = scriptMatches.map((m) => m[1]).join('\n');

  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    _listeners: new Map(),
    body: null,
    documentElement: null,
    createElement(tag) {
      return new MockElement(tag, doc);
    },
    getElementById(id) {
      const find = (node) => {
        if (node.id === id) return node;
        for (const c of node.children) {
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      };
      return find(doc.body);
    },
    querySelectorAll(sel) {
      return doc.body.querySelectorAll(sel);
    },
    querySelector(sel) {
      return doc.body.querySelector(sel);
    },
    addEventListener(ev, fn) {
      if (!doc._listeners.has(ev)) doc._listeners.set(ev, []);
      doc._listeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const list = doc._listeners.get(ev);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(ev) {
      const list = doc._listeners.get(ev.type);
      if (list) {
        for (const fn of list.slice()) fn.call(doc, ev);
      }
    },
    execCommand() {
      return true;
    },
  };
  doc.body = new MockElement('body', doc);
  doc.documentElement = new MockElement('html', doc);
  doc.documentElement.appendChild(doc.body);
  doc.body.parentNode = {
    _listeners: doc._listeners,
    children: [doc.documentElement],
  };
  doc.documentElement.parentNode = doc.body.parentNode;

  parseHtmlIntoParent(bodyHtml, doc.body, doc);

  const storageMap = new Map();
  const localStorageMock = {
    getItem(k) {
      return storageMap.has(k) ? storageMap.get(k) : null;
    },
    setItem(k, v) {
      storageMap.set(String(k), String(v));
    },
    removeItem(k) {
      storageMap.delete(String(k));
    },
  };

  const activeTimers = new Set();
  const trackedSetTimeout = (fn, ms, ...args) => {
    const id = setTimeout(() => {
      activeTimers.delete(id);
      fn(...args);
    }, ms);
    if (typeof id.unref === 'function') id.unref();
    activeTimers.add(id);
    return id;
  };
  const trackedClearTimeout = (id) => {
    activeTimers.delete(id);
    clearTimeout(id);
  };
  const activeIntervals = new Set();
  const trackedSetInterval = (fn, ms, ...args) => {
    const id = setInterval(fn, ms, ...args);
    if (typeof id.unref === 'function') id.unref();
    activeIntervals.add(id);
    return id;
  };
  const trackedClearInterval = (id) => {
    activeIntervals.delete(id);
    clearInterval(id);
  };

  const sentAgentMessages = [];
  const sidecarObj = {
    token: sidecarToken,
    conversationId: extraOpts.conversationId || 'e2e_sidecar_conv_001',
    agent: {
      sendMessage: async (msg, cid) => {
        sentAgentMessages.push({ type: 'sendMessage', msg, cid });
        return { ok: true, conversationId: cid };
      },
      startConversation: async (msg) => {
        sentAgentMessages.push({ type: 'startConversation', msg });
        return { conversationId: 'e2e_new_conv_002' };
      },
    },
    ui: {
      toggleConversation() {},
    },
    getWorkspaceUris: async () => (extraOpts.workspaceUris || []),
  };

  let pendingFetches = 0;
  const wrappedFetch = async (url, options = {}) => {
    const fullUrl = String(url || '').startsWith('/') ? `${originUrl}${url}` : String(url || '');
    const headers = Object.assign({ Origin: originUrl }, options.headers || {});
    pendingFetches += 1;
    try {
      return await globalThis.fetch(fullUrl, { ...options, headers });
    } finally {
      pendingFetches = Math.max(0, pendingFetches - 1);
    }
  };

  const winListeners = new Map();
  const windowObj = {
    innerWidth: 420,
    innerHeight: 860,
    location: { search: `?token=${encodeURIComponent(sidecarToken)}`, reload() {} },
    fetch: wrappedFetch,
    sidecar: sidecarObj,
    localStorage: localStorageMock,
    navigator: { clipboard: { writeText: async () => {} } },
    addEventListener(ev, fn) {
      if (!winListeners.has(ev)) winListeners.set(ev, []);
      winListeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = winListeners.get(ev);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    dispatchEvent(ev) {
      const eventObj = ev && typeof ev === 'object' ? ev : { type: String(ev) };
      if (typeof eventObj.preventDefault !== 'function') eventObj.preventDefault = () => {};
      if (typeof eventObj.stopPropagation !== 'function') eventObj.stopPropagation = () => {};
      const arr = winListeners.get(eventObj.type) || [];
      for (const fn of arr.slice()) fn.call(windowObj, eventObj);
      return true;
    },
    requestAnimationFrame(fn) {
      return trackedSetTimeout(() => fn(performance.now()), 0);
    },
    cancelAnimationFrame(id) {
      trackedClearTimeout(id);
    },
    IntersectionObserver: class {
      constructor(cb) {
        this._cb = cb;
      }
      observe(el) {
        if (this._cb && el) {
          this._cb([{ target: el, isIntersecting: true }]);
        }
      }
      disconnect() {}
    },
    SpeechRecognition: extraOpts.SpeechRecognition || undefined,
  };

  const ctx = vm.createContext({
    window: windowObj,
    document: doc,
    localStorage: localStorageMock,
    navigator: windowObj.navigator,
    location: windowObj.location,
    CSS: { escape: (s) => String(s) },
    URL,
    URLSearchParams,
    IntersectionObserver: windowObj.IntersectionObserver,
    Event: class {
      constructor(type, opts = {}) {
        this.type = type;
        this.bubbles = Boolean(opts.bubbles);
      }
    },
    CustomEvent: class {
      constructor(type, opts = {}) {
        this.type = type;
        this.bubbles = Boolean(opts.bubbles);
        this.detail = opts.detail;
      }
    },
    AbortController,
    performance,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    requestAnimationFrame: windowObj.requestAnimationFrame,
    cancelAnimationFrame: windowObj.cancelAnimationFrame,
    fetch: wrappedFetch,
    console,
    Promise,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    Date,
    JSON,
    RegExp,
    Error,
    encodeURIComponent,
    decodeURIComponent,
  });

  vm.runInContext(inlineJs, ctx, { filename: 'sidecars/panel/ui.html' });

  return {
    ctx,
    doc,
    windowObj,
    sentAgentMessages,
    async waitIdle(timeoutMs = 5000) {
      await waitFor(() => pendingFetches === 0, timeoutMs, 10, 'dom.waitIdle');
      await new Promise((r) => setTimeout(r, 5));
    },
    destroy() {
      doc.visibilityState = 'hidden';
      for (const t of Array.from(activeTimers)) {
        clearTimeout(t);
        activeTimers.delete(t);
      }
      for (const iv of Array.from(activeIntervals)) {
        clearInterval(iv);
        activeIntervals.delete(iv);
      }
    },
  };
}

function createTestSidecarAppClass() {
  return class TestSidecarApp {
    constructor() {
      this._pages = new Map();
      this._apis = new Map();
      this._server = null;
    }

    page(p, handler) {
      this._pages.set(p, handler);
    }
    api(p, handler, method = 'POST') {
      if (!this._apis.has(p)) this._apis.set(p, new Map());
      this._apis.get(p).set(method.toUpperCase(), handler);
    }
    run() {
      const server = http.createServer(async (req, res) => {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.method === 'GET' && this._pages.has(u.pathname)) {
          const r = await this._pages.get(u.pathname)();
          res.writeHead(r?.status || 200, { 'Content-Type': r?.contentType || 'text/html; charset=utf-8' });
          res.end(r?.body ?? String(r || ''));
          return;
        }
        if (this._apis.has(u.pathname)) {
          const methodMap = this._apis.get(u.pathname);
          const handler = methodMap.get(req.method);
          if (!handler) {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
            return;
          }
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', async () => {
            try {
              const data = {};
              for (const [k, v] of u.searchParams.entries()) {
                if (k.toLowerCase() !== 'token') data[k] = v;
              }
              if (body) Object.assign(data, JSON.parse(body));
              const result = await handler(data, req);
              if (result && typeof result === 'object' && result.contentType && result.body !== undefined) {
                res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...(result.headers || {}) });
                res.end(result.body);
                return;
              }
              const httpCode = typeof result?.status === 'number' ? result.status : 200;
              res.writeHead(httpCode, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err?.message || 'err' }));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });
      this._server = server;
      return new Promise((resolveListen) => {
        server.listen(0, '127.0.0.1', () => resolveListen(server));
      });
    }
    get port() {
      return this._server?.address()?.port || 0;
    }
    close() {
      if (!this._server) return Promise.resolve();
      const srv = this._server;
      this._server = null;
      try { srv.closeIdleConnections?.(); } catch {}
      try { srv.closeAllConnections?.(); } catch {}
      return new Promise((resolveClose) => srv.close(() => resolveClose()));
    }
  };
}

// ---------------------------------------------------------------------------
// Test Suite Setup & Global Snapshot Preservation
// ---------------------------------------------------------------------------

const SNAPSHOT_PATHS = [
  path.join(REPO_ROOT, 'router-state.json'),
  path.join(REPO_ROOT, 'mcp_config.json'),
  LIVE_INSTALLED_MCP,
  path.join(REPO_ROOT, '.cache', 'router-profile-backup.json'),
  path.join(os.homedir(), '.gemini', 'router-profile-backup.json'),
  path.join(REPO_ROOT, '.cache', 'shadow-checkpoints', 'index.json'),
  path.join(REPO_ROOT, '.cache', 'shadow-worktrees.json'),
  path.join(REPO_ROOT, '.cache', 'pitfalls-ledger.json'),
  path.join(REPO_ROOT, '.cache', 'domain-priors.json'),
  path.join(REPO_ROOT, '.cache', 'circuit-breaker.json'),
  path.join(REPO_ROOT, '.cache', 'wiretap-faults.json'),
  path.join(REPO_ROOT, '.cache', 'gpu-pull-status.json'),
  path.join(REPO_ROOT, '.cache', 'ollama-install-status.json'),
  path.join(REPO_ROOT, '.cache', 'plugin-update-check.json'),
  path.join(REPO_ROOT, '.cache', 'plugin-update-status.json'),
  path.join(REPO_ROOT, '.cache', 'task-progress.json'),
];

let globalSnapshots = null;
let liveStateHashBefore = null;
let liveGpuChatModelBefore = undefined;
let tempDirs = [];
let cpBakBefore = new Set();

test.before(() => {
  liveStateHashBefore = sha256FileIfExists(LIVE_INSTALLED_STATE);
  if (fs.existsSync(LIVE_INSTALLED_STATE)) {
    try {
      liveGpuChatModelBefore = JSON.parse(fs.readFileSync(LIVE_INSTALLED_STATE, 'utf8')).gpuChatModel;
    } catch {}
  }
  globalSnapshots = makeFileSnapshots(SNAPSHOT_PATHS);
  const e2eStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-e2e-state-'));
  const e2eStatePath = path.join(e2eStateDir, 'router-state.json');
  const repoStatePath = path.join(REPO_ROOT, 'router-state.json');
  if (fs.existsSync(repoStatePath)) {
    fs.copyFileSync(repoStatePath, e2eStatePath);
  }
  process.env.TUNNEL_TEST_STATE_PATH = e2eStatePath;
  tempDirs.push(e2eStateDir);
  const cpDir = path.join(REPO_ROOT, '.cache', 'shadow-checkpoints');
  if (fs.existsSync(cpDir)) {
    cpBakBefore = new Set(fs.readdirSync(cpDir));
  }
});

test.after(() => {
  delete process.env.TUNNEL_TEST_STATE_PATH;
  try { shutdownCpuPool(); } catch {}
  try { destroyOllamaKeepAliveAgents(); } catch {}
  // Clean up any shadow-checkpoint .bak files created during test
  const cpDir = path.join(REPO_ROOT, '.cache', 'shadow-checkpoints');
  if (fs.existsSync(cpDir)) {
    for (const f of fs.readdirSync(cpDir)) {
      if (!cpBakBefore.has(f) && f !== 'index.json') {
        try { fs.unlinkSync(path.join(cpDir, f)); } catch {}
      }
    }
  }
  restoreFileSnapshots(globalSnapshots);
  for (const d of tempDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  if (fs.existsSync(LIVE_INSTALLED_STATE)) {
    const liveAfter = JSON.parse(fs.readFileSync(LIVE_INSTALLED_STATE, 'utf8'));
    assert.equal(liveAfter.gpuChatModel, liveGpuChatModelBefore, 'Tests must NOT overwrite user live installed gpuChatModel');
  }
});

function makeTempGitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'app.mjs'), 'export function hello(name) {\n  return `hi ${name}`;\n}\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

// ---------------------------------------------------------------------------
// E2E Test 1: Full Panel UI DOM + HTTP + All Sections, Buttons, Limits & Modes
// ---------------------------------------------------------------------------

test('1. Full Panel E2E: UI DOM click-through for themes, wizard, workspace, composer, skills, agent modes, design gate, swarm & limits', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-ui-');
  const peerRepo = makeTempGitRepo('amr-e2e-peer-');
  const peerRel = path.relative(tmpRepo, peerRepo);

  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp });
  assert.ok(app && app.port > 0);
  const originUrl = `http://127.0.0.1:${app.port}`;

  // Fetch live compiled HTML directly over HTTP from SidecarApp
  const pageRes = await globalThis.fetch(`${originUrl}/`);
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.ok(html.includes('The Tunnel'));

  const dom = createPanelDomHarness(html, originUrl, 'e2e-token', {
    workspaceUris: [tmpRepo],
  });

  try {
    // Wait for initial init() -> refreshAll() -> renderPayload()
    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));

    // Helper to click a button by selector & wait for state predicate
    const clickAndWaitState = async (selector, checkFn, label) => {
      const el = dom.doc.querySelector(selector);
      assert.ok(el, `Element not found: ${selector} (${label})`);
      el.click();
      await waitFor(() => checkFn(loadState()), 3500, 15, label);
      await dom.waitIdle();
    };

    // 1. Switch panel to isolated tmpRepo via workspace selector
    await vm.runInContext(`selectPanelWorkspace(${JSON.stringify(tmpRepo)})`, dom.ctx);
    await dom.waitIdle();
    await waitFor(() => dom.doc.getElementById('agProgressProjectBadge').textContent.includes(path.basename(tmpRepo)), 3500, 15, 'workspace badge');

    // 2. Header Themes, Collapsible Cards (all 11), Spoilers (all 3), Block Order & Reset
    await clickAndWaitState('[data-action="setPanelTheme"][data-arg="studio_titanium"]', (s) => s.panelTheme === 'studio_titanium', 'studio_titanium');
    assert.equal(dom.doc.body.getAttribute('data-panel-theme'), 'studio_titanium');
    await clickAndWaitState('[data-action="setPanelTheme"][data-arg="glass_teal"]', (s) => s.panelTheme === 'glass_teal', 'glass_teal');

    for (const cardId of COLLAPSIBLE_PANEL_CARD_IDS) {
      const btn = dom.doc.querySelector(`.lg-card-collapse-btn[data-arg="${cardId}"]`);
      assert.ok(btn, `Missing collapse button for ${cardId}`);
      const startsCollapsed = Boolean(loadState().panelCollapsedCards?.[cardId]);
      btn.click();
      await waitFor(
        () => Boolean(loadState().panelCollapsedCards?.[cardId]) === !startsCollapsed,
        4000,
        15,
        `toggle1:${cardId}`
      );
      await dom.waitIdle();
      btn.click();
      await waitFor(
        () => Boolean(loadState().panelCollapsedCards?.[cardId]) === startsCollapsed,
        4000,
        15,
        `toggle2:${cardId}`
      );
      await dom.waitIdle();
    }

    for (const spId of PANEL_SPOILER_IDS) {
      const sp = dom.doc.getElementById(spId);
      assert.ok(sp, `Missing spoiler ${spId}`);
      sp.open = true;
      sp.dispatchEvent({ type: 'toggle', bubbles: false });
      await waitFor(() => loadState().panelOpenSpoilers?.[spId] === true, 4000, 15, `spoiler:${spId}`);
      await dom.waitIdle();
    }
    assert.equal(dom.doc.getElementById('gpuRamCard').closest('details'), null);
    assert.equal(dom.doc.getElementById('swarmTelemetryCard').closest('details'), null);
    assert.equal(dom.doc.getElementById('sentinelSectionCard').closest('details'), null);
    assert.equal(dom.doc.getElementById('telemetrySwarmSpoiler'), null);
    assert.equal(dom.doc.getElementById('hardwareResourcesSpoiler'), null);
    assert.equal(Boolean(dom.doc.getElementById('hwQuickActionsBar').getAttribute('style')), false);

    const customOrder = [...DEFAULT_PANEL_BLOCK_ORDER].reverse();
    await vm.runInContext(`updateState({ panelBlockOrder: ${JSON.stringify(customOrder)} })`, dom.ctx);
    assert.equal(loadState().panelBlockOrder[0], customOrder[0]);
    dom.doc.querySelector('[data-action="resetPanelBlockOrder"]').click();
    await waitFor(() => loadState().panelBlockOrder[0] === DEFAULT_PANEL_BLOCK_ORDER[0]);

    // 3. Onboarding Wizard (First-Run Auto-Open, Single Button Hygiene, Theme Preview Revert & Steps 1-4)
    const wizardOpenBtns = dom.doc.querySelectorAll('[data-action="openOnboardingWizard"]');
    assert.equal(wizardOpenBtns.length, 1, 'Duplicate header wizard button must be removed; only smartProjectBanner button remains');
    assert.equal(dom.doc.querySelector('.lg-header [data-action="openOnboardingWizard"]'), null);
    assert.ok(dom.doc.querySelector('#smartProjectBanner [data-action="openOnboardingWizard"]'));

    // Cold first-run auto-launch simulation (`onboardingCompleted: false`, default English on fresh installs)
    await vm.runInContext('wizAutoOpenedOnce = false; updateState({ onboardingCompleted: false, panelTheme: "glass_teal", uiLanguage: "en" })', dom.ctx);
    await waitFor(() => dom.doc.getElementById('onboardingWizardModal').classList.contains('visible') === true);
    assert.equal(dom.doc.body.getAttribute('data-ui-language'), 'en');
    assert.equal(dom.doc.getElementById('wizLaunchBadge').textContent, 'First Run');

    // Live-preview Russian on Step 1 & studio_titanium on Step 3, then press Escape -> must revert BOTH to en + glass_teal
    dom.doc.querySelector('[data-action="wizSetLanguage"][data-arg="ru"]').click();
    assert.equal(dom.doc.body.getAttribute('data-ui-language'), 'ru');
    assert.equal(dom.doc.getElementById('wizLaunchBadge').textContent, 'Первый запуск');
    dom.doc.querySelector('[data-action="wizGoStep"][data-arg="3"]').click();
    dom.doc.querySelector('[data-action="wizSetThemePreview"][data-arg="studio_titanium"]').click();
    assert.equal(dom.doc.body.getAttribute('data-panel-theme'), 'studio_titanium');
    dom.doc.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    await waitFor(() => !dom.doc.getElementById('onboardingWizardModal').classList.contains('visible') && loadState().onboardingCompleted === true);
    assert.equal(dom.doc.body.getAttribute('data-panel-theme'), 'glass_teal');
    assert.equal(dom.doc.body.getAttribute('data-ui-language'), 'en');

    // Reopen manually via the single Setup button & verify advisor_all preservation + Steps 1-4 save (switching to RU)
    await vm.runInContext('updateState({ confirmBeforeRun: true, confirmThreshold: "ALL", orchestratorSmartSynergy: false })', dom.ctx);
    await waitFor(() => loadState().confirmThreshold === 'ALL');
    dom.doc.querySelector('[data-action="openOnboardingWizard"]').click();
    assert.equal(dom.doc.getElementById('onboardingWizardModal').classList.contains('visible'), true);
    assert.equal(dom.doc.getElementById('wizLaunchBadge').textContent, 'Quick Setup');
    assert.equal(await vm.runInContext('wizDraft.modePreset', dom.ctx), 'advisor_all');

    dom.doc.querySelector('[data-action="wizSetLanguage"][data-arg="ru"]').click();
    assert.equal(dom.doc.getElementById('wizLaunchBadge').textContent, 'Быстрая настройка');
    dom.doc.querySelector('[data-action="wizSetSubTier"][data-arg="ultra"]').click();
    dom.doc.querySelector('[data-action="wizToggleFlag"][data-arg="useGpu"]').click();
    dom.doc.querySelector('[data-action="wizGoStep"][data-arg="2"]').click();
    dom.doc.querySelector('[data-action="wizSelectMode"][data-arg="autopilot_balance"]').click();
    dom.doc.querySelector('[data-action="wizGoStep"][data-arg="3"]').click();
    dom.doc.querySelector('[data-action="wizSetInspirationMode"][data-arg="showroom"]').click();
    dom.doc.querySelector('[data-action="wizSetDesignGate"][data-arg="false"]').click();
    dom.doc.querySelector('[data-action="wizGoStep"][data-arg="4"]').click();
    dom.doc.querySelector('[data-action="wizToggleFlag"][data-arg="safetyBundle"]').click();
    dom.doc.querySelector('[data-action="wizToggleFlag"][data-arg="safetyBundle"]').click();
    dom.doc.querySelector('[data-action="wizToggleFlag"][data-arg="sentinelBundle"]').click();
    dom.doc.querySelector('[data-action="wizToggleFlag"][data-arg="sentinelBundle"]').click();
    // Close without downloading models (set gpuPullMode = 'skip' first)
    await vm.runInContext('wizSetGpuPullMode("skip")', dom.ctx);
    dom.doc.getElementById('wizNextBtn').click();
    await waitFor(() =>
      !dom.doc.getElementById('onboardingWizardModal').classList.contains('visible')
      && loadState().subscriptionTier === 'ultra'
      && loadState().swarmWorkerTier === 'neon_auto'
      && loadState().uiInspirationMode === 'showroom'
      && loadState().uiDesignPreviewGate === false
    );

    // 4. Agent Mode Card + Real Model Profile / Tool Pruner Behavior Checks
    await clickAndWaitState('[data-action="setSubscriptionTier"][data-arg="pro"]', (s) => s.subscriptionTier === 'pro', 'sub pro');
    await clickAndWaitState('[data-action="setAdvisorMode"][data-arg="true"]', (s) => s.confirmBeforeRun === true, 'advisor on');

    for (const thr of ['ALL', 'M', 'L']) {
      await clickAndWaitState(`[data-action="setConfirmThreshold"][data-arg="${thr}"]`, (s) => s.confirmThreshold === thr, `confirmThreshold=${thr}`);
      const policy = resolveEffectivePreTaskGatePolicy({
        state: loadState(),
        modelProfile: normalizeModelProfile('Gemini 4 Carbon (Medium)'),
        grade: 'M',
      });
      assert.equal(policy.shouldAskModelGate, thr !== 'L');
    }

    const synChk = dom.doc.getElementById('chk-orchestratorSmartSynergy');
    synChk.checked = false;
    synChk.dispatchEvent({ type: 'change', bubbles: true });
    await waitFor(() => loadState().orchestratorSmartSynergy === false);
    await clickAndWaitState('[data-action="setConfirmThreshold"][data-arg="M"]', (s) => s.confirmThreshold === 'M', 'M');
    const policyNoSyn = resolveEffectivePreTaskGatePolicy({
      state: loadState(),
      modelProfile: normalizeModelProfile('Orchestrator (Neon)'),
      grade: 'M',
    });
    assert.equal(policyNoSyn.orchestratorBypassSM, false);
    assert.equal(policyNoSyn.shouldAskModelGate, true);

    synChk.checked = true;
    synChk.dispatchEvent({ type: 'change', bubbles: true });
    await waitFor(() => loadState().orchestratorSmartSynergy === true);
    const policyWithSyn = resolveEffectivePreTaskGatePolicy({
      state: loadState(),
      modelProfile: normalizeModelProfile('Orchestrator (Neon)'),
      grade: 'M',
    });
    assert.equal(policyWithSyn.orchestratorBypassSM, true);

    await clickAndWaitState('[data-action="setAdvisorMode"][data-arg="false"]', (s) => s.confirmBeforeRun === false, 'autopilot');
    for (const strat of ['flash_dispatcher', 'auto_balance', 'pro_architect']) {
      await clickAndWaitState(`[data-action="selectStrategy"][data-arg="${strat}"]`, (s) => s.strategy === strat, `strategy=${strat}`);
    }
    for (const thr of ['M', 'L', 'XL']) {
      await clickAndWaitState(`[data-action="setThreshold"][data-arg="${thr}"]`, (s) => s.heavyThreshold === thr, `heavyThreshold=${thr}`);
    }
    const selEvalPerf = evaluateSelectorMatchForTask({
      modelProfile: normalizeModelProfile('Gemini 3.8 Flash'),
      grade: 'M',
      state: loadState(),
    });
    assert.equal(selEvalPerf.match, 'underprovisioned');

    // 5. UI Design Preview Gate + Showroom A/B/C Generator
    await clickAndWaitState('[data-action="setUiDesignGate"][data-arg="true"]', (s) => s.uiDesignPreviewGate === true, 'design gate on');
    for (const mode of ['ask', 'showroom', 'web_refs']) {
      await clickAndWaitState(`[data-action="setUiInspirationMode"][data-arg="${mode}"]`, (s) => s.uiInspirationMode === mode, `uiInsp=${mode}`);
      const res = classifyTaskAndPruneTools('Перекрась дизайн кнопок в ui.html', loadState(), { skillIndexWarm: false, semanticSkills: [] });
      assert.equal(res.needsDesignPreviewGate, true);
      assert.ok(res.allowedHint.includes(`uiInspirationMode: ${mode}`));
    }
    await clickAndWaitState('[data-action="setUiDesignGate"][data-arg="false"]', (s) => s.uiDesignPreviewGate === false, 'design gate off');
    const resNoGate = classifyTaskAndPruneTools('Перекрась дизайн кнопок в ui.html', loadState(), { skillIndexWarm: false, semanticSkills: [] });
    assert.equal(resNoGate.needsDesignPreviewGate, false);

    // Build real A/B/C showroom HTML via build-showroom.mjs
    const showroomSpecPath = path.join(tmpRepo, 'showroom-spec.json');
    const showroomOutPath = path.join(tmpRepo, 'showroom-out.html');
    fs.writeFileSync(
      showroomSpecPath,
      JSON.stringify({
        title: 'E2E Showroom',
        variants: [
          { id: 'A', label: 'Glass', html: '<button>A</button>', css: 'button{color:#fff}' },
          { id: 'B', label: 'Porcelain', html: '<button>B</button>', css: 'button{color:#111}' },
          { id: 'C', label: 'Minimal', html: '<button>C</button>', css: 'button{color:#0af}' },
        ],
      }),
      'utf8'
    );
    execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'skills', 'ui-ux-design-system', 'scripts', 'build-showroom.mjs'), showroomSpecPath, showroomOutPath, '--fast-png'],
      { encoding: 'utf8' }
    );
    const showroomHtml = fs.readFileSync(showroomOutPath, 'utf8');
    assert.ok(showroomHtml.includes('E2E Showroom') && showroomHtml.includes('0.25x') && showroomHtml.includes('Glass'));

    // 6. Subscription gating (Pro vs Ultra), Swarm Modes (all 6) & Worker Tiers -> verify swarm-controller.mjs
    assert.equal(dom.doc.body.getAttribute('data-subscription-tier'), 'pro');
    const gateNoteEl = dom.doc.getElementById('subscriptionTierGateNote');
    assert.ok(gateNoteEl && gateNoteEl.textContent.includes('Режим Pro: скрыты настройки моделей Ultra (Carbon).'));
    assert.equal(dom.doc.getElementById('btnStrategyProArchitect').textContent, 'Neon');
    assert.equal(dom.doc.getElementById('heavyThresholdLabel').textContent, 'Порог Neon:');
    assert.equal(
      dom.doc.querySelector('[data-action="setSwarmWorkerTier"][data-arg="argon_auto"]').getAttribute('data-min-tier'),
      'ultra'
    );
    assert.equal(
      dom.doc.querySelector('[data-action="setSwarmWorkerTier"][data-arg="carbon_auto"]').getAttribute('data-min-tier'),
      'ultra'
    );

    for (const sm of ['auto_xl', 'aggressive_l', 'auto_all', 'always_ask', 'manual_only', 'off']) {
      await clickAndWaitState(`[data-action="setSwarmMode"][data-arg="${sm}"]`, (s) => s.swarmMode === sm, `swarmMode=${sm}`);
    }
    for (const wt of ['hydrogen_auto', 'neon_auto', 'inherit']) {
      await clickAndWaitState(`[data-action="setSwarmWorkerTier"][data-arg="${wt}"]`, (s) => s.swarmWorkerTier === wt, `proSwarmTier=${wt}`);
    }
    // Pro backend sanitization clamps direct carbon_auto/argon_auto attempts
    dom.doc.querySelector('[data-action="setSwarmWorkerTier"][data-arg="carbon_auto"]').click();
    await waitFor(() => loadState().swarmWorkerTier === 'neon_auto');
    dom.doc.querySelector('[data-action="setSwarmWorkerTier"][data-arg="argon_auto"]').click();
    await waitFor(() => loadState().swarmWorkerTier === 'hydrogen_auto');

    // Switch to Ultra: unlocks full UI labels and all 5 swarm worker tiers
    await clickAndWaitState('[data-action="setSubscriptionTier"][data-arg="ultra"]', (s) => s.subscriptionTier === 'ultra', 'sub ultra');
    assert.equal(dom.doc.body.getAttribute('data-subscription-tier'), 'ultra');
    assert.equal(gateNoteEl.style.display, 'none');
    assert.equal(dom.doc.getElementById('btnStrategyProArchitect').textContent, 'Neon / Carbon');
    assert.equal(dom.doc.getElementById('heavyThresholdLabel').textContent, 'Порог Neon/Carbon:');
    for (const wt of ['hydrogen_auto', 'neon_auto', 'argon_auto', 'inherit', 'carbon_auto']) {
      await clickAndWaitState(`[data-action="setSwarmWorkerTier"][data-arg="${wt}"]`, (s) => s.swarmWorkerTier === wt, `ultraSwarmTier=${wt}`);
    }

    // Downgrade Ultra (with carbon_auto active) -> Pro automatically clamps to neon_auto
    await clickAndWaitState(
      '[data-action="setSubscriptionTier"][data-arg="pro"]',
      (s) => s.subscriptionTier === 'pro' && s.swarmWorkerTier === 'neon_auto',
      'sub ultra->pro clamp'
    );
    assert.equal(dom.doc.body.getAttribute('data-subscription-tier'), 'pro');

    const swAutoAll = evaluateSwarmRoutingDirective({
      state: { ...loadState(), swarmMode: 'auto_all', swarmWorkerTier: 'neon_auto' },
      grade: 'L',
      matchedFilesCount: 3,
      subsystemHits: 2,
    });
    assert.equal(swAutoAll.shouldActivateSwarm, true);
    assert.ok(swAutoAll.directiveEn.includes('gemini-4-neon'));
    const swOff = evaluateSwarmRoutingDirective({
      state: { ...loadState(), swarmMode: 'off' },
      grade: 'XL',
      matchedFilesCount: 6,
      subsystemHits: 4,
    });
    assert.equal(swOff.shouldActivateSwarm, false);

    // 7. Skills Search, Disable Skill -> verify tool-pruner blocks it -> Reset All to Auto
    await waitFor(() => dom.doc.querySelectorAll('.skill-item').length > 0);
    const firstSkill = dom.doc.querySelector('.skill-item');
    const firstSkillId = firstSkill.getAttribute('data-skill-id');
    const skillSearchEl = dom.doc.getElementById('skillSearchInput');
    skillSearchEl.value = firstSkillId;
    skillSearchEl.dispatchEvent({ type: 'input', bubbles: true });
    assert.equal(firstSkill.hidden, false);

    const offBtn = firstSkill.querySelector('[data-action="setSkillMode"][data-mode="off"]');
    offBtn.click();
    await waitFor(() => loadState().skillModes?.[firstSkillId] === 'off');
    const prunedWithOff = classifyTaskAndPruneTools('Помоги по проекту', loadState(), { skillIndexWarm: false, semanticSkills: [] });
    assert.ok(prunedWithOff.allowedHint.includes(firstSkillId));

    dom.doc.querySelector('[data-action="resetAllSkillsToAuto"]').click();
    await waitFor(() => Object.keys(loadState().skillModes || {}).length === 0);

    // 8. Hardware Limits (VRAM Cap, RAM Budget, CPU Threads dropdowns, Models Select, Calibration, GPU Actions, Sentinel)
    dom.doc.getElementById('btn-gpuVramCap').click();
    assert.equal(dom.doc.getElementById('lgCustomSelectMenu').hidden, false);
    await vm.runInContext('commitCustomSelectOption("sel-gpuVramCap", "4096")', dom.ctx);
    await waitFor(() => loadState().gpuMaxVramMb === 4096, 3500, 15, 'vram 4GB');
    await vm.runInContext('commitCustomSelectOption("sel-ramBudgetMain", "4096")', dom.ctx);
    await waitFor(() => loadState().ramMaxBudgetMb === 4096, 3500, 15, 'ram 4GB');
    await vm.runInContext('commitCustomSelectOption("sel-cpuThreadsCap", "2")', dom.ctx);
    await waitFor(() => loadState().cpuMaxThreads === 2, 3500, 15, 'cpu 2t');

    // Custom select dropdown toggle + select option
    dom.doc.getElementById('btn-gpuChatModel').click();
    assert.equal(dom.doc.getElementById('lgCustomSelectMenu').hidden, false);
    await vm.runInContext('selectGpuModel("gpuChatModel", "qwen3:4b")', dom.ctx);
    await waitFor(() => loadState().gpuChatModel === 'qwen3:4b');
    await vm.runInContext('selectGpuModel("gpuEmbedModel", "qwen3-embedding:0.6b")', dom.ctx);
    await waitFor(() => loadState().gpuEmbedModel === 'qwen3-embedding:0.6b');

    // Auto-calibration
    dom.doc.querySelector('[data-action="autoCalibrateHardware"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Лимиты') || loadState().hardwareProfiled === true);

    // Prompt buttons dispatch to sidecar.agent
    const beforeMsgs = dom.sentAgentMessages.length;
    dom.doc.querySelector('[data-action="sendHardwareTunePrompt"]').click();
    await waitFor(() => dom.sentAgentMessages.length > beforeMsgs);
    dom.doc.querySelector('[data-action="prepareModelSearchPrompt"]').click();
    await waitFor(() => dom.sentAgentMessages.length > beforeMsgs + 1);

    // Sentinel run_now & clear_findings & GPU cancel pull / scrollToGpuRamCard (fast CPU mode)
    if (loadState().gpuEnabled) {
      await clickAndWaitState('#chk-gpuEnabled', (s) => s.gpuEnabled === false, 'ensure gpu off before sentinel');
    }
    dom.doc.getElementById('topRamLivePill').click();
    dom.doc.getElementById('btnRunSentinelNow').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Проверка Фонового Дозора завершена ✓'), 8000);
    const clearSentinelRes = await globalThis.fetch(`${originUrl}/api/sentinel`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear_findings', rootDir: tmpRepo }),
    });
    const clearSentinelJson = await clearSentinelRes.json();
    assert.equal(clearSentinelJson.ok, true);
    const gpuStatusRes = await globalThis.fetch(`${originUrl}/api/gpu`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    });
    const gpuStatusJson = await gpuStatusRes.json();
    assert.ok(gpuStatusJson && gpuStatusJson.error === undefined && typeof gpuStatusJson.ok !== 'undefined' || Boolean(gpuStatusJson?.hardware || gpuStatusJson?.ollama || gpuStatusJson?.enabled !== undefined));
    dom.doc.querySelector('[data-action="cancelGpuCascadePull"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('отменена'));

    // Progress HUD: subagents drawer, background tasks drawer & step chip toggles
    await vm.runInContext(`
      renderTaskProgressAndHud({
        status: 'running',
        projectName: ${JSON.stringify(path.basename(tmpRepo))},
        workspaceRoot: ${JSON.stringify(tmpRepo)},
        activeChats: [{
          conversationId: 'e2e_chat_1',
          chatNumber: 1,
          projectName: ${JSON.stringify(path.basename(tmpRepo))},
          workspaceRoot: ${JSON.stringify(tmpRepo)},
          status: 'running',
          currentStep: 1,
          totalSteps: 2,
          percent: 50,
          stepTitle: 'Проверка UI',
          steps: [{ title: 'Шаг 1', status: 'running' }],
          subagents: [{ conversationId: 'sub_1', roleLabel: 'Verifier', percent: 40, status: 'running', stepTitle: 'Анализ' }],
          backgroundTasksTotalCount: 17,
          backgroundTasksCount: 1,
          hasRunningBackgroundTask: true,
          backgroundTasks: [
            { id: 'bg_1', taskId: 'bg_1', label: 'Запуск сервера мониторинга', commandPreview: 'node monitor.mjs', status: 'running', isDaemon: true, startedAt: Date.now() - 5000, updatedAt: Date.now() },
            { id: 'bg_2', taskId: 'bg_2', label: 'Сборка бандла UI', commandPreview: 'node scripts/build-panel-ui.mjs', status: 'done', startedAt: Date.now() - 20000, updatedAt: Date.now() - 12000 },
            { id: 'bg_3', taskId: 'bg_3', label: 'Проверка контрактов', commandPreview: 'node --test tests/router-core.test.mjs', status: 'error', startedAt: Date.now() - 30000, updatedAt: Date.now() - 25000 },
            { id: 'bg_4', taskId: 'bg_4', label: 'Остановленный воркер', commandPreview: 'npm run watch', status: 'cancelled', startedAt: Date.now() - 40000, updatedAt: Date.now() - 35000 },
            { id: 'bg_5', taskId: 'bg_5', label: 'Старая задача 5', commandPreview: 'echo 5', status: 'done', startedAt: Date.now() - 50000, updatedAt: Date.now() - 45000 },
            { id: 'bg_6', taskId: 'bg_6', label: 'Старая задача 6', commandPreview: 'echo 6', status: 'done', startedAt: Date.now() - 60000, updatedAt: Date.now() - 55000 }
          ]
        }],
      });
    `, dom.ctx);
    const subToggleBtn = dom.doc.querySelector('[data-action="toggleSubagentsList"]');
    assert.ok(subToggleBtn);
    subToggleBtn.click();
    assert.equal(subToggleBtn.getAttribute('aria-expanded'), 'true');

    const bgToggleBtn = dom.doc.querySelector('[data-action="toggleBgTasksList"]');
    assert.ok(bgToggleBtn, 'Background tasks toggle button must be rendered');
    assert.equal(bgToggleBtn.querySelector('.ag-bgtask-count').textContent, '1/17');
    assert.ok(bgToggleBtn.classList.contains('is-active-glow'));
    bgToggleBtn.click();
    assert.equal(bgToggleBtn.getAttribute('aria-expanded'), 'true');
    const bgDrawer = dom.doc.querySelector('.ag-bgtasks-drawer');
    assert.ok(bgDrawer && bgDrawer.classList.contains('is-open'));
    assert.equal(dom.doc.querySelectorAll('.ag-bgtask-item').length, 6);
    assert.equal(dom.doc.querySelectorAll('.ag-bgtask-item.is-overflow-hidden').length, 2);
    const seeAllBtn = dom.doc.querySelector('[data-action="toggleBgTasksShowAll"]');
    assert.ok(seeAllBtn, 'See all button must appear when >4 tasks');
    seeAllBtn.click();
    assert.equal(dom.doc.querySelectorAll('.ag-bgtask-item.is-overflow-hidden').length, 0);

    // Re-render on simulated telemetry poll: drawer and See all expansion must persist
    await vm.runInContext(`
      renderTaskProgressAndHud({
        status: 'running',
        projectName: ${JSON.stringify(path.basename(tmpRepo))},
        workspaceRoot: ${JSON.stringify(tmpRepo)},
        activeChats: [{
          conversationId: 'e2e_chat_1',
          chatNumber: 1,
          projectName: ${JSON.stringify(path.basename(tmpRepo))},
          workspaceRoot: ${JSON.stringify(tmpRepo)},
          status: 'running',
          currentStep: 1,
          totalSteps: 2,
          percent: 60,
          stepTitle: 'Проверка UI',
          steps: [{ title: 'Шаг 1', status: 'running' }],
          subagents: [{ conversationId: 'sub_1', roleLabel: 'Verifier', percent: 55, status: 'running', stepTitle: 'Анализ' }],
          backgroundTasksTotalCount: 17,
          backgroundTasksCount: 1,
          hasRunningBackgroundTask: true,
          backgroundTasks: [
            { id: 'bg_1', taskId: 'bg_1', label: 'Запуск сервера мониторинга', commandPreview: 'node monitor.mjs', status: 'running', isDaemon: true, startedAt: Date.now() - 5000, updatedAt: Date.now() },
            { id: 'bg_2', taskId: 'bg_2', label: 'Сборка бандла UI', commandPreview: 'node scripts/build-panel-ui.mjs', status: 'done', startedAt: Date.now() - 20000, updatedAt: Date.now() - 12000 },
            { id: 'bg_3', taskId: 'bg_3', label: 'Проверка контрактов', commandPreview: 'node --test tests/router-core.test.mjs', status: 'error', startedAt: Date.now() - 30000, updatedAt: Date.now() - 25000 },
            { id: 'bg_4', taskId: 'bg_4', label: 'Остановленный воркер', commandPreview: 'npm run watch', status: 'cancelled', startedAt: Date.now() - 40000, updatedAt: Date.now() - 35000 },
            { id: 'bg_5', taskId: 'bg_5', label: 'Старая задача 5', commandPreview: 'echo 5', status: 'done', startedAt: Date.now() - 50000, updatedAt: Date.now() - 45000 },
            { id: 'bg_6', taskId: 'bg_6', label: 'Старая задача 6', commandPreview: 'echo 6', status: 'done', startedAt: Date.now() - 60000, updatedAt: Date.now() - 55000 }
          ]
        }],
      });
    `, dom.ctx);
    assert.equal(dom.doc.querySelector('[data-action="toggleBgTasksList"]').getAttribute('aria-expanded'), 'true');
    assert.equal(dom.doc.querySelectorAll('.ag-bgtask-item.is-overflow-hidden').length, 0);

    const stepChipBtn = dom.doc.querySelector('[data-action="toggleStepChip"]');
    assert.ok(stepChipBtn);
    stepChipBtn.click();
    assert.equal(stepChipBtn.getAttribute('aria-expanded'), 'true');

    // 9. Smart Composer: Ghost RAM text, Tab accept, @ menu, Chips, Clear, RAG chat + source pill, Pre-Commit, Voice, Send, Wiretap
    dom.doc.querySelector('[data-action="applyComposerChip"]').click();
    assert.ok(dom.doc.getElementById('smartComposerInput').value.length > 0);
    dom.doc.getElementById('btnClearComposer').click();
    assert.equal(dom.doc.getElementById('smartComposerInput').value, '');

    const compInput = dom.doc.getElementById('smartComposerInput');
    compInput.value = 'Проверь @app';
    compInput.setSelectionRange(compInput.value.length, compInput.value.length);
    compInput.dispatchEvent({ type: 'input', bubbles: true });
    await waitFor(() => dom.doc.getElementById('composerAtMenu').style.display === 'block', 4000);
    const atItem = dom.doc.querySelector('[data-action="selectComposerAtItem"]');
    if (atItem) atItem.click();
    assert.equal(dom.doc.getElementById('composerAtMenu').style.display, 'none');

    // Ghost text Tab accept chains next autocomplete without Space + RAG source insertion
    const chainCheck = await vm.runInContext(`(() => {
      const seqBefore = _smartReqSeq;
      _smartGhostText = ' и тесты';
      renderSmartComposerMirror();
      acceptSmartComposerGhost(false);
      const chained = _smartReqSeq > seqBefore && (_smartFastTimer !== null || _smartGpuTimer !== null);
      insertRagSourceRef('app.mjs:L1-3');
      return { chained };
    })()`, dom.ctx);
    assert.equal(chainCheck.chained, true, 'acceptSmartComposerGhost must schedule follow-up autocomplete without pressing Space');
    assert.ok(compInput.value.includes('и тесты'));
    assert.ok(compInput.value.includes('app.mjs:L1-3'));

    // Pre-commit (0 tokens) & Local RAG chat (while GPU disabled -> friendly status) & clear
    if (loadState().gpuEnabled) {
      await clickAndWaitState('#chk-gpuEnabled', (s) => s.gpuEnabled === false, 'ensure gpu off');
    }
    dom.doc.getElementById('btnPrepareCommit').click();
    await waitFor(() => dom.doc.getElementById('localRagChatBox').style.display === 'flex', 8000);
    await dom.waitIdle();

    compInput.value = 'Где находится hello?';
    dom.doc.getElementById('btnAskLocalRag').click();
    await waitFor(() => dom.doc.querySelectorAll('.local-rag-msg').length >= 2);
    await dom.waitIdle();
    dom.doc.getElementById('btnClearLocalRag').click();
    assert.equal(dom.doc.getElementById('localRagChatBox').style.display, 'none');

    // Voice toggle controls #btnVoiceComposer visibility
    await clickAndWaitState('#chk-composerVoiceEnabled', (s) => s.composerVoiceEnabled === true, 'voice on');
    assert.equal(dom.doc.getElementById('btnVoiceComposer').style.display, 'inline-flex');

    // Send Smart Composer -> triggers sidecar.agent.sendMessage
    const msgCountBeforeSend = dom.sentAgentMessages.length;
    compInput.value = 'Тестовая задача из E2E';
    dom.doc.getElementById('btnSendSmartComposer').click();
    await waitFor(() => dom.sentAgentMessages.length > msgCountBeforeSend);

    // Wiretap fault -> banner shows -> send to composer -> clear
    const wtRes = await globalThis.fetch(`${originUrl}/api/wiretap/fault?rootDir=${encodeURIComponent(tmpRepo)}`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'node', command: 'node app.mjs', rawError: 'ReferenceError: foo is not defined at app.mjs:2:1', exitCode: 1 }),
    });
    const wtJson = await wtRes.json();
    assert.equal(wtJson.ok, true);
    await vm.runInContext('refreshAll()', dom.ctx);
    await waitFor(() => dom.doc.getElementById('wiretapAlertBar').style.display === 'block');
    dom.doc.querySelector('[data-action="sendWiretapFaultToComposer"]').click();
    assert.ok(dom.doc.getElementById('smartComposerInput').value.includes('app.mjs'));
    dom.doc.querySelector('[data-action="clearWiretapFaults"]').click();
    await waitFor(() => dom.doc.getElementById('wiretapAlertBar').style.display === 'none');

    // 10. Checkpoints, Turn Diff, Rollback & Git Shadow Worktree
    const appPath = path.join(tmpRepo, 'app.mjs');
    const origContent = fs.readFileSync(appPath, 'utf8');
    const cp = createShadowCheckpoint({
      filePath: appPath,
      workspaceRoot: tmpRepo,
      turnId: 'e2e_turn_1',
      turnLabel: 'E2E правка',
    });
    assert.ok(cp && cp.id);
    fs.writeFileSync(appPath, 'export const broken = true;\n', 'utf8');

    await vm.runInContext('refreshAll()', dom.ctx);
    await waitFor(() => dom.doc.querySelector('[data-action="showTurnDiff"]') !== null);
    dom.doc.querySelector('[data-action="showTurnDiff"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Ход:'));

    // Switch view to files and rollback specific file, then create another turn & test rollbackLatestTurn
    dom.doc.querySelector('[data-action="setCheckpointsViewMode"][data-arg="files"]').click();
    await waitFor(() => dom.doc.querySelector('[data-action="rollbackSpecific"]') !== null);
    dom.doc.querySelector('[data-action="rollbackSpecific"]').click();
    await waitFor(() => fs.readFileSync(appPath, 'utf8') === origContent);
    await dom.waitIdle();

    const cpTurn = createShadowCheckpoint({
      filePath: appPath,
      workspaceRoot: tmpRepo,
      turnId: 'e2e_turn_2',
      turnLabel: 'E2E правка хода',
    });
    assert.ok(cpTurn && cpTurn.id);
    fs.writeFileSync(appPath, 'export const brokenTurn = true;\n', 'utf8');
    await vm.runInContext('refreshAll()', dom.ctx);
    dom.doc.querySelector('[data-action="rollbackLatestTurn"]').click();
    await waitFor(() => fs.readFileSync(appPath, 'utf8') === origContent);
    await dom.waitIdle();

    // Git Worktree create -> modify -> promote -> create -> discard via UI buttons
    dom.doc.querySelector('[data-action="worktreeAction"][data-mode="create"]').click();
    await waitFor(
      () => dom.doc.querySelector('[data-action="worktreeAction"][data-mode="promote"]') !== null,
      8000,
      15,
      () => `pill="${dom.doc.getElementById('statusPill')?.textContent}" list="${dom.doc.getElementById('shadowWorktreeList')?.innerHTML}" disabled=${dom.doc.querySelector('[data-action="worktreeAction"][data-mode="create"]')?.disabled}`
    );
    const wtList = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.cache', 'shadow-worktrees.json'), 'utf8'));
    const wtEntry = (wtList?.entries || []).find((e) => e.workspaceRoot && e.workspaceRoot.toLowerCase() === tmpRepo.toLowerCase());
    if (wtEntry?.worktreePath) {
      fs.writeFileSync(path.join(wtEntry.worktreePath, 'app.mjs'), `${origContent}// promoted from wt\n`, 'utf8');
    }
    dom.doc.querySelector('[data-action="worktreeAction"][data-mode="promote"]').click();
    await waitFor(() => fs.readFileSync(appPath, 'utf8').includes('promoted from wt'), 6000);
    fs.writeFileSync(appPath, origContent, 'utf8');

    dom.doc.querySelector('[data-action="worktreeAction"][data-mode="create"]').click();
    await waitFor(() => dom.doc.querySelector('[data-action="worktreeAction"][data-mode="discard"]') !== null, 6000);
    dom.doc.querySelector('[data-action="worktreeAction"][data-mode="discard"]').click();
    await waitFor(() => dom.doc.querySelector('[data-action="worktreeAction"][data-mode="discard"]') === null, 6000);

    // Record victory recipe & clear via UI button
    await globalThis.fetch(`${originUrl}/api/knowledge/recipes?rootDir=${encodeURIComponent(tmpRepo)}`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ errorExcerpt: 'E2E error', fixSummary: 'Fixed E2E' }),
    });
    assert.ok(knowledgeHub.listVictoryRecipes(tmpRepo, 10).length >= 1);
    dom.doc.querySelector('[data-action="clearVictoryRecipes"]').click();
    await waitFor(() => knowledgeHub.listVictoryRecipes(tmpRepo, 10).length === 0);

    // 11. Expert Actions: Circuit Reset, Pitfalls Clear, Federation Relative Path + Invalid Error + Remove, Backup/Restore, Save GPU Config
    recordErrorFingerprint({ workspaceRoot: tmpRepo, errorText: 'SyntaxError: Unexpected token at app.mjs:1:1' });
    recordErrorFingerprint({ workspaceRoot: tmpRepo, errorText: 'SyntaxError: Unexpected token at app.mjs:1:1' });
    recordErrorFingerprint({ workspaceRoot: tmpRepo, errorText: 'SyntaxError: Unexpected token at app.mjs:1:1' });
    assert.equal(getCircuitState({ workspaceRoot: tmpRepo }).status, 'TRIPPED');
    dom.doc.querySelector('[data-action="resetCircuitBreaker"]').click();
    await waitFor(() => getCircuitState({ workspaceRoot: tmpRepo }).status === 'CLOSED');
    await dom.waitIdle();

    recordPitfall({ workspaceRoot: tmpRepo, fileName: appPath, summary: 'E2E pitfall test' });
    assert.ok(listPitfalls(10, tmpRepo).length >= 1);
    dom.doc.querySelector('[data-action="clearPitfalls"]').click();
    await waitFor(() => listPitfalls(10, tmpRepo).length === 0);
    await dom.waitIdle();

    // Federation: invalid folder preserves input & flashes error
    const peerInput = dom.doc.getElementById('federatedPeerInput');
    peerInput.value = '../definitely-missing-repo-xyz';
    dom.doc.querySelector('[data-action="addFederatedPeer"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Федерация:'), 6000, 15, 'federation error pill');
    assert.equal(peerInput.value, '../definitely-missing-repo-xyz');

    // Federation: valid relative path resolves cleanly & syncs state
    peerInput.value = peerRel;
    dom.doc.querySelector('[data-action="addFederatedPeer"]').click();
    await waitFor(() => dom.doc.querySelector('[data-action="removeFederatedPeer"]') !== null);
    assert.equal(loadState().federatedWorkspaces.length, 1);
    dom.doc.querySelector('[data-action="removeFederatedPeer"]').click();
    await waitFor(() => dom.doc.querySelector('[data-action="removeFederatedPeer"]') === null);
    assert.equal(loadState().federatedWorkspaces.length, 0);

    // Profile Backup -> Mutate -> Restore -> Verify restored!
    await clickAndWaitState('[data-action="setThreshold"][data-arg="XL"]', (s) => s.heavyThreshold === 'XL', 'XL before backup');
    dom.doc.querySelector('[data-action="backupProfile"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Слепок сохранён'));
    await clickAndWaitState('[data-action="setThreshold"][data-arg="M"]', (s) => s.heavyThreshold === 'M', 'M mutated');
    dom.doc.querySelector('[data-action="restoreProfile"]').click();
    await waitFor(() => loadState().heavyThreshold === 'XL');

    // Expert GPU config: reject external URL (SSRF protection) & accept localhost
    dom.doc.getElementById('inp-gpuEndpoint').value = 'https://evil.example.com:11434';
    dom.doc.querySelector('[data-action="saveExpertGpuConfig"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Ошибка:'));
    dom.doc.getElementById('inp-gpuEndpoint').value = 'http://127.0.0.1:11434';
    dom.doc.getElementById('inp-gpuKeepAlive').value = '20m';
    dom.doc.getElementById('inp-gpuContextTokens').value = '8192';
    dom.doc.querySelector('[data-action="saveExpertGpuConfig"]').click();
    await waitFor(() => loadState().gpuKeepAlive === '20m' && loadState().gpuContextTokens === 8192);

    // Compact digest + RepoMap refresh + Bayesian reset
    recordModelOutcome({ domain: 'code_generation', success: false, tier: 'flash', workspaceRoot: tmpRepo });
    recordFileFragility({ filePath: appPath, workspaceRoot: tmpRepo, success: false });
    assert.ok(getBayesianSummary(tmpRepo).fragileFiles.length >= 1);
    dom.doc.querySelector('[data-action="resetWorkspaceFragility"]').click();
    await waitFor(() => getBayesianSummary(tmpRepo).fragileFiles.length === 0);
    dom.doc.querySelector('[data-action="resetBayesianPriors"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Веса доверия сброшены'));

    dom.doc.querySelector('[data-action="compactDigest"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Дайджест'), 6000, 15, 'compactDigest');
    await dom.waitIdle();
    dom.doc.querySelector('[data-action="refreshRepoMap"]').click();
    await waitFor(() => dom.doc.getElementById('statusPill').textContent.includes('Карта проекта'), 6000, 15, 'refreshRepoMap');
    await dom.waitIdle();
  } finally {
    dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 2: Every Single Boolean Toggle (56 keys) Persists & Affects Runtime
// ---------------------------------------------------------------------------

test('2. All 56 Boolean Toggles: UI checkbox sync, server persistence & real downstream module effects', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-toggles-');
  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp });
  const originUrl = `http://127.0.0.1:${app.port}`;
  const html = fs.readFileSync(UI_HTML_PATH, 'utf8');
  const dom = createPanelDomHarness(html, originUrl, 'e2e-token-2', { workspaceUris: [tmpRepo] });

  try {
    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));
    await dom.waitIdle();

    // Open all spoilers so lazy-rendered controls (worktree bar, knowledge hub) update live
    for (const spId of PANEL_SPOILER_IDS) {
      const sp = dom.doc.getElementById(spId);
      sp.open = true;
      sp.dispatchEvent({ type: 'toggle', bubbles: false });
      await dom.waitIdle();
    }

    const allBoolKeys = Object.keys(DEFAULT_STATE).filter((k) => typeof DEFAULT_STATE[k] === 'boolean');
    assert.ok(allBoolKeys.length >= 50, `Expected >=50 boolean keys, got ${allBoolKeys.length}`);

    for (const key of allBoolKeys) {
      const chk = dom.doc.getElementById(`chk-${key}`);
      const initialVal = loadState()[key];
      const toggledVal = !initialVal;

      if (chk) {
        chk.checked = toggledVal;
        chk.dispatchEvent({ type: 'change', bubbles: true });
      } else {
        await vm.runInContext(`updateState({ ${key}: ${toggledVal} })`, dom.ctx);
      }
      await waitFor(() => loadState()[key] === toggledVal, 4000, 15, `toggle on:${key}`);
      await dom.waitIdle();
      if (chk) assert.equal(chk.checked, toggledVal, `Checkbox #chk-${key} out of sync`);

      // Restore original boolean value
      if (chk) {
        chk.checked = initialVal;
        chk.dispatchEvent({ type: 'change', bubbles: true });
      } else {
        await vm.runInContext(`updateState({ ${key}: ${initialVal} })`, dom.ctx);
      }
      await waitFor(() => loadState()[key] === initialVal, 4000, 15, `toggle off:${key}`);
      await dom.waitIdle();
    }

    // Verify key toggles genuinely affect downstream core modules & UI gates:
    // A) shadowWorktreeEnabled = false -> blocks createShadowWorktree & disables UI worktree bar
    const chkWt = dom.doc.getElementById('chk-shadowWorktreeEnabled');
    chkWt.checked = false;
    chkWt.dispatchEvent({ type: 'change', bubbles: true });
    await waitFor(() => loadState().shadowWorktreeEnabled === false, 4000, 15, 'shadowWorktree off');
    await dom.waitIdle();
    const wtDisabledRes = createShadowWorktree({ workspaceRoot: tmpRepo, state: loadState() });
    assert.equal(wtDisabledRes.ok, false);
    assert.equal(wtDisabledRes.disabled, true);
    assert.match(dom.doc.getElementById('shadowWorktreeList').textContent, /отключена|disabled/i);

    // B) sqliteKnowledgeEnabled = false -> disables UI federation input & knowledge snapshot
    const chkSql = dom.doc.getElementById('chk-sqliteKnowledgeEnabled');
    chkSql.checked = false;
    chkSql.dispatchEvent({ type: 'change', bubbles: true });
    await waitFor(() => loadState().sqliteKnowledgeEnabled === false, 4000, 15, 'sqliteKnowledge off');
    await dom.waitIdle();
    assert.equal(dom.doc.getElementById('federatedPeerInput').disabled, true);
    assert.match(dom.doc.getElementById('knowledgeStatsBadge').textContent, /^(?:Откл\.|Off)$/);

    // C) cpuMulticoreEnabled = false -> resolveCpuThreadBudget drops thread budget to 1
    const cpuOffCfg = loadCpuConfig({ cpuMulticoreEnabled: false, cpuMaxThreads: 16 });
    assert.equal(cpuOffCfg.cpuMulticoreEnabled, false);
    assert.equal(resolveCpuThreadBudget({ cpuMulticoreEnabled: false, cpuMaxThreads: 16 }), 1);

    // D) gpuEnabled = false -> loadGpuConfig disables GPU
    const gpuOffCfg = loadGpuConfig({ gpuEnabled: false });
    assert.equal(gpuOffCfg.gpuEnabled, false);

    // E) securityGuard = false -> PreToolUse hook bypasses checkFileSecurity & checkCommandSecurity
    assert.equal(checkFileSecurity({ filePath: path.join(tmpRepo, '.env'), workspaceRoot: tmpRepo }).allow, false);
    assert.equal(checkCommandSecurity({ commandLine: 'cat .env', workspaceRoot: tmpRepo }).allow, false);
    const secFileDeny = await handlePreToolUse(
      { conversationId: 'e2e_sec_1', workspacePaths: [tmpRepo], toolName: 'read_file', args: { Path: path.join(tmpRepo, '.env') } },
      { securityGuard: true, readDedup: false }
    );
    assert.equal(secFileDeny.decision, 'deny');
    const secFileAllow = await handlePreToolUse(
      { conversationId: 'e2e_sec_2', workspacePaths: [tmpRepo], toolName: 'read_file', args: { Path: path.join(tmpRepo, '.env') } },
      { securityGuard: false, readDedup: false }
    );
    assert.equal(secFileAllow.decision, 'allow');
    const secCmdDeny = await handlePreToolUse(
      { conversationId: 'e2e_sec_3', workspacePaths: [tmpRepo], toolName: 'run_command', args: { CommandLine: 'cat .env' } },
      { securityGuard: true }
    );
    assert.equal(secCmdDeny.decision, 'deny');
    const secCmdAllow = await handlePreToolUse(
      { conversationId: 'e2e_sec_4', workspacePaths: [tmpRepo], toolName: 'run_command', args: { CommandLine: 'cat .env' } },
      { securityGuard: false }
    );
    assert.equal(secCmdAllow.decision, 'allow');

    // F) sentinelEnabled = false -> BackgroundSentinel stops running actions
    const tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-sen-e2e-'));
    tempDirs.push(tmpCache);
    const sen = new BackgroundSentinel({ cacheDir: tmpCache, stateOverride: { sentinelEnabled: false } });
    const senSnap = await sen.getStatusSnapshot(tmpRepo);
    assert.equal(senSnap.enabled, false);
    assert.equal(senSnap.state, 'disabled');
  } finally {
    dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 3: Multi-Chat Telemetry Aggregation & Breakdown (Cache/RAM/CPU/GPU)
// ---------------------------------------------------------------------------

test('3. Multi-Chat Stats Aggregation: collectTelemetry sums multiple chat transcripts accurately', () => {
  const tmpBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-e2e-chats-'));
  tempDirs.push(tmpBrain);

  const mkChat = (cid, steps) => {
    const logDir = path.join(tmpBrain, cid, '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  };

  mkChat('chat-a', [
    { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 10000, tool_calls: [{ name: 'ram_slice', args: {} }] },
  ]);
  mkChat('chat-b', [
    { input_tokens: 500, output_tokens: 100, cache_read_tokens: 5000, tool_calls: [{ name: 'ram_search', args: {} }, { name: 'invoke_subagent', args: { Model: 'flash' } }] },
  ]);

  const tel = collectTelemetry(120000, { brainDirs: [tmpBrain], skipGlobalGpuTelemetry: true });
  assert.equal(tel.totalChats, 2);
  assert.equal(tel.steps, 2);
  assert.equal(tel.cacheReadTokens, 15000);
  assert.equal(tel.cacheSavedTokens, Math.round(15000 * 0.95));
  assert.equal(tel.ramCalls.slices, 1);
  assert.equal(tel.ramCalls.searches, 1);
  assert.equal(tel.ramSavedTokens, 900 + 650);
  assert.equal(tel.subagents.flash, 1);
  assert.equal(tel.savingsBreakdown.cache, tel.cacheSavedTokens);
  assert.equal(tel.savingsBreakdown.ram, tel.ramSavedTokens);
});

// ---------------------------------------------------------------------------
// E2E Test 4: Audit v3.32.1 Regression — updateState() Map Merge & HTTP 500 Rollback
// ---------------------------------------------------------------------------

test('4. Audit v3.32.1 regression: updateState merges panelCollapsedCards patches and rolls back to pre-optimistic snapshot on HTTP 500', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-rollback-');
  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp });
  assert.ok(app && app.port > 0);
  const originUrl = `http://127.0.0.1:${app.port}`;
  const htmlRes = await globalThis.fetch(`${originUrl}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();

  const dom = createPanelDomHarness(html, originUrl, 'e2e-token-4', {
    workspaceUris: [tmpRepo],
  });

  try {
    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));
    await dom.waitIdle();

    // (a) Queued patches while a flush is in-flight must deep-merge skillModes while letting latest full panelCollapsedCards snapshot win
    const mergedRes = await vm.runInContext(`(async () => {
      const p0 = updateState({ heavyThreshold: 'M' });
      const p1 = updateState({
        skillModes: { 'deep-stress-auditor': 'off' },
        panelCollapsedCards: { skillsSectionCard: true, gpuRamCard: true },
      });
      const p2 = updateState({
        skillModes: { 'skill-architect': 'off' },
        panelCollapsedCards: { gpuRamCard: true },
      });
      return Promise.all([p0, p1, p2]);
    })()`, dom.ctx);
    assert.deepEqual(Array.from(mergedRes), [true, true, true]);
    const stAfterMerge = loadState();
    assert.equal(stAfterMerge.skillModes?.['deep-stress-auditor'], 'off');
    assert.equal(stAfterMerge.skillModes?.['skill-architect'], 'off');
    assert.equal(stAfterMerge.panelCollapsedCards?.gpuRamCard, true);
    assert.equal(stAfterMerge.panelCollapsedCards?.skillsSectionCard, undefined);

    // (b) Failed /api/update (HTTP 500) must roll back to pre-optimistic snapshot (not the failed optimistic value)
    const themeSeedOk = await vm.runInContext(`updateState({ panelTheme: 'glass_teal' })`, dom.ctx);
    assert.equal(themeSeedOk, true);
    await dom.waitIdle();
    assert.equal(dom.doc.body.getAttribute('data-panel-theme'), 'glass_teal');

    const failOk = await vm.runInContext(`(async () => {
      const origPanelFetch = panelFetch;
      panelFetch = async (url, opts) => {
        if (String(url || '').startsWith('/api/update')) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ ok: false, error: 'Injected 500' }),
          };
        }
        return origPanelFetch(url, opts);
      };
      try {
        return await updateState({ panelTheme: 'studio_titanium' });
      } finally {
        panelFetch = origPanelFetch;
      }
    })()`, dom.ctx);

    assert.equal(failOk, false);
    assert.equal(dom.doc.body.getAttribute('data-panel-theme'), 'glass_teal');
    assert.equal(vm.runInContext('currentState.panelTheme', dom.ctx), 'glass_teal');
  } finally {
    dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 5: Lite / Full Panel View Mode, Quick Controls & Wizard Preview Revert
// ---------------------------------------------------------------------------

test('5. Panel Lite/Full view mode: switcher, adaptive telemetry pruning, quick controls, RAM+GPU toggles & wizard revert', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-lite-');
  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp });
  assert.ok(app && app.port > 0);
  const originUrl = `http://127.0.0.1:${app.port}`;

  const htmlRes = await globalThis.fetch(`${originUrl}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();

  const dom = createPanelDomHarness(html, originUrl, 'e2e-token-5', {
    workspaceUris: [tmpRepo],
  });

  try {
    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));
    await dom.waitIdle();

    assert.equal(dom.doc.body.getAttribute('data-panel-view'), 'full');
    assert.equal(loadState().panelViewMode, 'full');

    // Switch to Lite mode via header button
    dom.doc.querySelector('#panelViewModeGroup button[data-view="lite"]').click();
    await waitFor(() => loadState().panelViewMode === 'lite', 3500, 15, 'switch to lite');
    await dom.waitIdle();
    assert.equal(dom.doc.body.getAttribute('data-panel-view'), 'lite');
    assert.ok(
      dom.doc.querySelector('#liteQuickCard [data-role="drag-handle"][data-block-id="liteQuickCard"]'),
      'liteQuickCard must have a drag handle for reordering in Lite mode'
    );
    assert.deepEqual(loadState().panelBlockOrder.slice(0, 4), [
      'smartProjectBanner',
      'agLiveProgressWrap',
      'smartComposerCard',
      'liteQuickCard',
    ]);

    // Adaptive telemetry polling in Lite requests only core, swarm, hw
    const liteSecList = Array.from(await vm.runInContext('computeActiveTelemetrySections()', dom.ctx));
    assert.deepEqual(liteSecList, ['core', 'swarm', 'hw']);

    // Quick controls inside #liteQuickCard update state & sync active pills
    dom.doc.querySelector('#liteConfirmThresholdGroup button[data-val="ALL"]').click();
    await waitFor(() => loadState().confirmThreshold === 'ALL');
    dom.doc.querySelector('#liteUiDesignGateGroup button[data-val="off"]').click();
    await waitFor(() => loadState().uiDesignPreviewGate === false);
    dom.doc.querySelector('#liteSwarmModeGroup button[data-val="manual_only"]').click();
    await waitFor(() => loadState().swarmMode === 'manual_only');
    await dom.waitIdle();
    assert.equal(
      dom.doc.querySelector('#confirmThresholdGroup button[data-val="ALL"]').classList.contains('active'),
      true
    );
    assert.equal(
      dom.doc.querySelector('#swarmModeGroup button[data-val="manual_only"]').classList.contains('active'),
      true
    );

    // Master toggle pauses & restores RAM+GPU; Lite limit dropdowns update RAM/GPU/CPU limits
    assert.equal(dom.doc.getElementById('composerEngineBadge'), null);
    assert.equal(dom.doc.getElementById('liteRamTogglePill'), null);
    assert.equal(dom.doc.getElementById('liteGpuTogglePill'), null);
    const masterBtn = dom.doc.getElementById('liteRamGpuMasterBtn');
    assert.ok(masterBtn);

    await vm.runInContext('updateState({ ramCacheEnabled: true, gpuEnabled: true })', dom.ctx);
    await waitFor(() => loadState().ramCacheEnabled === true && loadState().gpuEnabled === true, 3500, 15, 'seed ram+gpu on');
    await dom.waitIdle();
    assert.equal(masterBtn.getAttribute('aria-pressed'), 'true');

    masterBtn.click();
    await waitFor(
      () => loadState().ramCacheEnabled === false && loadState().gpuEnabled === false,
      3500,
      15,
      'master pause'
    );
    await dom.waitIdle();
    assert.equal(masterBtn.getAttribute('aria-pressed'), 'false');

    masterBtn.click();
    await waitFor(
      () => loadState().ramCacheEnabled === true && loadState().gpuEnabled === true,
      3500,
      15,
      'master restore'
    );
    await dom.waitIdle();
    assert.equal(masterBtn.getAttribute('aria-pressed'), 'true');

    // Lite limit dropdowns open custom menu and persist changes
    dom.doc.getElementById('btn-liteRamBudget').click();
    assert.equal(dom.doc.getElementById('lgCustomSelectMenu').hidden, false);
    await vm.runInContext('commitCustomSelectOption("sel-liteRamBudget", "2048")', dom.ctx);
    await waitFor(() => loadState().ramMaxBudgetMb === 2048, 3500, 15, 'lite ram 2GB');
    await vm.runInContext('commitCustomSelectOption("sel-liteCpuThreadsCap", "4")', dom.ctx);
    await waitFor(() => loadState().cpuMaxThreads === 4, 3500, 15, 'lite cpu 4t');

    // Wizard Step 1 view mode preview & Escape revert keeps Lite mode
    dom.doc.querySelector('[data-action="openOnboardingWizard"]').click();
    assert.equal(dom.doc.getElementById('onboardingWizardModal').classList.contains('visible'), true);
    dom.doc.querySelector('[data-action="wizSetViewMode"][data-arg="full"]').click();
    assert.equal(dom.doc.body.getAttribute('data-panel-view'), 'full');
    dom.doc.dispatchEvent({ type: 'keydown', key: 'Escape', bubbles: true });
    await waitFor(() => !dom.doc.getElementById('onboardingWizardModal').classList.contains('visible'));
    assert.equal(dom.doc.body.getAttribute('data-panel-view'), 'lite');
    assert.equal(loadState().panelViewMode, 'lite');

    // Lite Sentinel summary + findings + 1-click Fix button dispatches directly to chat
    assert.ok(dom.doc.getElementById('liteSentinelRow'), 'Lite mode must include #liteSentinelRow');
    await vm.runInContext(`
      renderSentinelStatus({
        enabled: true,
        state: 'idle',
        shadowGuard: {
          errorCount: 1,
          warnCount: 0,
          issues: [{ file: 'core/demo.mjs', line: 12, issueRu: 'Несоответствие аргументов', issueEn: 'Argument mismatch' }],
          coChangeAlerts: [],
        },
        bugBot: { findingsCount: 0, findings: [] },
      }, currentState);
    `, dom.ctx);
    const liteFixBtn = dom.doc.getElementById('btnLiteSentinelFix');
    assert.equal(liteFixBtn.style.display, 'inline-flex');
    assert.match(dom.doc.getElementById('liteSentinelSummary').textContent, /1/);
    assert.equal(dom.doc.querySelectorAll('#liteSentinelFindings .lite-sentinel-finding-item').length, 1);
    const msgBeforeLiteFix = dom.sentAgentMessages.length;
    liteFixBtn.click();
    await waitFor(() => dom.sentAgentMessages.length > msgBeforeLiteFix, 3500, 15, 'lite sentinel 1-click fix');
    const lastSentLiteFix = dom.sentAgentMessages[dom.sentAgentMessages.length - 1];
    assert.match(String(lastSentLiteFix?.msg || lastSentLiteFix || ''), /core\/demo\.mjs:L12/);

    // Dark-theme active EN/RU & Lite/Full pill buttons must not use low-contrast --accent-cyan
    assert.equal(
      /\.lang-pill-btn\.active\s*\{[^}]*var\(--accent-cyan\)/.test(html),
      false,
      'Dark-theme .lang-pill-btn.active must not use low-contrast var(--accent-cyan)'
    );

    // Switch back to Full via header button
    dom.doc.querySelector('#panelViewModeGroup button[data-view="full"]').click();
    await waitFor(() => loadState().panelViewMode === 'full', 3500, 15, 'switch back to full');
    assert.equal(dom.doc.body.getAttribute('data-panel-view'), 'full');
  } finally {
    dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 6: Wave 1 UX (Header Drag vs Click, Setup Doctor, Adaptive UI Scale)
// ---------------------------------------------------------------------------

test('6. Wave 1 UX: card header drag vs click collapse, Setup Doctor rescan & auto-collapse, adaptive UI scale 1080p/2K/4K', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-wave1-');
  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp });
  assert.ok(app && app.port > 0);
  const originUrl = `http://127.0.0.1:${app.port}`;

  const htmlRes = await globalThis.fetch(`${originUrl}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();

  const dom = createPanelDomHarness(html, originUrl, 'e2e-token-6', {
    workspaceUris: [tmpRepo],
  });

  try {
    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));
    await dom.waitIdle();

    // Ensure documentElement has style object for --panel-ui-scale
    if (!dom.doc.documentElement) {
      dom.doc.documentElement = {
        style: {},
        setAttribute() {},
      };
    }

    // 1. Card header: regular click collapses/expands collapsible title; drag >= 5px reorders without collapsing
    const composerCard = dom.doc.getElementById('smartComposerCard');
    const skillsCard = dom.doc.getElementById('skillsSectionCard');
    const agentCard = dom.doc.getElementById('agentModeCard');
    const composerTitle = composerCard.querySelector('.lg-card-title');
    const agentTitle = agentCard.querySelector('.lg-card-title');
    assert.ok(composerTitle && agentTitle, 'Collapsible cards must have .lg-card-title');

    assert.equal(composerCard.classList.contains('is-collapsed'), false);
    composerTitle.click();
    assert.equal(composerCard.classList.contains('is-collapsed'), true, 'Regular click on card title must collapse card');
    composerTitle.click();
    assert.equal(composerCard.classList.contains('is-collapsed'), false, 'Second click on card title must expand card');

    // Dragging composerTitle >= 5px must lift and suppress post-drag click collapse
    composerTitle.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      pointerType: 'mouse',
      pointerId: 76,
      clientX: 40,
      clientY: 120,
      bubbles: true,
    });
    dom.windowObj.dispatchEvent({
      type: 'pointermove',
      pointerId: 76,
      clientX: 40,
      clientY: 100,
      bubbles: true,
    });
    assert.equal(composerCard.classList.contains('is-dragging-lift'), true, 'Drag >= 5px from smartComposerCard title must lift card');
    dom.windowObj.dispatchEvent({
      type: 'pointerup',
      pointerId: 76,
      clientX: 40,
      clientY: 100,
      bubbles: true,
    });
    composerTitle.click();
    assert.equal(composerCard.classList.contains('is-collapsed'), false, 'Click immediately after header drag must be suppressed');

    // Dragging agentModeCard above skillsSectionCard (with <5px jitter check first)
    const initialOrder = loadState().panelBlockOrder.slice();
    const skillsIdxBefore = initialOrder.indexOf('skillsSectionCard');
    const agentIdxBefore = initialOrder.indexOf('agentModeCard');
    assert.ok(skillsIdxBefore >= 0 && agentIdxBefore > skillsIdxBefore);

    agentTitle.dispatchEvent({
      type: 'pointerdown',
      button: 0,
      pointerType: 'mouse',
      pointerId: 77,
      clientX: 40,
      clientY: 200,
      bubbles: true,
    });
    // Small jitter (< 5px) must not start dragging
    dom.windowObj.dispatchEvent({
      type: 'pointermove',
      pointerId: 77,
      clientX: 41,
      clientY: 202,
      bubbles: true,
    });
    assert.equal(agentCard.classList.contains('is-dragging-lift'), false);

    // Move above skillsCard midpoint (MiniDOM getBoundingClientRect returns top=20, height=30 -> mid=35)
    dom.windowObj.dispatchEvent({
      type: 'pointermove',
      pointerId: 77,
      clientX: 40,
      clientY: 5,
      bubbles: true,
    });
    assert.equal(agentCard.classList.contains('is-dragging-lift'), true, 'Drag >= 5px from header title must lift card');
    dom.windowObj.dispatchEvent({
      type: 'pointerup',
      pointerId: 77,
      clientX: 40,
      clientY: 5,
      bubbles: true,
    });

    await waitFor(
      () => {
        const ord = loadState().panelBlockOrder;
        return ord.indexOf('agentModeCard') < ord.indexOf('skillsSectionCard');
      },
      3500,
      15,
      'header drag reorder persisted'
    );

    // 2. Setup Doctor: smooth rescan keeps existing DOM + minHeight, close button closes, hook_profile auto-collapses
    await vm.runInContext('loadSetupDoctor()', dom.ctx);
    const doctorBox = dom.doc.getElementById('setupDoctorBox');
    await waitFor(() => Boolean(doctorBox.querySelector('[data-setup-doctor-body]')), 3500, 15, 'setup doctor initial load');
    assert.notEqual(doctorBox.style.display, 'none');
    assert.ok(doctorBox.querySelector('[data-action="closeSetupDoctor"]'), 'Setup Doctor must render explicit close button');

    // Verify rescan does NOT wipe existing body with 1-line placeholder while awaiting response
    const rescanPromise = vm.runInContext(`(() => {
      const box = document.getElementById('setupDoctorBox');
      const p = loadSetupDoctor();
      const bodyStillPresent = Boolean(box.querySelector('[data-setup-doctor-body]'));
      const hasRescanClass = box.classList.contains('is-rescanning');
      const minH = box.style.minHeight;
      return p.then(() => ({ bodyStillPresent, hasRescanClass, minH }));
    })()`, dom.ctx);
    const rescanStats = await rescanPromise;
    assert.equal(rescanStats.bodyStillPresent, true, 'Rescan must preserve existing report DOM until new data arrives');
    assert.equal(rescanStats.hasRescanClass, true, 'Rescan must apply .is-rescanning visual state');
    assert.ok(rescanStats.minH && rescanStats.minH.endsWith('px'), 'Rescan must lock minHeight while scanning');

    // Close button collapses box
    doctorBox.querySelector('[data-action="closeSetupDoctor"]').click();
    assert.equal(doctorBox.style.display, 'none', 'Close button must hide Setup Doctor box');

    // Reopen and apply hook_profile -> must auto-collapse after applying
    await vm.runInContext('loadSetupDoctor()', dom.ctx);
    await waitFor(() => doctorBox.style.display !== 'none' && Boolean(doctorBox.querySelector('[data-action="applySetupDoctorItem"]')));
    await vm.runInContext('applySetupDoctorItem("hook_profile")', dom.ctx);
    await waitFor(() => doctorBox.style.display === 'none', 2500, 20, 'setup doctor auto-collapse after hook_profile');

    // 3. Adaptive UI scale: 1080p / 2K / 4K calculation & header cycle persistence
    const scaleMetrics = await vm.runInContext(`({
      fhd: computeAutoUiScale({ screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 1, innerWidth: 780, innerHeight: 900 }),
      qhd: computeAutoUiScale({ screenWidth: 2560, screenHeight: 1440, devicePixelRatio: 1, innerWidth: 780, innerHeight: 1000 }),
      uhd: computeAutoUiScale({ screenWidth: 3840, screenHeight: 2160, devicePixelRatio: 1, innerWidth: 900, innerHeight: 1200 }),
      uhdNarrow: computeAutoUiScale({ screenWidth: 3840, screenHeight: 2160, devicePixelRatio: 1, innerWidth: 320, innerHeight: 900 }),
    })`, dom.ctx);
    assert.equal(scaleMetrics.fhd, 1);
    assert.equal(scaleMetrics.qhd, 1.12);
    assert.equal(scaleMetrics.uhd, 1.25);
    assert.ok(scaleMetrics.uhdNarrow <= 1.06, 'Narrow sidebar must cap auto UI scale');

    const scaleBtn = dom.doc.getElementById('panelUiScaleBtn');
    assert.ok(scaleBtn, '#panelUiScaleBtn must exist in header');
    scaleBtn.click(); // auto -> 100
    await waitFor(() => loadState().panelUiScale === '100', 3500, 15, 'scale 100');
    scaleBtn.click(); // 100 -> 115
    await waitFor(() => loadState().panelUiScale === '115', 3500, 15, 'scale 115');
    assert.equal(dom.doc.body.getAttribute('data-panel-scale'), '115');
    assert.equal(dom.doc.documentElement.style.getPropertyValue('--panel-ui-scale'), '1.15');
  } finally {
    dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 7: Wave 2 UX — Banner Project Switcher, Unscoped Chats, Waiting-User Click & Open IDE Projects
// ---------------------------------------------------------------------------

test('7. Wave 2 UX: banner workspace switcher, unscoped "Без проекта" chats, waiting_user jump & open IDE project discovery', async () => {
  const { pathToFileURL } = await import('node:url');
  const {
    discoverAntigravityOpenWorkspaces,
    discoverUserProjectsForGraph,
  } = await import('../sidecars/panel/lib/panel-telemetry-collectors.mjs');
  const {
    initTaskProgressFromPrompt,
    resetTaskProgress,
    UNSCOPED_CHAT_PROJECT_RU,
  } = await import('../core/task-progress.mjs');

  const tmpRepoA = makeTempGitRepo('amr-e2e-w2-alpha-');
  const tmpRepoB = makeTempGitRepo('amr-e2e-w2-beta-');
  const tmpStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-e2e-w2-storage-'));
  tempDirs.push(tmpStorageDir);
  const storageJsonPath = path.join(tmpStorageDir, 'storage.json');
  fs.writeFileSync(
    storageJsonPath,
    JSON.stringify({
      windowsState: {
        lastActiveWindow: { folder: pathToFileURL(tmpRepoA).href },
        openedWindows: [
          { folder: pathToFileURL(tmpRepoA).href },
          { folder: pathToFileURL(tmpRepoB).href },
        ],
      },
    }),
    'utf8'
  );

  // 1. Read-only Antigravity storage.json discovery & openWorkspaces URI parsing
  const storageDiscovered = discoverAntigravityOpenWorkspaces({ storagePaths: [storageJsonPath], allowInTests: true });
  assert.equal(storageDiscovered.length, 2);
  assert.ok(storageDiscovered.some((p) => path.resolve(p) === path.resolve(tmpRepoA)));
  assert.ok(storageDiscovered.some((p) => path.resolve(p) === path.resolve(tmpRepoB)));

  const graphProjects = await discoverUserProjectsForGraph({
    activeWs: tmpRepoA,
    autoWs: tmpRepoA,
    openWorkspaces: [pathToFileURL(tmpRepoB).href],
    allowActiveEphemeral: true,
  });
  const betaProj = graphProjects.find((p) => path.resolve(p.workspaceRoot) === path.resolve(tmpRepoB));
  assert.ok(betaProj, 'discoverUserProjectsForGraph must include openWorkspaces file:/// URI');
  assert.equal(betaProj.isOpenInIde, true);
  assert.equal(betaProj.source, 'open_ide');

  // 2. Unscoped chat without workspaceRoot -> "Без проекта" (isUnscopedChat: true)
  resetTaskProgress();
  const unscopedSnap = initTaskProgressFromPrompt({
    conversationId: 'unscoped-chat-wave2',
    workspaceRoot: '',
    userPrompt: 'Объясни разницу между TCP и UDP',
    grade: 'S',
    isReadOnlyQuestion: true,
  });
  const unscopedEntry = (unscopedSnap.activeChats || []).find((c) => c.conversationId === 'unscoped-chat-wave2');
  assert.ok(unscopedEntry, 'Unscoped chat must be tracked in activeChats');
  assert.equal(unscopedEntry.projectName, UNSCOPED_CHAT_PROJECT_RU);
  assert.equal(unscopedEntry.isUnscopedChat, true);
  assert.equal(unscopedEntry.workspaceRoot, '');
  resetTaskProgress();

  // 3. Panel DOM: workspace switcher in #smartProjectBanner, unscoped chats visible when pinned, waiting_user jump
  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp });
  assert.ok(app && app.port > 0);
  const originUrl = `http://127.0.0.1:${app.port}`;
  const htmlRes = await globalThis.fetch(`${originUrl}/`);
  const html = await htmlRes.text();

  const dom = createPanelDomHarness(html, originUrl, 'e2e-token-w2', {
    workspaceUris: [pathToFileURL(tmpRepoA).href, pathToFileURL(tmpRepoB).href],
  });

  try {
    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));
    await dom.waitIdle();

    // Switcher must live inside #smartProjectBanner
    assert.ok(
      dom.doc.querySelector('#smartProjectBanner #panelWorkspaceSelectWrap'),
      '#panelWorkspaceSelectWrap must be embedded in #smartProjectBanner'
    );
    assert.ok(
      dom.doc.querySelector('#smartProjectBanner #sel-panelWorkspace'),
      '#sel-panelWorkspace must live inside #smartProjectBanner'
    );

    // Spy on window.sidecar.ui.toggleConversation
    const toggledCids = [];
    dom.ctx.window.sidecar.ui.toggleConversation = (cid) => {
      toggledCids.push(String(cid));
    };

    // Pin tmpRepoA and render 1 waiting_user unscoped chat + 1 normal running chat in tmpRepoA
    await vm.runInContext(`(() => {
      _selectedWorkspaceMode = ${JSON.stringify(tmpRepoA)};
      renderTaskProgressAndHud({
        status: 'waiting_user',
        projectName: 'alpha',
        workspaceRoot: ${JSON.stringify(tmpRepoA)},
        activeChats: [
          {
            conversationId: 'cid-waiting-unscoped-42',
            chatNumber: 1,
            projectName: 'Без проекта',
            projectNameEn: 'No project',
            isUnscopedChat: true,
            workspaceRoot: '',
            status: 'waiting_user',
            currentStep: 1,
            totalSteps: 2,
            percent: 25,
            stepTitle: 'Ожидание ответа пользователя',
            formattedText: 'Ожидание ответа пользователя',
            steps: [
              { index: 1, title: 'Выбрать вариант', kind: 'question', status: 'waiting_user' },
              { index: 2, title: 'Выполнение', status: 'pending' },
            ],
          },
          {
            conversationId: 'cid-running-alpha-99',
            chatNumber: 2,
            projectName: 'alpha',
            workspaceRoot: ${JSON.stringify(tmpRepoA)},
            status: 'running',
            currentStep: 1,
            totalSteps: 2,
            percent: 45,
            stepTitle: 'Правка кода',
            formattedText: 'Правка кода',
            steps: [
              { index: 1, title: 'Правка кода', status: 'running' },
              { index: 2, title: 'Тесты', status: 'pending' },
            ],
          },
        ],
      }, null, { uiLanguage: 'ru' });
    })()`, dom.ctx);

    const waitingRow = dom.doc.querySelector('.ag-chat-task-item[data-cid="cid-waiting-unscoped-42"]');
    const runningRow = dom.doc.querySelector('.ag-chat-task-item[data-cid="cid-running-alpha-99"]');
    assert.ok(waitingRow, 'Unscoped "Без проекта" chat must remain visible even when another workspace is pinned');
    assert.ok(runningRow, 'Pinned workspace running chat must remain visible');

    // Waiting row capsule & jump button & orange question chip must jump to chat
    const waitingCap = waitingRow.querySelector('.ag-progress-capsule');
    const waitingJumpBtn = waitingRow.querySelector('.ag-waiting-jump-btn');
    const waitingChip = waitingRow.querySelector('.ag-step-chip.question.waiting');
    assert.ok(waitingCap.classList.contains('is-waiting-user'));
    assert.ok(waitingJumpBtn && waitingJumpBtn.style.display !== 'none', 'Waiting row must show jump button');
    assert.equal(waitingChip.getAttribute('data-action'), 'focusWaitingProgressChat');

    waitingJumpBtn.click();
    assert.deepEqual(toggledCids, ['cid-waiting-unscoped-42']);
    waitingChip.click();
    assert.deepEqual(toggledCids, ['cid-waiting-unscoped-42', 'cid-waiting-unscoped-42']);

    // Normal running row must NOT trigger toggleConversation
    const runningCap = runningRow.querySelector('.ag-progress-capsule');
    assert.equal(runningCap.classList.contains('is-waiting-user'), false);
    assert.equal(runningCap.getAttribute('data-action'), null);
    runningCap.click();
    assert.equal(toggledCids.length, 2, 'Clicking normal running chat row must not call toggleConversation');
  } finally {
    dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 8: Wave 3 UX — Persistent Pull Errors, HF Mirror, Onboarding Dir Picker & Auto-Install
// ---------------------------------------------------------------------------

test('8. Wave 3 UX: persistent pull errors, HF mirror toggle, onboarding folder picker, Ollama install status & focusFile chat', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-w3-repo-');
  const customInstallDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-e2e-w3-ollama-'));
  tempDirs.push(customInstallDir);

  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({ SidecarAppClass: TestSidecarApp, rootDir: tmpRepo });
  let dom = null;

  try {
    assert.ok(app && app.port > 0);
    const originUrl = `http://127.0.0.1:${app.port}`;

    // 1) Folder picker endpoint supports dryRun and path validation cleanly without opening native dialog
    const dryRes = await globalThis.fetch(`${originUrl}/api/gpu/pick-folder`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true, mode: 'ollama' }),
    });
    const dryJson = await dryRes.json();
    assert.equal(dryJson.ok, true);
    assert.equal(dryJson.cancelled, true);

    const pathRes = await globalThis.fetch(`${originUrl}/api/gpu/pick-folder`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: customInstallDir, mode: 'ollama' }),
    });
    const pathJson = await pathRes.json();
    assert.equal(pathJson.ok, true);
    assert.equal(pathJson.dir, path.resolve(customInstallDir));

    // Isolate GPU state from prior tests before asserting skippedGpuDisabled
    const gpuOffRes = await globalThis.fetch(`${originUrl}/api/update`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ gpuEnabled: false }),
    });
    assert.equal(gpuOffRes.ok, true);

    // 2) /api/local-chat accepts focusFile gracefully
    const lcRes = await globalThis.fetch(`${originUrl}/api/local-chat`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Объясни файл', focusFile: 'app.mjs' }),
    });
    const lcJson = await lcRes.json();
    assert.equal(lcJson.skippedGpuDisabled, true);

    const htmlRes = await globalThis.fetch(`${originUrl}/`);
    const html = await htmlRes.text();
    dom = createPanelDomHarness(html, originUrl, 'e2e-token-w3');

    await waitFor(() => dom.doc.getElementById('footerPluginVersion').textContent.includes(PKG_VERSION));
    await dom.waitIdle();

    // 3) Persistent Ollama pull error box MUST stay visible even when finishedAt > 120s ago
    await vm.runInContext(`(() => {
      const oldTs = Date.now() - 120000;
      renderGpuCascadePullStatus({
        active: false,
        finishedAt: oldTs,
        totalCount: 2,
        completedCount: 1,
        source: 'ollama',
        error: 'TLS handshake timeout',
        statusTextRu: 'Завершено с ошибками (1/2)',
        statusTextEn: 'Completed with errors (1/2)',
        items: [
          { name: 'qwen3:4b', status: 'done', percent: 100, source: 'ollama' },
          { name: 'qwen3-embedding:4b', status: 'error', percent: 0, error: 'TLS handshake timeout', hfAvailable: true },
        ],
      }, { ollama: { installed: true, running: true } }, { gpuEnabled: true });
    })()`, dom.ctx);

    const pullBox = dom.doc.getElementById('gpuCascadePullBox');
    assert.equal(pullBox.style.display, 'flex', 'Pull error box must stay persistently visible even >60s after error');
    assert.ok(pullBox.classList.contains('is-error'), 'Pull box must carry .is-error class');
    assert.ok(dom.doc.getElementById('gpuCascadePullErrorItems').innerHTML.includes('qwen3-embedding:4b'));
    assert.equal(dom.doc.getElementById('gpuCascadePullActions').style.display, 'flex');
    assert.equal(dom.doc.getElementById('btnRetryGpuCascadeHf').style.display, 'inline-flex');

    dom.doc.getElementById('btnDismissGpuPullError').click();
    await waitFor(() => dom.doc.getElementById('gpuCascadePullBox').style.display === 'none');
    await dom.waitIdle();

    // 4) Ollama install box shows when Ollama is missing & gpuEnabled is true
    await vm.runInContext(`(() => {
      renderGpuOllamaInstallStatus(null, { ollama: { installed: false, running: false } }, {
        gpuEnabled: true,
        gpuOllamaDir: ${JSON.stringify(customInstallDir)},
        gpuModelsDir: ${JSON.stringify(path.join(customInstallDir, 'models'))},
      });
    })()`, dom.ctx);
    assert.equal(dom.doc.getElementById('gpuOllamaInstallBox').style.display, 'flex');
    assert.ok(dom.doc.getElementById('gpuOllamaInstallDirHint').textContent.includes(customInstallDir));

    // 5) Onboarding Step 1 shows directory input, auto-install toggle & HF mirror checkbox and saves them
    await vm.runInContext(`(() => {
      currentHardwareProfile = {
        system: { cpuModel: 'Test CPU', logicalCores: 8, totalRamMb: 16384, totalRamGb: 16 },
        gpu: { available: true, name: 'RTX 4060', totalMb: 8192 },
        ollama: { installed: false, running: false },
        recommendation: {
          recommendedPatch: { gpuEnabled: true, gpuMaxVramMb: 8192, gpuChatModel: 'qwen3:4b', gpuEmbedModel: 'qwen3-embedding:4b' },
          gpuEnabledPreset: { gpuMaxVramMb: 8192, gpuChatModel: 'qwen3:4b', gpuEmbedModel: 'qwen3-embedding:4b' },
          cascadeBundle: { models: [{ name: 'qwen3:4b', alreadyDownloaded: false }], approxMissingDiskGb: 2.5 },
        },
      };
      openOnboardingWizard(1);
      wizDraft.useGpu = true;
      wizDraft.autoInstallOllama = true;
      wizDraft.gpuPreferHfMirror = true;
      wizSetGpuInstallDir(${JSON.stringify(customInstallDir)});
      renderWizardStep();
    })()`, dom.ctx);

    const wizDirInp = dom.doc.getElementById('wizGpuInstallDir');
    assert.ok(wizDirInp && wizDirInp.value === customInstallDir, 'Onboarding Step 1 must render #wizGpuInstallDir');
    assert.ok(dom.doc.getElementById('wizBtnPickGpuDir'), 'Onboarding Step 1 must render folder picker button');
    assert.ok(dom.doc.getElementById('inp-gpuOllamaDir'), 'Expert settings must include #inp-gpuOllamaDir');

    // Save wizard cleanly (prevent live install_ollama network spawn by stubbing fetch for /api/gpu)
    const wizardActions = await vm.runInContext(`(async () => {
      const gpuInstallCalls = [];
      const origStartOllama = startOllamaInstall;
      startOllamaInstall = async (opts) => {
        gpuInstallCalls.push(opts);
      };
      try {
        await finishOnboardingWizard();
      } finally {
        startOllamaInstall = origStartOllama;
      }
      return gpuInstallCalls;
    })()`, dom.ctx);

    await dom.waitIdle();
    const st = loadState();
    assert.equal(st.gpuOllamaDir, customInstallDir);
    assert.equal(st.gpuModelsDir, path.join(customInstallDir, 'models'));
    assert.equal(st.gpuPreferHfMirror, true);
    assert.equal(wizardActions.length, 1, 'Wizard finish must auto-trigger Ollama installer when GPU=on & Ollama missing');
    assert.equal(wizardActions[0].installDir, customInstallDir);
    assert.equal(wizardActions[0].mirrorMode, 'huggingface');
  } finally {
    if (dom) dom.destroy();
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// E2E Test 9: Wave 4 UX — GitHub Update Auto-Check, Top Banner, 1-Click Apply & Dismiss
// ---------------------------------------------------------------------------

test('9. Wave 4 UX: startup update check shows top banner, 1-click apply transitions via polling, EN/RU & dismiss', async () => {
  const tmpRepo = makeTempGitRepo('amr-e2e-w4-repo-');
  const tmpPluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-e2e-w4-plugin-'));
  tempDirs.push(tmpPluginRoot);
  fs.writeFileSync(
    path.join(tmpPluginRoot, 'plugin.json'),
    JSON.stringify({ name: 'antigravity-model-router', version: PKG_VERSION }, null, 2),
    'utf8'
  );

  let advertisedVersion = '9.99.0';
  let failNextApply = false;
  const checkCalls = [];
  let updateStatus = {
    ok: true,
    active: false,
    phase: 'idle',
    percent: 0,
    needsRestart: false,
    statusText: '',
    statusTextRu: '',
    statusTextEn: '',
    error: '',
    dismissed: false,
  };
  let mockDoneTimer = null;

  const updateHandlers = {
    checkForPluginUpdate: async ({ force = false } = {}) => {
      checkCalls.push({ force });
      const hasUpdate = Boolean(advertisedVersion && advertisedVersion !== PKG_VERSION);
      return {
        ok: true,
        skipped: false,
        repo: 'vaszuevvas-coder/antigravity-model-router',
        currentVersion: PKG_VERSION,
        latestVersion: advertisedVersion || PKG_VERSION,
        updateAvailable: hasUpdate,
        releaseUrl: hasUpdate ? `https://github.com/vaszuevvas-coder/antigravity-model-router/releases/tag/v${advertisedVersion}` : '',
        downloadUrl: hasUpdate ? `https://codeload.github.com/vaszuevvas-coder/antigravity-model-router/zip/refs/tags/v${advertisedVersion}` : '',
        releaseNotes: hasUpdate ? 'Wave 4 release notes' : '',
        source: 'release',
        checkedAt: Date.now(),
      };
    },
    getPluginUpdateStatus: () => ({ ...updateStatus }),
    applyPluginUpdate: async ({ targetVersion = advertisedVersion } = {}) => {
      if (failNextApply) {
        failNextApply = false;
        updateStatus = {
          ok: false,
          active: false,
          phase: 'error',
          percent: 25,
          targetVersion: targetVersion || advertisedVersion,
          needsRestart: false,
          statusText: 'HTTP 503',
          statusTextRu: 'HTTP 503',
          statusTextEn: 'HTTP 503',
          error: 'HTTP 503',
          dismissed: false,
        };
        return { ...updateStatus };
      }
      updateStatus = {
        ok: true,
        active: true,
        phase: 'downloading',
        percent: 35,
        targetVersion: targetVersion || advertisedVersion,
        needsRestart: false,
        statusText: `Скачивание v${targetVersion || advertisedVersion}...`,
        statusTextRu: `Скачивание v${targetVersion || advertisedVersion}...`,
        statusTextEn: `Downloading v${targetVersion || advertisedVersion}...`,
        error: '',
        dismissed: false,
      };
      if (mockDoneTimer) clearTimeout(mockDoneTimer);
      mockDoneTimer = setTimeout(() => {
        updateStatus = {
          ok: true,
          active: false,
          phase: 'done',
          percent: 100,
          targetVersion: targetVersion || advertisedVersion,
          needsRestart: true,
          statusText: `Обновлено до v${targetVersion || advertisedVersion} ✓ Перезапустите Google Antigravity.`,
          statusTextRu: `Обновлено до v${targetVersion || advertisedVersion} ✓ Перезапустите Google Antigravity.`,
          statusTextEn: `Updated to v${targetVersion || advertisedVersion} ✓ Restart Google Antigravity to apply.`,
          error: '',
          dismissed: false,
        };
      }, 80);
      if (typeof mockDoneTimer.unref === 'function') mockDoneTimer.unref();
      return { ...updateStatus };
    },
    clearPluginUpdateStatus: () => {
      updateStatus = {
        ok: true,
        active: false,
        phase: 'idle',
        percent: 0,
        needsRestart: false,
        statusText: '',
        statusTextRu: '',
        statusTextEn: '',
        error: '',
        dismissed: true,
      };
      return { ...updateStatus };
    },
  };

  const TestSidecarApp = createTestSidecarAppClass();
  const app = await startSidecarPanel({
    SidecarAppClass: TestSidecarApp,
    rootDir: tmpRepo,
    pluginRoot: tmpPluginRoot,
    updateHandlers,
  });
  let dom = null;

  try {
    assert.ok(app && app.port > 0);
    const originUrl = `http://127.0.0.1:${app.port}`;
    await globalThis.fetch(`${originUrl}/api/update`, {
      method: 'POST',
      headers: { Origin: originUrl, 'X-Router-Panel': 'antigravity-v38', 'Content-Type': 'application/json' },
      body: JSON.stringify({ uiLanguage: 'ru', onboardingCompleted: true }),
    });

    const htmlRes = await globalThis.fetch(`${originUrl}/`);
    const html = await htmlRes.text();
    dom = createPanelDomHarness(html, originUrl, 'e2e-token-w4');

    // 1) Startup check reveals #pluginUpdateBanner at very top of .lg-shell (above .lg-header) & #headerUpdateDot
    await waitFor(() => dom.doc.getElementById('pluginUpdateBanner').style.display === 'flex', 5000, 15, 'update banner visible');
    const shellChildren = Array.from(dom.doc.querySelector('.lg-shell').children);
    const bannerIdx = shellChildren.indexOf(dom.doc.getElementById('pluginUpdateBanner'));
    const headerIdx = shellChildren.indexOf(dom.doc.querySelector('.lg-shell > .lg-header'));
    assert.ok(bannerIdx !== -1 && headerIdx !== -1 && bannerIdx < headerIdx, 'Update banner must appear above .lg-header inside .lg-shell');
    assert.ok(checkCalls.length >= 1 && checkCalls[0].force === false);
    assert.equal(dom.doc.getElementById('headerUpdateDot').style.display, 'inline-block');
    assert.ok(dom.doc.getElementById('checkPluginUpdateBtn').classList.contains('has-update'));
    assert.ok(dom.doc.getElementById('pluginUpdateBannerText').textContent.includes('9.99.0'));

    // 2) Live EN <-> RU language switch translates #pluginUpdateBanner cleanly
    dom.doc.querySelector('#uiLanguageGroup button[data-lang="en"]').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateBannerText').textContent.includes('New version v9.99.0'));
    assert.ok(dom.doc.getElementById('pluginUpdateReleaseLink').textContent.includes('What\'s new'));
    dom.doc.querySelector('#uiLanguageGroup button[data-lang="ru"]').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateBannerText').textContent.includes('Доступна версия v9.99.0'));

    // 3) Click Apply -> blurs panel & opens #pluginUpdateOverlay with progress, then transitions to done & restart notice
    dom.doc.getElementById('pluginUpdateApplyBtn').click();
    assert.equal(dom.doc.getElementById('pluginUpdateOverlay').style.display, 'flex');
    assert.equal(dom.doc.body.classList.contains('is-plugin-updating'), true);
    assert.ok(dom.doc.getElementById('pluginUpdateProgressFill').style.width.endsWith('%'));

    await waitFor(
      () => dom.doc.getElementById('pluginUpdateBanner').classList.contains('is-done')
        && dom.doc.getElementById('pluginUpdateOverlay').classList.contains('is-done'),
      5000,
      20,
      'update banner & overlay reach is-done'
    );
    assert.ok(dom.doc.getElementById('pluginUpdateBannerText').textContent.includes('Перезапустите Google Antigravity'));
    assert.ok(dom.doc.getElementById('pluginUpdateOverlayDesc').textContent.includes('Перезагрузите Google Antigravity'));
    assert.equal(dom.doc.getElementById('headerUpdateDot').style.display, 'none');

    // Close overlay keeps top restart reminder banner visible and removes blur
    dom.doc.getElementById('pluginUpdateOverlayCloseBtn').click();
    assert.equal(dom.doc.getElementById('pluginUpdateOverlay').style.display, 'none');
    assert.equal(dom.doc.body.classList.contains('is-plugin-updating'), false);
    assert.equal(dom.doc.getElementById('pluginUpdateBanner').style.display, 'flex');

    // 4) Dismiss banner hides #pluginUpdateBanner
    dom.doc.getElementById('pluginUpdateDismissBtn').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateBanner').style.display === 'none');

    // 5) Manual header button click forces re-check & surfaces next version, and error state shows in blur overlay
    advertisedVersion = '9.99.1';
    dom.doc.getElementById('checkPluginUpdateBtn').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateBanner').style.display === 'flex', 5000, 20, 'manual check re-opens banner');
    assert.ok(checkCalls.some((c) => c.force === true), 'Manual click must call ?force=1');
    assert.ok(dom.doc.getElementById('pluginUpdateBannerText').textContent.includes('9.99.1'));

    failNextApply = true;
    dom.doc.getElementById('pluginUpdateApplyBtn').click();
    await waitFor(
      () => dom.doc.getElementById('pluginUpdateOverlay').classList.contains('is-error'),
      5000,
      20,
      'error overlay visible'
    );
    assert.equal(dom.doc.body.classList.contains('is-plugin-updating'), true);
    assert.ok(dom.doc.getElementById('pluginUpdateOverlayError').textContent.includes('HTTP 503'));
    assert.equal(dom.doc.getElementById('pluginUpdateOverlayRetryBtn').style.display, 'inline-flex');
    dom.doc.getElementById('pluginUpdateOverlayCloseBtn').click();
    assert.equal(dom.doc.getElementById('pluginUpdateOverlay').style.display, 'none');
    assert.equal(dom.doc.body.classList.contains('is-plugin-updating'), false);
    dom.doc.getElementById('pluginUpdateDismissBtn').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateBanner').style.display === 'none');

    // 6) Manual header button click when up-to-date shows floating toast & translates RU <-> EN
    advertisedVersion = PKG_VERSION;
    dom.doc.getElementById('checkPluginUpdateBtn').click();
    await waitFor(
      () => dom.doc.getElementById('pluginUpdateToast').style.display === 'flex'
        && dom.doc.getElementById('pluginUpdateToast').classList.contains('is-ok'),
      5000,
      20,
      'up-to-date toast visible'
    );
    assert.equal(dom.doc.getElementById('pluginUpdateBanner').style.display, 'none');
    assert.ok(dom.doc.getElementById('pluginUpdateToastText').textContent.includes('Доступных обновлений нет'));

    dom.doc.querySelector('#uiLanguageGroup button[data-lang="en"]').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateToastText').textContent.includes('No updates available'));
    dom.doc.querySelector('#uiLanguageGroup button[data-lang="ru"]').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateToastText').textContent.includes('Доступных обновлений нет'));

    dom.doc.getElementById('pluginUpdateToastCloseBtn').click();
    await waitFor(() => dom.doc.getElementById('pluginUpdateToast').style.display === 'none');

    await dom.waitIdle();
  } finally {
    if (mockDoneTimer) clearTimeout(mockDoneTimer);
    if (dom) dom.destroy();
    await app.close();
  }
});


