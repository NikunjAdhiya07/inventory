import type { Document } from "mongodb";

// Generating a run of sibling location nodes.
//
// Racks and boxes are the only part of the tree that comes in quantity: a
// section has eight racks, a rack has twenty-four boxes, and every one of them
// is the same node with a different number on it. Adding those through the
// one-at-a-time node modal is ~200 modal round trips for a single room, which is
// why the physical layout never gets entered in the first place.
//
// Two ways to say what to create, because transcription happens two ways:
//   - a range  ("Box 1" … "Box 24", or "Rack A" … "Rack H") when the shelving is
//     regular, which it usually is;
//   - an explicit list, for reading labels off a photo where the previous owner
//     of the room numbered things their own way.

export type BulkSpec = {
  parent: string | null;
  level: string;
  // Range mode.
  prefix?: string;
  mode?: "number" | "letter";
  from?: number | string;
  to?: number | string;
  pad?: number;
  // List mode — wins over the range when non-empty.
  names?: string[];
  // Optional code stem: "C-R1-" + token → "C-R1-04".
  codePrefix?: string;
  capacity?: number | "";
};

const MAX_NODES = 500;

function letterToIndex(s: string): number {
  // "A" → 1, "Z" → 26, "AA" → 27. Excel column arithmetic, so a rack run can
  // pass Z without restarting.
  let n = 0;
  for (const ch of s.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64;
    if (v < 1 || v > 26) return 0;
    n = n * 26 + v;
  }
  return n;
}

function indexToLetter(n: number): string {
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

// The tokens a spec expands to — "01".."24", or "A".."H", or the trimmed lines
// of an explicit list. Throws with a readable reason rather than silently
// creating nothing, because "Save" appearing to work and adding zero racks is
// the worst outcome here.
export function expandTokens(spec: BulkSpec): string[] {
  const explicit = (spec.names || []).map((n) => n.trim()).filter(Boolean);
  if (explicit.length) {
    if (explicit.length > MAX_NODES) throw new Error(`That is ${explicit.length} nodes; the limit per batch is ${MAX_NODES}.`);
    return explicit;
  }

  const mode = spec.mode === "letter" ? "letter" : "number";
  let start: number;
  let end: number;
  if (mode === "letter") {
    start = letterToIndex(String(spec.from ?? "A"));
    end = letterToIndex(String(spec.to ?? "A"));
    if (!start || !end) throw new Error("Letter range must be A–Z (or AA, AB…).");
  } else {
    start = Math.trunc(Number(spec.from ?? 1));
    end = Math.trunc(Number(spec.to ?? 1));
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Number range must be numeric.");
    if (start < 0 || end < 0) throw new Error("Number range must not be negative.");
  }
  if (end < start) throw new Error("The range ends before it starts.");
  const count = end - start + 1;
  if (count > MAX_NODES) throw new Error(`That range is ${count} nodes; the limit per batch is ${MAX_NODES}.`);

  const pad = Math.max(0, Math.trunc(Number(spec.pad ?? 0)));
  const tokens: string[] = [];
  for (let i = start; i <= end; i++) {
    tokens.push(mode === "letter" ? indexToLetter(i) : String(i).padStart(pad, "0"));
  }
  return tokens;
}

// Full documents ready for insertMany, in the shape the locations collection
// and the console's tree page already use.
export function buildBulkNodes(spec: BulkSpec): Document[] {
  const level = String(spec.level || "").trim();
  if (!level) throw new Error("Level label is required (e.g. Rack, Box).");

  const usingList = Boolean((spec.names || []).some((n) => n.trim()));
  const prefix = String(spec.prefix ?? "");
  const codePrefix = String(spec.codePrefix ?? "");
  const capacity = spec.capacity === "" || spec.capacity == null ? "" : Number(spec.capacity);

  return expandTokens(spec).map((token) => ({
    parent: spec.parent,
    // An explicit list is already the finished name; a range is prefix + token.
    name: usingList ? token : `${prefix}${token}`.trim() || token,
    level,
    code: codePrefix ? `${codePrefix}${token}` : "",
    capacity,
    status: "Active" as const,
    refCount: 0,
  }));
}
