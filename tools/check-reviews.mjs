#!/usr/bin/env node
/**
 * check-reviews.mjs — verify registry review notes against their datasheets.
 *
 * Registry policy requires reviews to be attributable to datasheet evidence.
 * Today the review prose cites no pages, so this tool:
 *   1. (code) splits registry/reviews/*.md into per-part sentences and keeps
 *      only datasheet-evidence claims (sourcing/"JLC snapshot" claims and
 *      process sentences are out of scope here);
 *   2. (code) retrieves the best-matching pages from the extracted datasheet
 *      text (datasheets/*.txt, "--- PDF PAGE n ---" per page) by token
 *      overlap — deterministic, inspectable;
 *   3. (Jev, one batched call) judges each claim against its retrieved pages:
 *      supported / contradicted / not_addressed, with confidence.
 *
 * Output flags claims whose evidence could not be found or that conflict with
 * the datasheet, with page references — triage for a human to add citations or
 * soften wording. It edits nothing and never promotes a candidate.
 *
 * Usage:
 *   node tools/check-reviews.mjs [--dry-run] [--key-file path]
 * Exit codes: 0 = no alerts · 1 = contradicted claims found · 2 = operational error.
 * Report: hardware-design/reports/review-citations-<date>.json
 */
import {readFile, writeFile, mkdir, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {projectRoot} from './lib/project-root.mjs';

const REPO = projectRoot();
// The Jev client is optional (an archive candidate). Without it the semantic review is skipped (exit 2, no verdict).
let jev = null;
try { jev = await import('./lib/jev-client.mjs'); }
catch (error) { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const DATASHEETS = join(REPO, 'hardware-design/registry/datasheets');
const DRY_RUN = process.argv.includes('--dry-run');

const MAX_CLAIM_PAGES = 2;        // pages of evidence retrieved per claim
const PAGE_CHARS = 1800;          // excerpt budget per page (windowed around matches)
const MIN_CONFIDENCE = 0.7;       // supported verdicts below this still get reviewed

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n) + ' …[clipped]');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const readProject = (rel) => readFile(join(REPO, rel), 'utf8');

// ---------- claim extraction (deterministic heuristics, documented) ----------
// Split on sentence/semicolon boundaries; the (?=[A-Z]) guard protects decimals
// like "2.97-3.63 V" and "1.5 kVrms".
function splitSentences(text) {
  return text.replace(/\n+/g, ' ').split(/(?<=[.])\s+(?=[A-Z])|;\s+/)
    .map((s) => s.trim()).filter((s) => s.length > 12);
}
// Sourcing claims belong to the JLC-evidence domain, not the datasheet domain.
const SOURCING = /jlc snapshot|observed|presale|stock|assembly|price/i;
// A datasheet claim mentions a document or technical facts (digits/units).
const CLAIMISH = /datasheet|pdf|document|reports|identifies|confirms|\d/i;
// Process/status sentences ("remain open", "candidate only") are not datasheet claims.
const PROCESS = /remain[s]? open|pending|candidate|preserved|not selected|does not select|to be reviewed/i;

function extractClaims(reviewPath, markdown, components) {
  const byLcsc = new Map(components.map((c) => [c.lcsc, c]));
  const claims = [];
  const sections = markdown.split(/^## /m).slice(1);
  for (const section of sections) {
    let lastLcsc = (section.match(/C\d{4,}/) || [null])[0];
    for (const raw of splitSentences(section.replace(/^[^\n]*\n/, ''))) {
      const own = (raw.match(/C\d{4,}/) || [null])[0];
      const lcsc = own || lastLcsc;
      if (own) lastLcsc = own;
      if (!lcsc || SOURCING.test(raw) || !CLAIMISH.test(raw) || PROCESS.test(raw)) continue;
      const part = byLcsc.get(lcsc);
      claims.push({lcsc, mpn: part?.mpn ?? '(unknown)', review: reviewPath,
        text: clip(raw.replace(/[.;]\s*$/, ''), 400)});
    }
  }
  return claims;
}

// ---------- page retrieval (deterministic token overlap) ----------
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'has', 'have', 'its', 'per', 'all', 'not', 'etc', 'via', 'into', 'over', 'under']);
const tokens = (s) => [...new Set(s.toLowerCase().replace(/[^a-z0-9./-]+/g, ' ').split(' '))]
  .filter((t) => t.length > 3 && !STOP.has(t));

