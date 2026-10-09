#!/usr/bin/env node
/**
 * check-consistency.mjs — consistency layer for iot-lab gate reviews.
 *
 * Two layers, run together:
 *
 *   1. Deterministic (no network): cross-references board BOM-VERIFIED.csv rows
 *      against registry/components.json or strictly scoped historical board selections. Excluded or unrecorded parts in
 *      a verified BOM are findings. Exact lookups stay in code.
 *
 *   2. Semantic (TypeSafe Jev, two batched calls): typed Noul judgments for
 *      cross-document drift that structural checks cannot see — e.g. whether
 *      STATUS.md still disagrees with REQUIREMENTS.md on service voltage, or a
 *      board packet contradicts the program status. Excerpts carry file:line
 *      provenance; Jev judges agreement, code owns thresholds.
 *
 * Advisory only. Findings are triage for human gate review, never automatic
 * edits or gate decisions.
 *
 * Usage:
 *   node tools/check-consistency.mjs [--dry-run] [--offline] [--key-file path]
 *
 *   --dry-run   build payloads, print summary, no API call, no report
 *   --offline   deterministic layer only, no API key needed
 *
 * Exit codes: 0 = no alerts · 1 = alert-level findings · 2 = operational error.
 * Report: hardware-design/reports/consistency-<date>.json (includes excerpt
 * SHA-256 hashes, model id, usage and raw answers for attribution).
 */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveApiKey, systemOne, DEFAULT_MODEL} from './lib/jev-client.mjs';
import {inspectPackets,loadBoardRegistry,parseCsv} from './lib/board-packets.mjs';
import {loadBoardSelection} from './lib/board-selections.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const OFFLINE = process.argv.includes('--offline');

// Agreement thresholds (code policy): p(yes) below ALERT means drift/contradiction.
const ALERT_BELOW = 0.5;
const WARN_BELOW = 0.8;
const assessAgreement = (p) =>
  p < ALERT_BELOW ? 'alert' : p < WARN_BELOW ? 'warn' : 'pass';

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n) + ' …[clipped]');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const readProject = (rel) => readFile(join(REPO, rel), 'utf8');

// Pick lines matching `re` (plus indented markdown continuations), tagged with
// file:line provenance so findings point back to their source.
function pickTagged(path, text, re, max) {
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((l, i) => {
    if (!re.test(l)) return;
    keep.add(i);
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) keep.add(j);
  });
  const tagged = [...keep].sort((a, b) => a - b).map((i) => `${path}:${i + 1} | ${lines[i]}`);
  return clip(tagged.join('\n'), max);
}

// ---------- truth-layer documents ----------
const TRUTH_DOCS = [
  'hardware-design/STATUS.md',
  'hardware-design/REQUIREMENTS.md',
  'hardware-design/DECISIONS.md',
  'hardware-design/DOC-RECONCILIATION.md',
  'PLATFORM.md',
  'MODULES.md',
  'README.md',
];

// Topics checked for cross-document agreement. Regexes select evidence lines;
// the question defines the judgment.
const TOPICS = [
  {
    id: 'service_voltage',
    re: /L-L|L-N|volt|wye|100 A|60 Hz/i,
    perFile: 1400,
    question: 'Do the excerpts agree on the building service voltages (line-to-line and line-to-neutral values)?',
    criteria: {true: 'Every stated value agrees; older differing values are explicitly superseded', false: 'Stated values conflict or their relationship is unclear'},
  },
  {
    id: 'backup_duration',
    re: /backup|15.?min|minute/i,
    perFile: 900,
    question: 'Do the excerpts agree on the required backup duration and what it covers?',
    criteria: {true: 'Same duration and same scope everywhere', false: 'Durations or covered loads conflict or are unclear'},
  },
  {
    id: 'topology_status',
    re: /topology|verified|unverified|confirmed|category|survey|220|240|110|127/i,
    perFile: 1400,
    question: 'Do the excerpts agree on how well verified the building electrical service topology and ratings are?',
    criteria: {true: 'Consistent account of what is confirmed vs still unverified', false: 'One excerpt treats as confirmed what another treats as unverified, without explanation'},
  },
  {
    id: 'lp_radio_policy',
    re: /Wi-Fi|BLE|radio|wireless|LP population/i,
    perFile: 1100,
    question: 'Do the excerpts agree on the Wi-Fi/BLE radio population policy for the low-power base (BASE-LP)?',
    criteria: {true: 'Consistent policy, or consistently described as open', false: 'One excerpt mandates what another leaves open or forbids'},
  },
  {
    id: 'program_stage',
    re: /G0|G1|G2|stage|gate|readiness/i,
    perFile: 700,
    question: 'Do the excerpts agree on the current program stage and what is not yet done?',
    criteria: {true: 'Same stage picture', false: 'Conflicting claims about stage or completed work'},
  },
];

