/**
 * @file panel-security.mjs
 * @description Loopback host/origin/workspace validation, HTTP middleware, and parent/LS watchdog.
 */

import { existsSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';

export const BLOCKED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);

export function isAllowedLoopbackEndpoint(rawUrl = '') {
  if (typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.includes('\0')) return false;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = String(u.hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export function isValidWorkspaceDir(dir = '') {
  if (typeof dir !== 'string') return false;
  const trimmed = dir.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.includes('\0') || trimmed.startsWith('-')) {
    return false;
  }
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => BLOCKED_PROTO_KEYS.has(p))) return false;
  try {
    const resolved = resolve(trimmed);
    return existsSync(resolved) && statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

export function isAllowedLoopbackHost(hostHeader = '') {
  if (typeof hostHeader !== 'string') return false;
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed || trimmed.length > 128) return false;
  let hostname = trimmed;
  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing === -1) return false;
    hostname = trimmed.slice(1, closing);
  } else {
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) hostname = trimmed.slice(0, colonIdx);
  }
  hostname = hostname.replace(/\.$/, '');
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

export function validateRequestOrigin(req, options = {}) {
  if (!req || typeof req !== 'object') return false;
  const headers = req.headers || {};
  const getHdr = (name) => {
    const target = String(name || '').toLowerCase();
    if (typeof headers.get === 'function') return headers.get(name) ?? headers.get(target);
    if (headers[target] !== undefined) return headers[target];
    if (headers[name] !== undefined) return headers[name];
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === target) return v;
    }
    return undefined;
  };

  const method = String(req.method || '').trim().toUpperCase();
  const isReadMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (isReadMethod && !options.enforceGetOrigin) {
    return true;
  }

  const rawPanelHdr = getHdr('x-router-panel');
  const panelHdrStr = rawPanelHdr === undefined || rawPanelHdr === null ? '' : String(rawPanelHdr).trim();
  if (panelHdrStr !== '' && panelHdrStr !== 'antigravity-v38' && panelHdrStr !== 'antigravity-v37') {
    return false;
  }
  const hasValidPanelHdr = panelHdrStr === 'antigravity-v38' || panelHdrStr === 'antigravity-v37';
  const secFetchSite = String(getHdr('sec-fetch-site') || '').trim().toLowerCase();
  const hasSidecarAuth = Boolean(
    getHdr('x-sidecar-token') ||
    getHdr('x-antigravity-token') ||
    getHdr('authorization') ||
    secFetchSite === 'same-origin'
  );

  const isWebviewScheme = (proto) =>
    proto === 'vscode-webview:' ||
    proto === 'vscode-file:' ||
    proto === 'tauri:' ||
    proto === 'antigravity:' ||
    proto === 'antigravity-panel:' ||
    proto === 'app:' ||
    proto === 'electron:' ||
    proto === 'file:';

  const isLoopbackHttpUrl = (raw) => {
    try {
      const u = new URL(String(raw));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch {
      return false;
    }
  };

  const isPost = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const rawOrigin = getHdr('origin');
  if (rawOrigin === undefined || rawOrigin === null || rawOrigin === '') {
    const rawReferer = getHdr('referer');
    if (!rawReferer) {
      if (secFetchSite === 'cross-site' && !hasValidPanelHdr && !hasSidecarAuth) return false;
      return true;
    }
    try {
      const refUrl = new URL(String(rawReferer));
      if (isWebviewScheme(refUrl.protocol) || isLoopbackHttpUrl(rawReferer)) {
        return isPost ? (hasValidPanelHdr || hasSidecarAuth || secFetchSite !== 'cross-site') : true;
      }
      return false;
    } catch {
      return false;
    }
  }

  const originStr = String(rawOrigin).trim();
  if (!originStr) return false;
  if (originStr.toLowerCase() === 'null') {
    return isPost ? (hasValidPanelHdr || hasSidecarAuth) : true;
  }
  try {
    const u = new URL(originStr);
    if (isWebviewScheme(u.protocol)) {
      return isPost ? (hasValidPanelHdr || hasSidecarAuth) : true;
    }
    if (isLoopbackHttpUrl(originStr)) {
      return isPost ? (hasValidPanelHdr || hasSidecarAuth) : true;
    }
    return false;
  } catch {
    return false;
  }
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function attachSidecarSecurityMiddleware(server, options = {}) {
  if (!server || typeof server.listeners !== 'function' || typeof server.on !== 'function') {
    return server;
  }
  const maxBodyBytes = Math.max(1024, Number(options.maxBodyBytes) || 1024 * 1024);
  const origListeners = server.listeners('request').slice();
  server.removeAllListeners('request');

  server.on('request', (req, res) => {
    const rawHost = req.headers?.host;
    const fwdHost = req.headers?.['x-forwarded-host'];
    const hostOk = typeof rawHost === 'string' && isAllowedLoopbackHost(rawHost);
    const fwdOk = fwdHost === undefined || isAllowedLoopbackHost(String(fwdHost));
    if (!hostOk || !fwdOk) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden host' }));
      return;
    }

    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
      return;
    }

    const isApiRoute = pathname.startsWith('/api/') || pathname.startsWith('/_sidecar/');
    if (!validateRequestOrigin(req, { enforceGetOrigin: isApiRoute })) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden origin' }));
      return;
    }

    const contentLength = Number(req.headers?.['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
      res.end(JSON.stringify({ ok: false, error: 'Payload Too Large' }));
      try { req.destroy(); } catch {}
      return;
    }

    let receivedBytes = 0;
    let payloadRejected = false;
    const isJsonWrite = isApiRoute && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH');
    const bodyChunks = isJsonWrite ? [] : null;
    const origEmit = req.emit.bind(req);
    req.emit = function guardedEmit(event, ...args) {
      if (payloadRejected) return false;
      if (event === 'data' && args[0] !== undefined) {
        const chunkBuf = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(String(args[0]), 'utf8');
        receivedBytes += chunkBuf.length;
        if (receivedBytes > maxBodyBytes) {
          payloadRejected = true;
          if (!res.headersSent) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
            res.end(JSON.stringify({ ok: false, error: 'Payload Too Large' }));
          }
          try { req.destroy(); } catch {}
          return false;
        }
        if (bodyChunks) bodyChunks.push(chunkBuf);
      } else if (event === 'end' && bodyChunks && receivedBytes > 0) {
        try {
          JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
        } catch {
          payloadRejected = true;
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid JSON payload' }));
          }
          return false;
        }
      }
      return origEmit(event, ...args);
    };

    for (const listener of origListeners) {
      listener.call(server, req, res);
    }
  });

  return server;
}