function parsePages(txt) {
  const parts = txt.split(/\n--- PDF PAGE (\d+) ---\n/);
  const pages = [];
  for (let i = 1; i < parts.length; i += 2) pages.push({page: Number(parts[i]), text: parts[i + 1]});
  return pages;
}

function retrievePages(claimText, pages) {
  const q = tokens(claimText);
  const scored = pages.map((p) => {
    const lower = p.text.toLowerCase();
    const pageTokens = new Set(lower.split(/[^a-z0-9./-]+/));
    const matched = q.filter((t) => pageTokens.has(t));
    return {page: p.page, score: matched.length, text: p.text, lower, matched};
  }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score || a.page - b.page);
  // Window the excerpt around the first matched term, not the page head.
  return scored.slice(0, MAX_CLAIM_PAGES).map((p) => {
    let first = p.lower.length;
    for (const t of p.matched) {
      const i = p.lower.indexOf(t);
      if (i > -1 && i < first) first = i;
    }
    const start = Math.max(0, first - 250);
    return {page: p.page, score: p.score, excerpt: clip(p.text.slice(start, start + PAGE_CHARS), PAGE_CHARS + 20)};
  });
}

// ---------- main ----------
const components = JSON.parse(await readProject('hardware-design/registry/components.json')).candidates;
const reviewFiles = (await readdir(join(REPO, 'hardware-design/registry/reviews'))).filter((f) => f.endsWith('.md'));

let claims = [];
for (const file of reviewFiles) {
  const md = await readProject(`hardware-design/registry/reviews/${file}`);
  claims.push(...extractClaims(`registry/reviews/${file}`, md, components));
}

// Resolve datasheet text per claim.
const skipped = [];
const pageCache = new Map();
for (const c of claims) {
  const part = components.find((x) => x.lcsc === c.lcsc);
  if (!part?.datasheet) {
    skipped.push({...c, reason: 'no datasheet on file in registry'});
    continue;
  }
  const txtName = part.datasheet.replace(/\.pdf$/i, '.txt');
  if (!pageCache.has(txtName)) {
    try {
      pageCache.set(txtName, parsePages(await readProject(`hardware-design/registry/${txtName}`)));
    } catch {
      pageCache.set(txtName, null);
    }
  }
  const pages = pageCache.get(txtName);
  if (!pages) {
    skipped.push({...c, reason: `extracted text missing for ${txtName}`});
    continue;
  }
  c.datasheet = part.datasheet;
  c.retrieved = retrievePages(c.text, pages);
  if (c.retrieved.length === 0) skipped.push({...c, reason: 'no datasheet page shares terminology with the claim'});
}
const active = claims.filter((c) => c.retrieved?.length > 0);

if (DRY_RUN) {
  console.log(`${claims.length} datasheet claims extracted (${skipped.length} skipped before API)`);
  for (const c of active) {
    console.log(`\n${c.mpn} (${c.lcsc}) — "${c.text.slice(0, 110)}…"`);
    console.log(`   pages: ${c.retrieved.map((p) => `p${p.page} (score ${p.score})`).join(', ')}`);
  }
  for (const s of skipped) console.log(`\nSKIP ${s.mpn} (${s.lcsc}): ${s.reason}\n   "${s.text.slice(0, 100)}…"`);
  console.log('\n--dry-run: no API call, no report.');
  process.exit(0);
}