const boardRegistry=loadBoardRegistry(REPO);
const BOARDS=boardRegistry.boards.filter(e=>e.lifecycle==='active' && e.kind==='board').map(e=>e.directory);

// ---------- deterministic layer ----------
async function checkBomAgainstRegistry(components) {
  const byLcsc = new Map(components.map((c) => [c.lcsc, c]));
  const packets=inspectPackets(REPO,boardRegistry);
  const findings = [...packets.findings];
  let rows = 0;
  for (const board of BOARDS) {
    const csv = await readProject(`hardware-design/boards/${board}/BOM-VERIFIED.csv`).catch(() => '');
    let csvRows=[];
    try {csvRows=parseCsv(csv);}catch{continue;} // packet layer records malformed CSV
    let selection=null;
    try {
      selection=await loadBoardSelection(REPO,boardRegistry.boards.find(e=>e.directory===board),csv,csvRows);
    } catch(error) {
      findings.push({level:'alert',board,check:'bom_selection_evidence',detail:`${board}: ${error.message}`});
    }
    for (const [i, row] of csvRows.entries()) {
      if (i === 0) continue;
      rows++;
      const lcsc = (row[3] || '').trim();
      if (!lcsc) continue;
      const globalRec=byLcsc.get(lcsc);
      // An explicit global exclusion cannot be bypassed by a board ledger.
      const rec=globalRec?.state?.startsWith('excluded') ? globalRec : selection?.references.get(row[0]?.trim()) ?? globalRec;
      if (!rec) {
        findings.push({level: 'alert', check: 'bom_registry_record', detail: `${board} BOM-VERIFIED.csv record ${i + 1} lists ${lcsc} with no attributable component registry record`});
      } else if (rec.state.startsWith('excluded')) {
        findings.push({level: 'alert', check: 'bom_excluded_part', detail: `${board} BOM-VERIFIED.csv:${i + 1} lists ${rec.mpn} (${lcsc}) whose registry state is "${rec.state}"`});
      } else if (!['electrically-selected','cad-verified','ordered','assembled','bench-validated'].includes(rec.state)) {
        findings.push({level:'alert',check:'bom_candidate_state',detail:`${board} ${lcsc}: registry state ${rec.state} does not establish electrical/CAD selection`});
      }
      if(rec && rec.mpn!==row[2]?.trim()) findings.push({level:'alert',check:'bom_mpn_identity',detail:`${board} ${lcsc}: BOM MPN differs from component registry ${rec.mpn}`});
      if(rec) {
        for(const key of ['evidence','datasheet']) if(!rec[key]) findings.push({level:'alert',check:'bom_evidence',detail:`${board} ${lcsc}: missing ${key} attribution`});
        if(rec.evidence) {
          try {
            const path=`hardware-design/registry/${rec.evidence}`;
            const snapshot=JSON.parse(await readProject(path));
            const source=await readProject(path.replace(/\.json$/,'.html'));
            if(snapshot.expected_lcsc!==lcsc || !snapshot.identity_matched || !snapshot.stock_verified || !snapshot.fetched_at_utc || sha256(source)!==snapshot.source_sha256) throw new Error('identity/stock/source hash not verified');
          }catch(error){findings.push({level:'alert',check:'bom_stock_evidence',detail:`${board} ${lcsc}: ${error.message}`});}
        }
        if(rec.datasheet) {
          try {
            const path=`hardware-design/registry/${rec.datasheet}`;
            const pdf=await readFile(join(REPO,path));
            const source=JSON.parse(await readProject(path+'.source.json'));
            if(!source.source_url || !source.fetched_at_utc || sha256(pdf)!==source.sha256) throw new Error('datasheet provenance/hash mismatch');
          }catch(error){findings.push({level:'alert',check:'bom_datasheet_evidence',detail:`${board} ${lcsc}: ${error.message}`});}
        }
      }
    }
  }
  return {boards_checked:BOARDS,packet_coverage:packets.checked,rows_checked: rows, findings};
}

// ---------- semantic layer ----------
function noulQuestion(topic) {
  return {
    type: 'noul',
    instructions: `${topic.question} Judge only from the excerpts in \`${topic.id}\`, which are tagged file:line.`,
    criteria: topic.criteria,
  };
}

async function buildTruthLayerCall(docs) {
  const state = {};
  const questions = {};
  for (const topic of TOPICS) {
    state[topic.id] = Object.entries(docs)
      .map(([path, text]) => pickTagged(path, text, topic.re, topic.perFile))
      .filter(Boolean).join('\n') || '(no matching lines)';
    questions[topic.id] = noulQuestion(topic);
  }
  return {id: 'truth-layer', state, questions};
}

