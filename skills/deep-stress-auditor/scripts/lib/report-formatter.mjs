/**
 * @file report-formatter.mjs
 * @description Deduplicates, ranks (CRITICAL -> HIGH -> MEDIUM -> INFO) and formats compact JSON/Markdown audit reports.
 */

const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };

function getBlockingSeverities(failOn = 'high') {
  const mode = String(failOn || 'high').toLowerCase();
  if (mode === 'none') return new Set();
  if (mode === 'critical') return new Set(['CRITICAL']);
  if (mode === 'medium') return new Set(['CRITICAL', 'HIGH', 'MEDIUM']);
  return new Set(['CRITICAL', 'HIGH']);
}

export function buildAuditReport(opts = {}) {
  const {
    targetDir = '.',
    profile = 'fast',
    elapsedMs = 0,
    scannedFiles = 0,
    truncated = false,
    maxFiles = 5000,
    stack = {},
    blastRadiusHubs = [],
    nativeTools = [],
    rawFindings = [],
    failOn = 'high',
    maxOutputFindings = 80,
  } = opts && typeof opts === 'object' ? opts : {};
  const dedup = new Map();
  for (const f of rawFindings || []) {
    if (!f || !f.ruleId) continue;
    const key = `${f.file || ''}::${f.line || 1}::${f.ruleId}::${f.evidence || ''}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        tier: f.tier || 'T1',
        ruleId: f.ruleId,
        severity: f.severity || 'INFO',
        cwe: f.cwe || 'CWE-1006',
        confidence: Number(Number(f.confidence || 0.8).toFixed(2)),
        file: f.file || '',
        line: Number(f.line || 1),
        message: String(f.message || '').slice(0, 200),
        evidence: String(f.evidence || '').slice(0, 160),
      });
    }
  }

  const sorted = Array.from(dedup.values()).sort((a, b) => {
    const sa = SEV_ORDER[a.severity] ?? 9;
    const sb = SEV_ORDER[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`);
  });

  const summary = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0, total: sorted.length };
  for (const f of sorted) {
    if (summary[f.severity] !== undefined) summary[f.severity]++;
  }

  const blocking = getBlockingSeverities(failOn);
  const failedFiles = new Set(sorted.filter((f) => blocking.has(f.severity)).map((f) => f.file));
  const blockingCount = sorted.filter((f) => blocking.has(f.severity)).length;
  const passed = blockingCount === 0;

  const shownFindings = sorted.slice(0, maxOutputFindings);
  const truncatedCount = Math.max(0, sorted.length - shownFindings.length);

  return {
    status: passed ? 'PASSED' : 'FAILED',
    target: targetDir,
    profile,
    elapsedMs: Math.round(elapsedMs),
    scanned: scannedFiles,
    truncated: Boolean(truncated),
    maxFiles,
    passed: Math.max(0, scannedFiles - failedFiles.size),
    failed: blockingCount,
    stack,
    summary,
    blastRadiusHubs: (blastRadiusHubs || []).slice(0, 8),
    nativeTools: nativeTools || [],
    findings: shownFindings,
    truncatedCount,
  };
}

export function formatCliMarkdownReport(report) {
  const lines = [];
  const langs = report.stack?.languages?.join(', ') || 'none';
  const fws = report.stack?.frameworks?.length ? ` | frameworks: ${report.stack.frameworks.join(', ')}` : '';
  lines.push(`# Deep Stress Audit: ${report.status} (${report.profile}, ${report.elapsedMs}ms)`);
  lines.push(`Target: ${report.target}`);
  lines.push(`Stack: [${langs}]${fws} | Files: ${report.scanned}${report.truncated ? ` (capped at ${report.maxFiles})` : ''}`);
  lines.push(
    `Summary: CRITICAL=${report.summary.CRITICAL} HIGH=${report.summary.HIGH} MEDIUM=${report.summary.MEDIUM} INFO=${report.summary.INFO}`
  );

  if (report.nativeTools?.length > 0) {
    lines.push(`Native Contour B: ${report.nativeTools.map((t) => `${t.tool}(exit=${t.exitCode})`).join(', ')}`);
  }

  if (report.blastRadiusHubs?.length > 0) {
    lines.push('\n## Top Blast Radius Hubs');
    for (const h of report.blastRadiusHubs.slice(0, 5)) {
      lines.push(`- ${h.file} (revDeps=${h.reverseDeps}, CC=${h.cyclomaticComplexity}, lines=${h.linesCount}, score=${h.hubScore})`);
    }
  }

  if (report.findings.length > 0) {
    lines.push('\n## Findings (Ranked)');
    for (const f of report.findings) {
      const ev = f.evidence ? ` | ${f.evidence}` : '';
      lines.push(`[${f.severity} | ${f.tier} ${f.ruleId} | ${f.cwe} | conf:${f.confidence}] ${f.file}:${f.line} — ${f.message}${ev}`);
    }
    if (report.truncatedCount > 0) {
      lines.push(`... (${report.truncatedCount} lower-priority findings omitted)`);
    }
  } else {
    lines.push('\nNo issues detected.');
  }
  return lines.join('\n');
}