// One batched call: every claim carries its own evidence in the state.
const state = {claims: {}};
const questions = {};
for (const [i, c] of active.entries()) {
  const id = `c${String(i + 1).padStart(2, '0')}`;
  c.id = id;
  state.claims[id] = {
    part: c.mpn, claim: c.text,
    evidence: c.retrieved.map((p) => `--- ${c.datasheet} page ${p.page} ---\n${p.excerpt}`).join('\n'),
  };
  questions[id] = {
    type: 'choice',
    instructions: `A component review note about \`claims.${id}.part\` states: \`claims.${id}.claim\`. Using only the datasheet excerpt in \`claims.${id}.evidence\`, decide whether the excerpt supports that claim.`,
    criteria: {
      supported: 'The excerpt explicitly states or clearly implies the claimed facts',
      contradicted: 'The excerpt states something that conflicts with the claim',
      not_addressed: 'The excerpt does not cover the claimed facts (evidence may exist elsewhere)',
    },
  };
}

if (active.length === 0) {
  console.log('No claims with datasheet evidence to check.');
  process.exit(0);
}

if (!jev) {
  console.error('SKIPPED: tools/lib/jev-client.mjs is absent; the semantic claim review did not run (no verdict).');
  process.exit(2);
}
const resolved = await jev.resolveApiKey();
if (!resolved) {
  console.error('Operational error: no TypeSafe API key (set TYPESAFE_API_KEY or use --key-file).');
  process.exit(2);
}

let response;
try {
  process.stdout.write(`→ verifying ${active.length} claims in one batched call … `);
  response = await jev.systemOne({state, questions, key: resolved.key});
  console.log(`done (${response.usage.input_tokens} in / ${response.usage.output_tokens} out)`);
} catch (err) {
  console.error(`\nOperational error: ${err.message}`);
  process.exit(2);
}

const findings = [];
for (const c of active) {
  const a = response.answers[c.id];
  c.verdict = a.choice;
  c.confidence = a.confidence;
  if (a.choice === 'contradicted') {
    findings.push({level: 'alert', claim: c, detail: 'datasheet excerpt conflicts with the review claim'});
  } else if (a.choice === 'not_addressed') {
    findings.push({level: 'warn', claim: c, detail: 'evidence not found on retrieved pages — locate a citation or soften wording'});
  } else if (a.confidence < MIN_CONFIDENCE) {
    findings.push({level: 'warn', claim: c, detail: `supported but confidence ${a.confidence.toFixed(2)} < ${MIN_CONFIDENCE}`});
  }
}
for (const s of skipped) findings.push({level: 'warn', claim: s, detail: s.reason});

const alerts = findings.filter((f) => f.level === 'alert');
const report = {
  tool: 'check-reviews', schema_version: 1, run_at_utc: new Date().toISOString(),
  model: response.model, thresholds: {min_confidence: MIN_CONFIDENCE, max_claim_pages: MAX_CLAIM_PAGES},
  key_source: resolved.source,
  claims: active.map((c) => ({id: c.id, mpn: c.mpn, lcsc: c.lcsc, review: c.review, text: c.text,
    datasheet: c.datasheet, pages: c.retrieved.map((p) => ({page: p.page, overlap_score: p.score})),
    evidence_sha256: sha256(state.claims[c.id].evidence), verdict: c.verdict, confidence: c.confidence,
    probabilities: response.answers[c.id].probabilities})),
  skipped, findings, usage: response.usage, ok: alerts.length === 0,
};

const date = report.run_at_utc.slice(0, 10);
const outDir = join(REPO, 'hardware-design', 'reports');
await mkdir(outDir, {recursive: true});
const outPath = join(outDir, `review-citations-${date}.json`);
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({
  ok: report.ok, claims_checked: active.length,
  supported: active.filter((c) => c.verdict === 'supported').length,
  contradicted: active.filter((c) => c.verdict === 'contradicted').length,
  not_addressed: active.filter((c) => c.verdict === 'not_addressed').length,
  alerts: alerts.length, warnings: findings.length - alerts.length,
  report: `hardware-design/reports/review-citations-${date}.json`,
}, null, 2));
for (const c of active) {
  console.log(`  ${c.verdict.padEnd(13)} ${(c.confidence ?? 0).toFixed(2)}  ${c.mpn}: ${c.text.slice(0, 90)}`);
}
process.exit(alerts.length > 0 ? 1 : 0);
