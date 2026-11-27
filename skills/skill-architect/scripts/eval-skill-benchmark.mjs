/**
 * @file eval-skill-benchmark.mjs
 * @description Deterministic `agentskills.io` A/B Eval Harness (`evals/evals.json`, `grading.json`, `timing.json`, `benchmark.json`).
 * Supports initializing `evals/evals.json`, grading `with_skill` vs `without_skill` output directories against
 * objective assertions, and aggregating pass-rate & token-delta benchmarks at 0 cloud tokens.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateEvalsSchema(doc = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: ['evals.json root must be an object'] };
  }
  const errors = [];
  if (!doc.skill_name || typeof doc.skill_name !== 'string') {
    errors.push('Missing required string field `skill_name`');
  }
  if (!Array.isArray(doc.evals) || doc.evals.length === 0) {
    errors.push('Field `evals` must be a non-empty array of test cases');
  } else {
    doc.evals.forEach((ev, idx) => {
      if (!ev || typeof ev !== 'object') {
        errors.push(`evals[${idx}] must be an object`);
        return;
      }
      if (!ev.prompt || typeof ev.prompt !== 'string') {
        errors.push(`evals[${idx}] missing string \`prompt\``);
      }
      if (!ev.expected_output || typeof ev.expected_output !== 'string') {
        errors.push(`evals[${idx}] missing string \`expected_output\``);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

export function initSkillEvalsTemplate(skillDir, { overwrite = false } = {}) {
  const absDir = resolve(skillDir);
  const slug = basename(absDir);
  const evalsDir = join(absDir, 'evals');
  const evalsPath = join(evalsDir, 'evals.json');
  if (existsSync(evalsPath) && !overwrite) {
    return { ok: false, exists: true, evalsPath, reason: 'evals.json already exists' };
  }
  mkdirSync(evalsDir, { recursive: true });
  const template = {
    skill_name: slug,
    evals: [
      {
        id: 1,
        prompt: `Apply ${slug} workflow on a realistic repository input and verify the output.`,
        expected_output: 'Structured, verified output matching the skill specification with zero placeholders.',
        files: [],
        assertions: [
          'file_exists:*',
          'not_contains:TODO',
        ],
      },
    ],
  };
  writeFileSync(evalsPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return { ok: true, evalsPath, template };
}

function collectOutputFiles(outputsDir) {
  if (!outputsDir || !existsSync(outputsDir)) return [];
  const out = [];
  for (const name of readdirSync(outputsDir)) {
    const full = join(outputsDir, name);
    try {
      const st = statSync(full);
      if (st.isFile()) {
        const text = st.size <= 512_000 ? readFileSync(full, 'utf8') : '';
        out.push({ name, full, size: st.size, text });
      }
    } catch {}
  }
  return out;
}

/**
 * Grades an `outputs/` directory against programmatic or keyword assertions, producing `agentskills.io` `grading.json`.
 * Supported structured prefixes: `file_exists:<name|*>`, `valid_json:<name>`, `contains:<str>`, `not_contains:<str>`, `regex:<pat>`,
 * plus natural-language fallback keyword matching.
 */
export function gradeOutputsAgainstAssertions(outputsDir, assertions = []) {
  const files = collectOutputFiles(outputsDir);
  const combinedText = files.map((f) => f.text).join('\n');
  const results = [];

  for (const rawRule of assertions || []) {
    const rule = String(rawRule || '').trim();
    if (!rule) continue;
    let passed = false;
    let evidence = '';

    if (rule.startsWith('file_exists:')) {
      const target = rule.slice('file_exists:'.length).trim();
      const hit = target === '*' ? files[0] : files.find((f) => f.name === target);
      passed = Boolean(hit);
      evidence = hit ? `Found ${hit.name} (${hit.size}B)` : `Missing output file "${target}"`;
    } else if (rule.startsWith('valid_json:')) {
      const target = rule.slice('valid_json:'.length).trim();
      const hit = target === '*' ? files.find((f) => f.name.endsWith('.json')) : files.find((f) => f.name === target);
      if (!hit) {
        passed = false;
        evidence = `JSON file "${target}" not found`;
      } else {
        try {
          JSON.parse(hit.text);
          passed = true;
          evidence = `Parsed valid JSON in ${hit.name} (${hit.size}B)`;
        } catch (err) {
          passed = false;
          evidence = `Invalid JSON in ${hit.name}: ${err.message}`;
        }
      }
    } else if (rule.startsWith('contains:')) {
      const needle = rule.slice('contains:'.length);
      passed = combinedText.includes(needle);
      evidence = passed ? `Matched "${needle}" in outputs` : `Substring "${needle}" absent from outputs`;
    } else if (rule.startsWith('not_contains:')) {
      const needle = rule.slice('not_contains:'.length);
      passed = files.length > 0 && !combinedText.includes(needle);
      evidence = files.length === 0 ? 'No output files generated' : passed ? `Verified "${needle}" absent` : `Forbidden "${needle}" present`;
    } else if (rule.startsWith('regex:')) {
      try {
        const rx = new RegExp(rule.slice('regex:'.length), 'im');
        const m = rx.exec(combinedText);
        passed = Boolean(m);
        evidence = m ? `Matched /${rx.source}/: "${String(m[0]).slice(0, 60)}"` : `Regex /${rx.source}/ did not match`;
      } catch (rxErr) {
        passed = false;
        evidence = `Invalid regex pattern: ${rxErr.message}`;
      }
    } else {
      if (/valid\s+json/i.test(rule)) {
        const jf = files.find((f) => f.name.endsWith('.json'));
        try {
          if (jf) {
            JSON.parse(jf.text);
            passed = true;
            evidence = `Validated JSON in ${jf.name}`;
          } else {
            evidence = 'No .json file in outputs';
          }
        } catch {
          evidence = `Malformed JSON in ${jf?.name}`;
        }
      } else {
        const kws = (rule.toLowerCase().match(/[a-zа-яё0-9_-]{4,}/g) || [])
          .filter((w) => !['output', 'includes', 'should', 'must', 'file', 'that', 'with', 'from'].includes(w));
        const hits = kws.filter((w) => combinedText.toLowerCase().includes(w));
        passed = files.length > 0 && (kws.length === 0 || hits.length >= Math.ceil(kws.length * 0.5));
        evidence = passed
          ? `Matched ${hits.length}/${kws.length} key terms (${hits.slice(0, 4).join(', ')})`
          : `Matched only ${hits.length}/${kws.length} key terms`;
      }
    }

    results.push({ text: rule, passed, evidence });
  }

  const passedCount = results.filter((r) => r.passed).length;
  const passRate = results.length > 0 ? Number((passedCount / results.length).toFixed(3)) : 1;

  return {
    assertion_results: results,
    passed_count: passedCount,
    total_count: results.length,
    pass_rate: passRate,
  };
}