async function buildBoardCall(docs) {
  const state = {
    board_index: clip(docs['hardware-design/BOARD-INDEX.md'], 2200),
    program_status: pickTagged('hardware-design/STATUS.md', docs['hardware-design/STATUS.md'], /./, 1500),
  };
  const questions = {};
  for (const board of BOARDS) {
    const key = `board_${board.toLowerCase().replace(/-/g, '_')}`;
    const status = await readProject(`hardware-design/boards/${board}/STATUS.md`).catch(() => '(missing)');
    const entry=boardRegistry.boards.find(e=>e.directory===board);
    const specs=await Promise.all([...new Set(entry.revisions.map(r=>r.spec))].map(async file=>`${file}:\n${await readProject(`hardware-design/boards/${board}/${file}`).catch(()=>'(missing)')}`));
    const spec=specs.join('\n\n');
    state[key] = clip(`STATUS.md:\n${status}\n\nSPEC.md:\n${spec}`, 5200);
    questions[`consistent_${key}`] = {
      type: 'noul',
      instructions: `Is the board packet excerpt \`${key}\` consistent with the program status in \`program_status\` and the board's role in \`board_index\`? Answer yes only if no stated facts conflict (voltage values, stage, scope, sourcing states, roles).`,
      criteria: {true: 'No conflicting statements of fact', false: 'At least one statement conflicts with the program status or the board role'},
    };
  }
  return {id: 'board-vs-program', state, questions};
}

// ---------- main ----------
const docs = {};
for (const rel of [...TRUTH_DOCS, 'hardware-design/BOARD-INDEX.md']) {
  docs[rel] = await readProject(rel);
}
const components = JSON.parse(await readProject('hardware-design/registry/components.json')).candidates;

const deterministic = await checkBomAgainstRegistry(components);
const calls = [await buildTruthLayerCall(docs), await buildBoardCall(docs)];

if (DRY_RUN) {
  console.log(`deterministic: ${deterministic.rows_checked} BOM rows checked, ${deterministic.findings.length} findings`);
  for (const c of calls) {
    console.log(`call "${c.id}": state ${JSON.stringify(c.state).length} chars, ${Object.keys(c.questions).length} questions`);
    for (const qid of Object.keys(c.questions)) console.log(`   noul   ${qid}`);
  }
  console.log('\n--dry-run: no API calls, no report.');
  process.exit(0);
}

const findings = [...deterministic.findings];
let responses = [];
let keySource = 'offline';

if (!OFFLINE) {
  const resolved = await resolveApiKey();
  if (!resolved) {
    console.error('Operational error: no TypeSafe API key (set TYPESAFE_API_KEY, use --key-file, or run --offline).');
    process.exit(2);
  }
  keySource = resolved.source;
  for (const call of calls) {
    try {
      process.stdout.write(`→ semantic call "${call.id}" … `);
      const response = await systemOne({state: call.state, questions: call.questions, key: resolved.key});
      console.log(`${Object.keys(response.answers).length} answers (${response.usage.input_tokens} in / ${response.usage.output_tokens} out)`);
      responses.push({call, response});
    } catch (err) {
      console.error(`\nOperational error during "${call.id}": ${err.message}`);
      process.exit(2);
    }
  }
  for (const {call, response} of responses) {
    for (const [qid, answer] of Object.entries(response.answers)) {
      const level = assessAgreement(answer.noul);
      if (level === 'pass') continue;
      findings.push({
        level, check: `semantic/${call.id}/${qid}`,
        detail: `p(agree)=${answer.noul.toFixed(2)} — review the tagged excerpts in the report`,
      });
    }
  }
}

const alerts = findings.filter((f) => f.level === 'alert');
const warnings = findings.filter((f) => f.level === 'warn');
const ok = alerts.length === 0;

const report = {
  tool: 'check-consistency', schema_version: 1, run_at_utc: new Date().toISOString(),
  offline: OFFLINE, model: responses[0]?.response.model ?? (OFFLINE ? null : DEFAULT_MODEL),
  thresholds: {alert_below: ALERT_BELOW, warn_below: WARN_BELOW,
    meaning: 'p(agree) below alert => drift/contradiction likely; below warn => human review'},
  key_source: keySource,
  deterministic,
  semantic_calls: responses.map(({call, response}) => ({
    id: call.id,
    state_sha256: Object.fromEntries(Object.entries(call.state).map(([k, v]) => [k, sha256(v)])),
    questions: Object.fromEntries(Object.entries(call.questions).map(([k, q]) => [k, {instructions: q.instructions, criteria: q.criteria}])),
    state_excerpts: call.state,
    usage: response.usage, answers: response.answers,
  })),
  findings, ok,
};

const date = report.run_at_utc.slice(0, 10);
const outDir = join(REPO, 'hardware-design', 'reports');
await mkdir(outDir, {recursive: true});
const outPath = join(outDir, `consistency-${date}.json`);
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({
  ok, alerts: alerts.length, warnings: warnings.length, findings,
  report: `hardware-design/reports/consistency-${date}.json`,
}, null, 2));
process.exit(ok ? 0 : 1);