export function parseLoopbackHostPort(rawAddress = '') {
  if (typeof rawAddress !== 'string') return null;
  const trimmed = rawAddress.trim();
  if (!trimmed || trimmed.length > 256 || trimmed.includes('\0')) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const u = new URL(withScheme);
    let host = String(u.hostname || '').toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
    const port = Number(u.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

export function probeLoopbackTcpPort(host, port, timeoutMs = 1500) {
  return new Promise((resolveProbe) => {
    let settled = false;
    let socket = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (socket) {
        try { socket.destroy(); } catch {}
      }
      resolveProbe(ok);
    };
    try {
      socket = net.createConnection({ host, port });
      socket.setTimeout(Math.max(200, Number(timeoutMs) || 1500));
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export function startSidecarHostWatchdog({
  lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS || '',
  initialPpid = process.ppid,
  getCurrentPpidFn = () => process.ppid,
  isPidAliveFn = isPidAlive,
  probeTcpFn = probeLoopbackTcpPort,
  intervalMs = 8000,
  maxConsecutiveFailures = 2,
  warmupDelayMs = 500,
  onHostLost = () => {},
} = {}) {
  const endpoint = parseLoopbackHostPort(lsAddress);
  const pollMs = Math.max(250, Number(intervalMs) || 8000);
  const failLimit = Math.max(1, Number(maxConsecutiveFailures) || 2);
  let stopped = false;
  let inFlight = false;
  let lsEverReachable = false;
  let lsFailures = 0;
  let timer = null;
  let warmupTimer = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (warmupTimer) {
      clearTimeout(warmupTimer);
      warmupTimer = null;
    }
  };

  const checkOnce = async () => {
    if (stopped || inFlight) return { alive: !stopped, skipped: true };

    if (Number.isInteger(initialPpid) && initialPpid > 1) {
      let curPpid = initialPpid;
      try {
        curPpid = getCurrentPpidFn();
      } catch {}
      if (curPpid !== initialPpid || !isPidAliveFn(initialPpid)) {
        stop();
        try { onHostLost('parent_dead'); } catch {}
        return { alive: false, reason: 'parent_dead' };
      }
    }

    if (!endpoint) {
      return { alive: true, reason: 'no_ls_endpoint' };
    }

    inFlight = true;
    let reachable = false;
    try {
      reachable = Boolean(await probeTcpFn(endpoint.host, endpoint.port, 1500));
    } catch {
      reachable = false;
    } finally {
      inFlight = false;
    }

    if (stopped) return { alive: false, skipped: true };

    if (reachable) {
      lsEverReachable = true;
      lsFailures = 0;
      return { alive: true, reason: 'ls_tcp_ok' };
    }

    lsFailures += 1;
    const threshold = lsEverReachable ? failLimit : Math.max(failLimit, 3);
    if (lsFailures >= threshold) {
      stop();
      try { onHostLost('ls_unreachable'); } catch {}
      return { alive: false, reason: 'ls_unreachable', failures: lsFailures };
    }

    return { alive: true, reason: 'ls_probe_retry', failures: lsFailures };
  };

  timer = setInterval(() => {
    void checkOnce();
  }, pollMs);
  if (typeof timer.unref === 'function') timer.unref();

  if (warmupDelayMs >= 0) {
    warmupTimer = setTimeout(() => {
      warmupTimer = null;
      void checkOnce();
    }, Math.max(0, Number(warmupDelayMs) || 0));
    if (typeof warmupTimer.unref === 'function') warmupTimer.unref();
  }

  return {
    stop,
    checkOnce,
    getState: () => ({ stopped, lsEverReachable, lsFailures, endpoint }),
  };
}