function readJsonOrNull(p) {
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Aggregates an `iteration-N/` workspace comparing `with_skill/` vs `without_skill/` (or `old_skill/`),
 * writing `benchmark.json` with quality gain and token/latency deltas.
 */
export function aggregateEvalIteration(iterationDir, { writeBenchmark = true } = {}) {
  const absIter = resolve(iterationDir);
  if (!existsSync(absIter)) {
    return { ok: false, error: `Iteration directory not found: ${absIter}` };
  }
  const subdirs = readdirSync(absIter, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const cases = [];
  let withPassSum = 0;
  let basePassSum = 0;
  let withTokSum = 0;
  let baseTokSum = 0;
  let withMsSum = 0;
  let baseMsSum = 0;
  let pairedCount = 0;

  for (const caseName of subdirs) {
    const caseDir = join(absIter, caseName);
    const withDir = join(caseDir, 'with_skill');
    const baseDir = existsSync(join(caseDir, 'without_skill'))
      ? join(caseDir, 'without_skill')
      : join(caseDir, 'old_skill');
    if (!existsSync(withDir) && !existsSync(baseDir)) continue;

    const withGrading = readJsonOrNull(join(withDir, 'grading.json'));
    const baseGrading = readJsonOrNull(join(baseDir, 'grading.json'));
    const withTiming = readJsonOrNull(join(withDir, 'timing.json'));
    const baseTiming = readJsonOrNull(join(baseDir, 'timing.json'));

    const calcRate = (g) => {
      if (!g || !Array.isArray(g.assertion_results) || g.assertion_results.length === 0) return null;
      const p = g.assertion_results.filter((r) => r.passed).length;
      return Number((p / g.assertion_results.length).toFixed(3));
    };

    const toFinite = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const wRate = calcRate(withGrading);
    const bRate = calcRate(baseGrading);
    const wTok = toFinite(withTiming?.total_tokens);
    const bTok = toFinite(baseTiming?.total_tokens);
    const wMs = toFinite(withTiming?.duration_ms);
    const bMs = toFinite(baseTiming?.duration_ms);

    if (wRate !== null && bRate !== null) {
      pairedCount++;
      withPassSum += wRate;
      basePassSum += bRate;
    }
    withTokSum += wTok;
    baseTokSum += bTok;
    withMsSum += wMs;
    baseMsSum += bMs;

    cases.push({
      case: caseName,
      with_skill: { pass_rate: wRate, total_tokens: wTok, duration_ms: wMs },
      baseline: { pass_rate: bRate, total_tokens: bTok, duration_ms: bMs },
    });
  }

  const benchmark = {
    ok: true,
    cases_count: cases.length,
    paired_graded_count: pairedCount,
    with_skill_avg_pass_rate: pairedCount > 0 ? Number((withPassSum / pairedCount).toFixed(3)) : null,
    baseline_avg_pass_rate: pairedCount > 0 ? Number((basePassSum / pairedCount).toFixed(3)) : null,
    pass_rate_delta: pairedCount > 0 ? Number(((withPassSum - basePassSum) / pairedCount).toFixed(3)) : 0,
    with_skill_total_tokens: withTokSum,
    baseline_total_tokens: baseTokSum,
    token_delta_pct: baseTokSum > 0 ? Number((((withTokSum - baseTokSum) / baseTokSum) * 100).toFixed(1)) : 0,
    duration_delta_pct: baseMsSum > 0 ? Number((((withMsSum - baseMsSum) / baseMsSum) * 100).toFixed(1)) : 0,
    cases,
  };

  if (writeBenchmark) {
    writeFileSync(join(absIter, 'benchmark.json'), `${JSON.stringify(benchmark, null, 2)}\n`, 'utf8');
  }
  return benchmark;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const self = resolve(fileURLToPath(import.meta.url));
  const arg = resolve(process.argv[1]);
  return process.platform === 'win32' ? self.toLowerCase() === arg.toLowerCase() : self === arg;
})();
if (isMain) {
  const mode = process.argv[2] || '';
  const target = process.argv[3] || '';
  if (mode === '--init' && target) {
    console.log(JSON.stringify(initSkillEvalsTemplate(target), null, 2));
  } else if (mode === '--aggregate' && target) {
    console.log(JSON.stringify(aggregateEvalIteration(target), null, 2));
  } else {
    console.error('Usage: node eval-skill-benchmark.mjs (--init <skillDir> | --aggregate <iterationDir>)');
    process.exit(1);
  }
}
