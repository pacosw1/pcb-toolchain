// The gate decision on kicad-happy findings: rule and severity filter, exemptions, report lines and exit code.
import { pyRepr } from './py-compat.mjs';

export const SEVERITY_ORDER = ['info', 'warning', 'error', 'critical'];

export interface Finding {
  rule_id?: string;
  severity?: string;
  summary?: string;
  description?: string;
  title?: string;
  nets?: string[] | null;
  net?: string | null;
  components?: string[] | null;
  component?: string | null;
}

/** Drops findings of `rule` that name the net or the component. */
export interface Exemption { rule: string; net?: string; ref?: string; reason: string }

export interface Verdict { lines: string[]; code: number; kept: Finding[]; stale: Exemption[] }

const severityRank = (severity: string) => Math.max(SEVERITY_ORDER.indexOf(severity), 0);

export function filterFindings(findings: Finding[], ruleIds: string[], minSeverity?: string): Finding[] {
  const floor = minSeverity ? SEVERITY_ORDER.indexOf(minSeverity) : -1;
  return findings.filter(finding =>
    ruleIds.includes(finding.rule_id ?? '') && severityRank(finding.severity ?? 'info') >= floor);
}

export const formatFinding = (finding: Finding) =>
  `FAIL ${finding.rule_id} ${finding.summary || finding.description || ''}`;

/** --exempt RULE:NET values. */
export function parseExemptArgs(items: string[]): Exemption[] {
  return items.map(item => {
    const colon = item.indexOf(':');
    const rule = colon < 0 ? '' : item.slice(0, colon).trim();
    const net = colon < 0 ? '' : item.slice(colon + 1).trim();
    if (!rule || !net) throw new Error(`--exempt ${pyRepr(item)}: use RULE:NET`);
    return { rule, net, reason: '--exempt on the command line' };
  });
}

const isText = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/** Checks the parsed JSON of an --exempt-file. Each entry needs rule, reason and exactly one of net, ref. */
export function loadExemptFile(doc: unknown): Exemption[] {
  if (!Array.isArray(doc)) throw new Error('exempt file must be a JSON list');
  doc.forEach((entry: unknown, index) => {
    const isDict = typeof entry === 'object' && entry !== null && !Array.isArray(entry);
    if (!isDict || Object.keys(entry).some(key => !['rule', 'net', 'ref', 'reason'].includes(key))) {
      throw new Error(`exempt entry ${index}: use only the keys rule, net, ref, reason`);
    }
    const fields = entry as Record<string, unknown>;
    if (('net' in fields) === ('ref' in fields)) throw new Error(`exempt entry ${index}: give exactly one of net, ref`);
    for (const key of ['rule', 'net' in fields ? 'net' : 'ref', 'reason']) {
      if (!isText(fields[key])) throw new Error(`exempt entry ${index}: ${key} is required`);
    }
  });
  return doc as Exemption[];
}

const findingNets = ({ nets, net }: Finding) => [...nets ?? [], ...net ? [net] : []];
const findingRefs = ({ components, component }: Finding) => [...components ?? [], ...component ? [component] : []];

function names(finding: Finding, exemption: Exemption): boolean {
  return exemption.net !== undefined
    ? findingNets(finding).includes(exemption.net)
    : findingRefs(finding).includes(exemption.ref ?? '');
}

/** The kept findings and the exemptions that matched nothing. */
export function applyExemptions(findings: Finding[], exemptions: Exemption[]): { kept: Finding[]; stale: Exemption[] } {
  const used = new Set<Exemption>();
  const kept = findings.filter(finding => {
    const hits = exemptions.filter(exemption => exemption.rule === finding.rule_id && names(finding, exemption));
    hits.forEach(hit => used.add(hit));
    return !hits.length;
  });
  return { kept, stale: exemptions.filter(exemption => !used.has(exemption)) };
}

export function evaluate(findings: Finding[], ruleIds: string[], minSeverity: string | undefined, exemptions: Exemption[]): Verdict {
  const { kept, stale } = applyExemptions(filterFindings(findings, ruleIds, minSeverity), exemptions);
  const lines = [
    ...kept.map(formatFinding),
    ...stale.map(({ rule, net, ref, reason }) => `STALE exempt ${rule} ${net ?? ref}: no finding matched (${reason})`),
    `${kept.length} kicad-happy findings (rules ${ruleIds.join(',')})`,
  ];
  return { lines, code: stale.length ? 2 : kept.length ? 1 : 0, kept, stale };
}
