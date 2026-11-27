/**
 * @file graph-and-contracts.mjs
 * @description Cross-file [T1] manifest/casing, [T2] import/export/cycle/orphan/Blast Radius,
 *              [T3] .env.example drift, [T4] cross-file floating promises, and [T5] UI-API & DOM contract verifier.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

const BUILTIN_SET = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => (m.startsWith('node:') ? m : `node:${m}`)),
]);

const CODE_EXT_PROBES = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.mts', '.cts', '.d.ts', '.d.mts', '.d.cts', '.json', '.py'];

const STANDARD_RUNTIME_ENV_IGNORE = new Set([
  'NODE_ENV', 'PATH', 'HOME', 'USER', 'USERPROFILE', 'HOMEPATH', 'HOMEDRIVE', 'TEMP', 'TMP', 'TMPDIR',
  'PORT', 'HOST', 'HOSTNAME', 'PWD', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'CI', 'DEBUG',
  'GITHUB_ACTIONS', 'GITHUB_WORKSPACE', 'GITHUB_TOKEN', 'OS', 'COMSPEC', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'NVM_SYMLINK', 'VOLTA_HOME', 'NPM_CONFIG_PREFIX', 'npm_lifecycle_event',
]);

const FIXTURE_OR_SAMPLE_PATH_RE = /(?:^|\/)(?:__tests__|fixtures?|playground|examples?|docs_src)\//i;

function toPosixRel(rootDir, absPath) {
  return relative(rootDir, absPath).replace(/\\/g, '/');
}

function getPkgName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (specifier.startsWith('node:') || BUILTIN_SET.has(specifier)) return null;
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}

function getDirEntriesCaseSet(dirPath, dirEntriesCache) {
  if (dirEntriesCache.has(dirPath)) return dirEntriesCache.get(dirPath);
  const s = new Set();
  try {
    for (const e of readdirSync(dirPath)) s.add(e);
  } catch {}
  dirEntriesCache.set(dirPath, s);
  return s;
}

function checkCaseExactPath(rootDir, absCandidate, dirEntriesCache) {
  const rel = relative(rootDir, absCandidate);
  if (!rel || rel.startsWith('..')) return { exact: true };
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let cur = rootDir;
  for (const seg of parts) {
    const entries = getDirEntriesCaseSet(cur, dirEntriesCache);
    if (!entries.has(seg)) {
      const ciHit = Array.from(entries).find((e) => e.toLowerCase() === seg.toLowerCase());
      if (ciHit) {
        return { exact: false, expected: ciHit, actual: seg };
      }
      return { exact: true };
    }
    cur = join(cur, seg);
  }
  return { exact: true };
}

function resolveRelativeTarget(rootDir, importerAbs, specifier, relMap, dirEntriesCache) {
  const baseDir = dirname(importerAbs);
  const cleanSpec = String(specifier || '').split('?')[0].split('#')[0].replace(/\\/g, '/').trim();
  if (!cleanSpec) return null;
  const rawTarget = resolve(baseDir, cleanSpec);
  const candidates = [rawTarget];

  // TS ESM convention: import './foo.js' -> './foo.ts' / './foo.tsx' / './foo.d.ts'
  const rawExt = extname(rawTarget).toLowerCase();
  if (rawExt === '.js' || rawExt === '.mjs' || rawExt === '.cjs') {
    const stem = rawTarget.slice(0, -rawExt.length);
    if (rawExt === '.js') candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, `${stem}.jsx`);
    else if (rawExt === '.mjs') candidates.push(`${stem}.mts`, `${stem}.d.mts`);
    else if (rawExt === '.cjs') candidates.push(`${stem}.cts`, `${stem}.d.cts`);
  }

  for (const ext of CODE_EXT_PROBES) {
    candidates.push(`${rawTarget}${ext}`);
  }
  for (const ext of CODE_EXT_PROBES) {
    candidates.push(join(rawTarget, `index${ext}`));
  }

  for (const cand of candidates) {
    const relPosix = toPosixRel(rootDir, cand);
    if (relMap.has(relPosix) || existsSync(cand)) {
      const caseRes = checkCaseExactPath(rootDir, cand, dirEntriesCache);
      return { resolvedAbs: cand, resolvedRel: relPosix, caseMismatch: caseRes.exact ? null : caseRes };
    }
  }
  return null;
}

function resolvePythonTarget(rootDir, importerAbs, specifier, relMap) {
  if (!specifier.startsWith('.')) return null;
  const dots = specifier.match(/^\.+/)?.[0].length || 1;
  const modPart = specifier.slice(dots).replace(/\./g, '/');
  let baseDir = dirname(importerAbs);
  for (let i = 1; i < dots; i++) baseDir = dirname(baseDir);

  const candidates = modPart
    ? [join(baseDir, `${modPart}.py`), join(baseDir, modPart, '__init__.py')]
    : [join(baseDir, '__init__.py')];

  for (const cand of candidates) {
    const relPosix = toPosixRel(rootDir, cand);
    if (relMap.has(relPosix) || existsSync(cand)) {
      return { resolvedAbs: cand, resolvedRel: relPosix, caseMismatch: null };
    }
  }
  return null;
}

function collectPackageJsonTargets(pkg, pkgDir) {
  const refs = [];
  const checkStr = (field, val) => {
    if (typeof val === 'string' && val.trim() && !val.startsWith('node:')) {
      refs.push({ field, path: val.trim() });
    }
  };
  checkStr('main', pkg.main);
  checkStr('module', pkg.module);
  checkStr('types', pkg.types || pkg.typings);
  if (typeof pkg.bin === 'string') checkStr('bin', pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [k, v] of Object.entries(pkg.bin)) checkStr(`bin.${k}`, v);
  }
  const walkExports = (prefix, node) => {
    if (!node) return;
    if (typeof node === 'string') {
      if (!node.includes('*')) checkStr(prefix, node);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        walkExports(`${prefix}.${k}`, v);
      }
    }
  };
  if (pkg.exports) walkExports('exports', pkg.exports);

  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [sName, cmd] of Object.entries(pkg.scripts)) {
      if (typeof cmd !== 'string') continue;
      const nodeHead = cmd.match(/\bnode\s+([^\r\n&|;]+)/i);
      if (nodeHead) {
        const parts = nodeHead[1].trim().split(/\s+/);
        for (const rawTok of parts) {
          if (/^--[a-z0-9-]+(?:=[^\s]+)?$/i.test(rawTok)) continue;
          const cleanTok = rawTok.replace(/^['"]|['"]$/g, '');
          if (cleanTok && !cleanTok.startsWith('-') && /\.(?:m?js|cjs)$/i.test(cleanTok) && !/[*?\[]/.test(cleanTok)) {
            refs.push({ field: `scripts.${sName}`, path: cleanTok, pkgDir });
          }
          break;
        }
      }
    }
  }
  return refs;
}

function computeTransitiveExports(relPath, relMap, resolvedEdges, visiting = new Set(), memoCache = null) {
  if (memoCache && memoCache.has(relPath)) return memoCache.get(relPath);
  if (visiting.has(relPath)) return { named: new Set(), hasDefault: false, isDynamic: false, _cycle: true };
  const info = relMap.get(relPath);
  if (!info || !info.exports) return { named: new Set(), hasDefault: false, isDynamic: false };

  visiting.add(relPath);
  try {
    const named = new Set(info.exports.namedExports || []);
    const hasDefault = Boolean(info.exports.hasDefaultExport);
    let isDynamic = Boolean(info.exports.isDynamicCjsExports);
    let hitCycle = false;

    if (info.exports.hasStarReExport && Array.isArray(info.exports.reExportSpecifiers)) {
      const outMap = resolvedEdges.get(relPath);
      for (const spec of info.exports.reExportSpecifiers) {
        const targetRel = outMap?.get(spec);
        if (targetRel) {
          const sub = computeTransitiveExports(targetRel, relMap, resolvedEdges, visiting, memoCache);
          for (const s of sub.named) named.add(s);
          if (sub.isDynamic) isDynamic = true;
          if (sub._cycle) hitCycle = true;
        } else {
          isDynamic = true;
        }
      }
    }
    const res = { named, hasDefault, isDynamic };
    if (memoCache && !hitCycle) memoCache.set(relPath, res);
    return res;
  } finally {
    visiting.delete(relPath);
  }
}

function findCircularDependencies(adjMap) {
  // Tarjan SCC + canonical shortest cycle extraction per SCC
  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];

  function strongConnect(v) {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const neighbors = adjMap.get(v) || [];
    for (const w of neighbors) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const comp = [];
      while (true) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length >= 2) {
        sccs.push(comp);
      } else if (comp.length === 1 && (adjMap.get(v) || []).includes(v)) {
        sccs.push([v]);
      }
    }
  }

  for (const node of adjMap.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }

  // Build one readable cycle chain per SCC
  const cycles = [];
  for (const comp of sccs) {
    const compSet = new Set(comp);
    const start = comp.slice().sort()[0];
    const queue = [[start]];
    const seen = new Set([start]);
    let foundChain = null;
    while (queue.length > 0 && !foundChain) {
      const pathArr = queue.shift();
      const tail = pathArr[pathArr.length - 1];
      for (const nxt of adjMap.get(tail) || []) {
        if (!compSet.has(nxt)) continue;
        if (nxt === start && pathArr.length >= 2) {
          foundChain = [...pathArr, start];
          break;
        }
        if (nxt === start && pathArr.length === 1) {
          foundChain = [start, start];
          break;
        }
        if (!seen.has(nxt)) {
          seen.add(nxt);
          queue.push([...pathArr, nxt]);
        }
      }
    }
    cycles.push(foundChain || [...comp, comp[0]]);
  }
  return cycles;
}

function matchBackendRoute(frontRoute, backendEntries) {
  const cleanFront = frontRoute.split('?')[0];
  for (const br of backendEntries) {
    if (br.isPrefix && cleanFront.startsWith(br.route)) return true;
    const normBackend = br.route.replace(/:[A-Za-z0-9_]+|\{[A-Za-z0-9_]+\}|\*/g, '[^/]+');
    if (br.route === cleanFront) return true;
    try {
      const re = new RegExp(`^${normBackend}/?$`);
      if (re.test(cleanFront)) return true;
    } catch {}
    // Fastify/Express sub-router relative prefix match if route ends with /
    if (cleanFront.endsWith(br.route) && br.route.length > 1) return true;
  }
  return false;
}

