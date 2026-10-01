// Fuzzy matching of item names between the daily inventory sheet (master SKUs),
// the Calo dashboard packaging stats and delivery notes.
//
// Score = blend of weighted token overlap and character-trigram similarity, with a
// strong penalty when the sizes/numbers disagree ("12 OZ" vs "16 OZ" are different
// SKUs even though the words are identical).

export interface MatchCandidate {
  sku: string;
  name: string;
}

export interface MatchResult {
  sku: string | null;
  confidence: number; // 0..1
  level: "exact" | "high" | "confirm" | "none";
  suggestions: { sku: string; name: string; score: number }[];
}

export const AUTO_ACCEPT = 0.85;
export const MIN_SUGGEST = 0.45;

const SYNONYMS: Record<string, string> = {
  CONT: "CONTAINER",
  CONTAINERS: "CONTAINER",
  CNTR: "CONTAINER",
  CTN: "CARTON",
  LIDS: "LID",
  BOWLS: "BOWL",
  CUPS: "CUP",
  SLEEVES: "SLEEVE",
  RECT: "RECTANGLE",
  RECTANGULAR: "RECTANGLE",
  SQ: "SQUARE",
  RND: "ROUND",
  GOURMENT: "GOURMET",
  YOUGURT: "YOGURT",
  WO: "WITHOUT",
  BRANDED: "BRAND",
  PCS: "",
  PC: "",
  PIECE: "",
  PIECES: "",
  X: "",
  THE: "",
  FOR: "",
  AND: "",
  OF: "",
  WITH: "",
  W: "",
};

const KIND_WORDS = ["LID", "INSERT", "SLEEVE", "STICKER", "LABEL", "CARD"];

const UNIT_WORDS = new Set(["OZ", "ML", "L", "GM", "G", "KG", "CM", "MM", "GSM", "IN", "INCH"]);

export function normalize(s: string): string {
  return s
    .toUpperCase()
    .replace(/\b(W\/O|WITHOUT|NO|W\/OUT)\s+LIDS?\b/g, " NOLID ")
    .replace(/W\/O\b/g, " WITHOUT ")
    .replace(/W\//g, " WITH ")
    .replace(/&/g, " AND ")
    .replace(/(\d)\s*(OZ|ML|GSM|GM|KG|CM|MM|LTR|L)\b/g, "$1 $2")
    .replace(/(\d+)\s*X\s*(\d+)/g, "$1 X $2")
    .replace(/[^A-Z0-9./ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .map((t) => t.replace(/^[./]+|[./]+$/g, ""))
    .map((t) => (t in SYNONYMS ? SYNONYMS[t] : t))
    .filter(Boolean);
}

function isNumberToken(t: string): boolean {
  return /^\d+(\.\d+)?$/.test(t);
}

/** Size numbers (12 OZ, 750 ML, 6 X 9...) - excludes pack counts like 1X300 / 500 PCS. */
export function sizeNumbers(s: string): Set<string> {
  const n = normalize(s);
  const out = new Set<string>();
  // Drop pack-count patterns: "1 X 300", "(500 PCS)", "1000 PC / CTN", "X 2000PCS".
  const cleaned = n
    .replace(/\b1 X \d+\b/g, " ")
    .replace(/\bX \d+\b/g, " ")
    .replace(/\b\d+ ?(PCS|PC|PIECES|LABELS|SHEETS)\b/g, " ")
    .replace(/\b\d+ ?S\b/g, " ");
  for (const m of cleaned.matchAll(/\d+(?:\.\d+)?(?:\/\d+)*/g)) {
    for (const part of m[0].split("/")) out.add(String(Number(part)));
  }
  return out;
}

function trigrams(s: string): Map<string, number> {
  const t = ` ${normalize(s).replace(/ /g, "  ")} `;
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 2; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v;
  for (const v of b.values()) nb += v;
  for (const [g, v] of a) inter += Math.min(v, b.get(g) ?? 0);
  return na + nb === 0 ? 0 : (2 * inter) / (na + nb);
}

function tokenWeight(t: string): number {
  if (isNumberToken(t)) return 1.5;
  if (UNIT_WORDS.has(t)) return 0.5;
  return t.length <= 2 ? 0.5 : 1;
}

function tokenScore(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  let union = 0;
  for (const t of new Set([...sa, ...sb])) {
    const w = tokenWeight(t);
    union += w;
    if (sa.has(t) && sb.has(t)) inter += w;
    else if (!isNumberToken(t)) {
      // Partial credit for prefixes/typos ("GOURMENT" vs "GOURMET", "CONT" vs "CONTAINER").
      const other = sa.has(t) ? sb : sa;
      for (const o of other) {
        if (!isNumberToken(o) && o.length >= 3 && t.length >= 3 && (o.startsWith(t) || t.startsWith(o))) {
          inter += w * 0.7;
          break;
        }
      }
    }
  }
  return union === 0 ? 0 : inter / union;
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  let score = 0.55 * tokenScore(ta, tb) + 0.45 * dice(trigrams(a), trigrams(b));
  // Words that turn one product into a different one (a bowl vs its lid).
  for (const w of KIND_WORDS) if (ta.includes(w) !== tb.includes(w)) score *= 0.85;
  const na = sizeNumbers(a);
  const nb = sizeNumbers(b);
  if (na.size && nb.size) {
    const shared = [...na].filter((x) => nb.has(x)).length;
    if (shared === 0) score *= 0.55;
    else if (shared < Math.min(na.size, nb.size)) score *= 0.85;
    else score = Math.min(1, score + 0.08);
  } else if (na.size !== nb.size) {
    score *= 0.9;
  }
  return Math.max(0, Math.min(1, score));
}

const SKU_RE = /\b([A-Z]{2,3}\d{4,8}[A-Z]?)\b/;

export function matchName(source: string, candidates: MatchCandidate[]): MatchResult {
  const upper = source.toUpperCase();
  const code = upper.match(SKU_RE)?.[1];
  if (code) {
    const hit = candidates.find((c) => c.sku.toUpperCase() === code);
    if (hit) return { sku: hit.sku, confidence: 1, level: "exact", suggestions: [{ sku: hit.sku, name: hit.name, score: 1 }] };
  }
  const exact = candidates.find((c) => normalize(c.name) === normalize(source));
  if (exact) return { sku: exact.sku, confidence: 1, level: "exact", suggestions: [{ sku: exact.sku, name: exact.name, score: 1 }] };

  const scored = candidates
    .map((c) => ({ sku: c.sku, name: c.name, score: similarity(source, c.name) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const suggestions = scored.filter((s) => s.score >= MIN_SUGGEST * 0.8).slice(0, 5);
  if (!top || top.score < MIN_SUGGEST) return { sku: null, confidence: top?.score ?? 0, level: "none", suggestions };
  // Two near-identical candidates (e.g. lid vs container) always need a human.
  const ambiguous = second && top.score - second.score < 0.05;
  const level = top.score >= AUTO_ACCEPT && !ambiguous ? "high" : "confirm";
  return { sku: top.sku, confidence: top.score, level, suggestions };
}

/** Key used to remember a confirmed mapping for a source name. */
export function mappingKey(source: string): string {
  return normalize(source);
}