/**
 * Runs cross-file verification across all audited file summaries.
 */
export function analyzeCrossFileAndContracts({ rootDir, dirEntriesCache, manifests, rootPkg, fileResults }) {
  const findings = [];
  const relMap = new Map();
  for (const fr of fileResults) {
    if (fr?.relPath) relMap.set(fr.relPath, fr);
  }

  // [T1] Validate package.json manifests (main, module, types, bin, exports, node scripts)
  const declaredPkgDeps = new Set();
  for (const pkgPath of manifests.packageJsonPaths) {
    const pkgDir = dirname(pkgPath);
    const pkgRel = toPosixRel(rootDir, pkgPath);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch {
      continue;
    }
    for (const depMap of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
      if (depMap && typeof depMap === 'object') {
        for (const k of Object.keys(depMap)) declaredPkgDeps.add(k);
      }
    }
    for (const ref of collectPackageJsonTargets(pkg, pkgDir)) {
      if (!ref.path.startsWith('.') && !ref.field.startsWith('scripts.')) continue;
      const absTarget = resolve(pkgDir, ref.path);
      const existsInPkg = existsSync(absTarget);
      const existsInWorkspaceRoot = !existsInPkg && ref.field.startsWith('scripts.') && pkgDir !== rootDir && existsSync(resolve(rootDir, ref.path));
      if (!existsInPkg && !existsInWorkspaceRoot) {
        const hasBuildScript = Object.keys(pkg.scripts || {}).some((k) => /^(?:build|compile|gen:|prepack)/i.test(k));
        const hasSourceEntry =
          existsSync(join(pkgDir, 'src')) ||
          existsSync(join(pkgDir, 'index.ts')) ||
          existsSync(join(pkgDir, 'index.tsx')) ||
          existsSync(join(pkgDir, 'index.mts')) ||
          existsSync(join(pkgDir, 'index.js')) ||
          existsSync(join(pkgDir, 'index.mjs'));
        const isUnbuiltBuildOutputTarget =
          !ref.field.startsWith('scripts.') &&
          /^\.?\/?(?:dist|build|out|lib|esm|cjs|types|umd|\.next)(?:\/|$)/i.test(ref.path) &&
          (hasSourceEntry || hasBuildScript);
        if (isUnbuiltBuildOutputTarget) continue;
        const isSampleManifest = FIXTURE_OR_SAMPLE_PATH_RE.test(pkgRel);
        findings.push({
          tier: 'T1',
          ruleId: 'BROKEN_MANIFEST_TARGET',
          severity: isSampleManifest ? 'INFO' : 'HIGH',
          cwe: 'CWE-426',
          confidence: isSampleManifest ? 0.6 : 0.96,
          file: pkgRel,
          line: 1,
          message: `package.json '${ref.field}' points to missing path '${ref.path}'`,
          evidence: ref.path,
        });
      }
    }
  }

  // [T2] Resolve imports, build adjacency graph, check exports, packages & floating imported async calls
  const adjMap = new Map();
  const reverseDeps = new Map();
  const resolvedEdges = new Map();
  const usedNpmPackages = new Set();
  const importsEdgesToCheck = [];

  for (const fr of fileResults) {
    adjMap.set(fr.relPath, []);
    if (!reverseDeps.has(fr.relPath)) reverseDeps.set(fr.relPath, new Set());
    resolvedEdges.set(fr.relPath, new Map());
  }

  const hasTsconfigPaths = Array.from(manifests.tsconfigPaths || []).some((tp) => {
    try { return readFileSync(tp, 'utf8').includes('"paths"'); } catch { return false; }
  });

  for (const fr of fileResults) {
    const outSet = new Set();
    for (const imp of fr.imports || []) {
      const spec = imp.specifier;
      if (!spec) continue;

      if (imp.kind === 'py') {
        if (spec.startsWith('.')) {
          const hit = resolvePythonTarget(rootDir, fr.file, spec, relMap);
          if (!hit) {
            findings.push({
              tier: 'T2',
              ruleId: 'BROKEN_RELATIVE_IMPORT',
              severity: 'HIGH',
              cwe: 'CWE-1059',
              confidence: 0.9,
              file: fr.relPath,
              line: imp.line,
              message: `Unresolved Python relative import '${spec}'`,
              evidence: spec,
            });
          } else {
            outSet.add(hit.resolvedRel);
            if (!reverseDeps.has(hit.resolvedRel)) reverseDeps.set(hit.resolvedRel, new Set());
            reverseDeps.get(hit.resolvedRel).add(fr.relPath);
            resolvedEdges.get(fr.relPath).set(spec, hit.resolvedRel);
          }
        }
        continue;
      }

      if (spec.startsWith('.') || spec.startsWith('/')) {
        if (spec.startsWith('/')) continue; // web public asset path
        const hit = resolveRelativeTarget(rootDir, fr.file, spec, relMap, dirEntriesCache);
        if (!hit) {
          findings.push({
            tier: 'T2',
            ruleId: 'BROKEN_RELATIVE_IMPORT',
            severity: 'HIGH',
            cwe: 'CWE-1059',
            confidence: 0.94,
            file: fr.relPath,
            line: imp.line,
            message: `Unresolved relative module import '${spec}'`,
            evidence: spec,
          });
          continue;
        }
        if (hit.caseMismatch) {
          findings.push({
            tier: 'T1',
            ruleId: 'IMPORT_CASE_MISMATCH',
            severity: 'HIGH',
            cwe: 'CWE-178',
            confidence: 0.97,
            file: fr.relPath,
            line: imp.line,
            message: `Import path casing mismatch: '${hit.caseMismatch.actual}' vs disk '${hit.caseMismatch.expected}' (breaks Linux CI)`,
            evidence: spec,
          });
        }
        if (!imp.isTypeOnly) {
          // Only static ESM/CJS imports create eager load-time circular dependency edges; dynamic import() is lazy
          if (imp.kind !== 'dynamic') {
            outSet.add(hit.resolvedRel);
          }
          if (!reverseDeps.has(hit.resolvedRel)) reverseDeps.set(hit.resolvedRel, new Set());
          reverseDeps.get(hit.resolvedRel).add(fr.relPath);
          resolvedEdges.get(fr.relPath).set(spec, hit.resolvedRel);
          importsEdgesToCheck.push({ importer: fr, imp, targetRel: hit.resolvedRel });
        } else {
          // Lazy dynamic import: still check target existence/casing and Blast Radius, without treating as eager cycle edge
          if (!reverseDeps.has(hit.resolvedRel)) reverseDeps.set(hit.resolvedRel, new Set());
          reverseDeps.get(hit.resolvedRel).add(fr.relPath);
        }
      } else {
        const pkgName = getPkgName(spec);
        if (pkgName) {
          usedNpmPackages.add(pkgName);
          if (rootPkg && !fr.isTestFile && declaredPkgDeps.size > 0 && !declaredPkgDeps.has(pkgName) && !pkgName.startsWith('@types/') && !spec.startsWith('@/')) {
            // Only flag when root package.json exists and no tsconfig path alias matches
            if (!hasTsconfigPaths) {
              findings.push({
                tier: 'T2',
                ruleId: 'MISSING_DEPENDENCY',
                severity: 'HIGH',
                cwe: 'CWE-1357',
                confidence: 0.85,
                file: fr.relPath,
                line: imp.line,
                message: `Package '${pkgName}' imported in code is not declared in package.json`,
                evidence: spec,
              });
            }
          }
        }
      }
    }
    adjMap.set(fr.relPath, Array.from(outSet));
  }

  // Export contract check (named & default) + cross-file floating promises
  const STATIC_ASSET_EXTS = new Set(['.json', '.css', '.scss', '.sass', '.less', '.txt', '.html', '.htm', '.svg', '.md', '.mdx', '.wasm', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2']);
  const transitiveExportCache = new Map();
  for (const { importer, imp, targetRel } of importsEdgesToCheck) {
    const targetInfo = relMap.get(targetRel);
    if (!targetInfo || !targetInfo.exports) continue;
    const ext = extname(targetRel).toLowerCase();
    if (STATIC_ASSET_EXTS.has(ext) || /[?&](?:raw|url|inline|worker|sharedworker)\b/i.test(String(imp.specifier || ''))) continue;

    const expMeta = computeTransitiveExports(targetRel, relMap, resolvedEdges, new Set(), transitiveExportCache);

    // Cross-file async call check
    if (targetInfo.asyncFunctions?.length > 0 && importer.bareCalls?.length > 0) {
      const importedMap = new Map();
      for (const ni of imp.namedImports || []) {
        if (targetInfo.asyncFunctions.includes(ni.imported)) importedMap.set(ni.local, ni.imported);
      }
      for (const bc of importer.bareCalls) {
        if (importedMap.has(bc.callee)) {
          findings.push({
            tier: 'T4',
            ruleId: 'FLOATING_PROMISE',
            severity: 'HIGH',
            cwe: 'CWE-252',
            confidence: 0.89,
            file: importer.relPath,
            line: bc.line,
            message: `Imported async function '${bc.callee}()' from '${targetRel}' called without await or .catch()`,
            evidence: bc.snippet,
          });
        }
      }
    }

    if (expMeta.isDynamic) continue;

    if (imp.hasDefaultImport && !expMeta.hasDefault && ext !== '.cjs' && ext !== '.js' && ext !== '.svelte' && ext !== '.vue') {
      findings.push({
        tier: 'T2',
        ruleId: 'MISSING_DEFAULT_EXPORT',
        severity: 'HIGH',
        cwe: 'CWE-1059',
        confidence: 0.9,
        file: importer.relPath,
        line: imp.line,
        message: `Default import from '${targetRel}' which has no 'export default'`,
        evidence: imp.specifier,
      });
    }

    for (const ni of imp.namedImports || []) {
      if (ni.imported === 'default') continue;
      if (!expMeta.named.has(ni.imported)) {
        findings.push({
          tier: 'T2',
          ruleId: 'BROKEN_NAMED_EXPORT',
          severity: 'HIGH',
          cwe: 'CWE-1059',
          confidence: 0.91,
          file: importer.relPath,
          line: imp.line,
          message: `Imported symbol '${ni.imported}' is not exported by '${targetRel}'`,
          evidence: `import { ${ni.imported} } from '${imp.specifier}'`,
        });
      }
    }
  }

  // Circular dependencies
  const cycles = findCircularDependencies(adjMap);
  for (const chain of cycles) {
    const isFixtureCycle = chain.every((node) => FIXTURE_OR_SAMPLE_PATH_RE.test(node));
    findings.push({
      tier: 'T2',
      ruleId: 'CIRCULAR_DEPENDENCY',
      severity: isFixtureCycle ? 'INFO' : (chain.length <= 3 ? 'HIGH' : 'MEDIUM'),
      cwe: 'CWE-1047',
      confidence: isFixtureCycle ? 0.65 : 0.95,
      file: chain[0],
      line: 1,
      message: `Circular module dependency cycle detected (${chain.length - 1} hops)`,
      evidence: chain.join(' -> '),
    });
  }

  // Unused dependencies in root package.json (advisory INFO)
  if (rootPkg?.dependencies && typeof rootPkg.dependencies === 'object') {
    const scriptsJoined = JSON.stringify(rootPkg.scripts || {});
    for (const dep of Object.keys(rootPkg.dependencies)) {
      if (!usedNpmPackages.has(dep) && !scriptsJoined.includes(dep) && !dep.startsWith('@types/')) {
        findings.push({
          tier: 'T2',
          ruleId: 'UNUSED_DEPENDENCY',
          severity: 'INFO',
          cwe: 'CWE-1164',
          confidence: 0.72,
          file: 'package.json',
          line: 1,
          message: `Declared runtime dependency '${dep}' has no static import/require references`,
          evidence: dep,
        });
      }
    }
  }

  // Orphan module detection (non-entry code modules with 0 reverseDeps & not referenced in manifests/HTML/tests)
  const manifestRawText = manifests.packageJsonPaths
    .map((p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } })
    .join('\n');
  const htmlRawText = fileResults
    .filter((f) => f.ext === '.html' || f.ext === '.htm')
    .map((f) => `${f.relPath} `)
    .join('\n');

  for (const fr of fileResults) {
    if (fr.isTestFile) continue;
    if (!['javascript', 'typescript', 'python'].includes(fr.language)) continue;
    const revCount = reverseDeps.get(fr.relPath)?.size || 0;
    const base = basename(fr.relPath).toLowerCase();
    const isLikelyEntry =
      /^(?:index|main|app|server|cli|install|setup|run|worker|mcp|hook|mod|lib|__init__|manage)\./i.test(base) ||
      fr.relPath.includes('/routes/') ||
      fr.relPath.includes('/pages/') ||
      fr.relPath.includes('/app/') ||
      fr.relPath.includes('/scripts/') ||
      /(?:^|\/)(?:docs_src|docs|examples?|tutorials?|playground|fixtures?|benchmarks?|samples?|demos?)\//i.test(fr.relPath) ||
      manifestRawText.includes(base) ||
      htmlRawText.includes(base);
    if (revCount === 0 && !isLikelyEntry && (fr.exports?.namedExports?.length > 0 || fr.exports?.hasDefaultExport)) {
      findings.push({
        tier: 'T2',
        ruleId: 'ORPHAN_MODULE',
        severity: 'INFO',
        cwe: 'CWE-561',
        confidence: 0.7,
        file: fr.relPath,
        line: 1,
        message: 'Exported module has 0 incoming imports from other project files',
        evidence: `exports: ${(fr.exports?.namedExports || []).slice(0, 4).join(', ') || 'default'}`,
      });
    }
    if ((fr.language === 'javascript' || fr.language === 'typescript') && fr.file && existsSync(fr.file)) {
      try {
        const srcText = readFileSync(fr.file, 'utf8');
        const shallowRes = detectShallowPassThroughModule(srcText, fr.relPath);
        if (shallowRes.isShallow) {
          findings.push({
            tier: 'T2',
            ruleId: 'SHALLOW_PASS_THROUGH_WRAPPER',
            severity: 'LOW',
            cwe: 'CWE-1061',
            confidence: 0.8,
            file: fr.relPath,
            line: 1,
            message: `Shallow module: all ${shallowRes.wrapperCount} exported functions are 1-line pass-through wrappers (Ousterhout deep-module heuristic)`,
            evidence: shallowRes.exports.slice(0, 4).join(', '),
          });
        }
      } catch {}
    }
  }

  // Blast Radius Hubs
  const blastRadiusHubs = fileResults
    .filter((f) => !f.isTestFile && ['javascript', 'typescript', 'python', 'go', 'rust'].includes(f.language))
    .map((f) => {
      const rDeps = reverseDeps.get(f.relPath)?.size || 0;
      const oDeps = adjMap.get(f.relPath)?.length || 0;
      const cc = f.cyclomatic || 1;
      const hubScore = Number(((rDeps + 0.5) * Math.log2(2 + cc)).toFixed(2));
      return {
        file: f.relPath,
        reverseDeps: rDeps,
        outDeps: oDeps,
        cyclomaticComplexity: cc,
        linesCount: f.linesCount || 0,
        hubScore,
      };
    })
    .filter((h) => h.reverseDeps > 0 || h.cyclomaticComplexity >= 15)
    .sort((a, b) => b.hubScore - a.hubScore || b.reverseDeps - a.reverseDeps)
    .slice(0, 8);

  // [T3] .env.example drift
  if (manifests.envExamplePaths.length > 0) {
    const documentedKeys = new Set();
    const primaryExampleRel = toPosixRel(rootDir, manifests.envExamplePaths[0]);
    for (const ep of manifests.envExamplePaths) {
      try {
        for (const line of readFileSync(ep, 'utf8').split(/\r?\n/)) {
          const m = line.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/);
          if (m) documentedKeys.add(m[1]);
        }
      } catch {}
    }
    const seenUndoc = new Set();
    for (const fr of fileResults) {
      if (fr.isTestFile) continue;
      for (const ev of fr.envVars || []) {
        if (STANDARD_RUNTIME_ENV_IGNORE.has(ev.name) || documentedKeys.has(ev.name) || seenUndoc.has(ev.name)) continue;
        seenUndoc.add(ev.name);
        findings.push({
          tier: 'T3',
          ruleId: 'ENV_EXAMPLE_DRIFT',
          severity: 'MEDIUM',
          cwe: 'CWE-1188',
          confidence: 0.84,
          file: fr.relPath,
          line: ev.line,
          message: `Environment variable '${ev.name}' used in code is missing from ${primaryExampleRel}`,
          evidence: ev.name,
        });
      }
    }
  }

  // [T5] UI-API, IPC & DOM ID contracts
  const allBackendRoutes = [];
  const allIpcHandlers = new Set();
  const allStaticHtmlIds = new Set();
  const allDynamicIds = new Set();

  // Discover Next.js filesystem API routes
  for (const fr of fileResults) {
    const nextAppApi = fr.relPath.match(/^(?:src\/)?app\/(api\/.+?)\/route\.[jt]sx?$/);
    if (nextAppApi) allBackendRoutes.push({ route: `/${nextAppApi[1]}`, isPrefix: false });
    const nextPagesApi = fr.relPath.match(/^(?:src\/)?pages\/(api\/.+?)\.[jt]sx?$/);
    if (nextPagesApi) allBackendRoutes.push({ route: `/${nextPagesApi[1].replace(/\/index$/, '')}`, isPrefix: false });

    const sig = fr.uiApi;
    if (!sig) continue;
    for (const r of sig.backendRoutes || []) allBackendRoutes.push(r);
    for (const ch of sig.ipcHandlers || []) allIpcHandlers.add(ch.channel);
    for (const hid of sig.htmlIds || []) allStaticHtmlIds.add(hid);
    for (const did of sig.dynamicDomIds || []) allDynamicIds.add(did);
  }

  if (allBackendRoutes.length > 0) {
    for (const fr of fileResults) {
      for (const fc of fr.uiApi?.frontendCalls || []) {
        if (!matchBackendRoute(fc.route, allBackendRoutes)) {
          findings.push({
            tier: 'T5',
            ruleId: 'BROKEN_API_CONTRACT',
            severity: 'HIGH',
            cwe: 'CWE-1059',
            confidence: 0.86,
            file: fr.relPath,
            line: fc.line,
            message: `Frontend calls API endpoint '${fc.route}' which has no matching backend route handler`,
            evidence: fc.route,
          });
        }
      }
    }
  }

  if (allIpcHandlers.size > 0) {
    for (const fr of fileResults) {
      for (const snd of fr.uiApi?.ipcSenders || []) {
        if (!allIpcHandlers.has(snd.channel)) {
          findings.push({
            tier: 'T5',
            ruleId: 'BROKEN_IPC_CONTRACT',
            severity: 'HIGH',
            cwe: 'CWE-1059',
            confidence: 0.88,
            file: fr.relPath,
            line: snd.line,
            message: `Renderer sends/invokes IPC channel '${snd.channel}' with no matching ipcMain handler`,
            evidence: snd.channel,
          });
        }
      }
    }
  }

  if (allStaticHtmlIds.size >= 2) {
    for (const fr of fileResults) {
      for (const ref of fr.uiApi?.domRefs || []) {
        if (!allStaticHtmlIds.has(ref.id) && !allDynamicIds.has(ref.id)) {
          findings.push({
            tier: 'T5',
            ruleId: 'MISSING_DOM_ID',
            severity: 'MEDIUM',
            cwe: 'CWE-1059',
            confidence: 0.82,
            file: fr.relPath,
            line: ref.line,
            message: `JS queries DOM element '#${ref.id}' not found in project HTML/templates or dynamic assignments`,
            evidence: `#${ref.id}`,
          });
        }
      }
    }
  }

  return { findings, blastRadiusHubs };
}

/**
 * Detects Ousterhout shallow pass-through wrapper modules (all exports merely forward identical args 1:1).
 * Ignores barrel re-exports, entry/server/types/constants files, and modules outside 12..60 non-empty lines.
 * @param {string} [content='']
 * @param {string} [relPath='']
 * @returns {{ isShallow: boolean, wrapperCount: number, exports: string[] }}
 */
export function detectShallowPassThroughModule(content = '', relPath = '') {
  const cleanRel = String(relPath || '').replace(/\\/g, '/');
  if (
    /(?:^|\/)(?:index|main|cli|server|types|constants)\.[cm]?[jt]sx?$/i.test(cleanRel) ||
    /\.d\.[cm]?ts$/i.test(cleanRel) ||
    /(?:^|\/)(?:tests?|__tests__|fixtures?)\//i.test(cleanRel) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(cleanRel)
  ) {
    return { isShallow: false, wrapperCount: 0, exports: [] };
  }

  const text = typeof content === 'string' ? content : String(content || '');
  if (/\bexport\s+(?:\*|\{[^}]+\})\s+from\b/.test(text)) {
    return { isShallow: false, wrapperCount: 0, exports: [] };
  }

  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
  if (nonEmptyLines.length < 12 || nonEmptyLines.length > 60) {
    return { isShallow: false, wrapperCount: 0, exports: [] };
  }
  if (/\b(?:class|switch|for|while)\b/.test(text)) {
    return { isShallow: false, wrapperCount: 0, exports: [] };
  }

  const fnExportRe = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]{0,120})\)\s*\{([^}]{1,220})\}/g;
  const arrowExportRe = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]{0,120})\)\s*=>\s*(?:\{([^}]{1,220})\}|([^;\n]{1,180}))/g;
  const parsedExports = [];

  const checkPassThroughBody = (paramsRaw, bodyRaw, isExprArrow = false) => {
    const paramNames = String(paramsRaw || '')
      .split(',')
      .map((p) => p.trim().replace(/\s*=.*$/, '').replace(/:.*$/, '').trim())
      .filter(Boolean);
    const body = String(bodyRaw || '').trim().replace(/;\s*$/, '');
    const callExpr = isExprArrow ? body : (body.match(/^return\s+(?:await\s+)?(.+)$/)?.[1] || '');
    const callMatch = /^([A-Za-z_$][\w$.]*)\s*\(([^()]*)\)$/.exec(callExpr.trim());
    if (!callMatch) return false;
    const passedArgs = String(callMatch[2] || '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (paramNames.length === 0 || passedArgs.length !== paramNames.length) return false;
    return paramNames.every((p, idx) => passedArgs[idx] === p);
  };

  let m;
  while ((m = fnExportRe.exec(text)) !== null) {
    parsedExports.push({ name: m[1], isPassThrough: checkPassThroughBody(m[2], m[3], false) });
  }
  while ((m = arrowExportRe.exec(text)) !== null) {
    const body = m[3] !== undefined ? m[3] : m[4];
    parsedExports.push({ name: m[1], isPassThrough: checkPassThroughBody(m[2], body, m[3] === undefined) });
  }

  if (parsedExports.length < 2) {
    return { isShallow: false, wrapperCount: 0, exports: [] };
  }
  const allShallow = parsedExports.every((e) => e.isPassThrough);
  return {
    isShallow: allShallow,
    wrapperCount: allShallow ? parsedExports.length : 0,
    exports: parsedExports.map((e) => e.name),
  };
}
