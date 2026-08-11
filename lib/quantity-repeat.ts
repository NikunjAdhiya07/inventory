/**
 * Optional qty × repeat on the same quantity interaction.
 * "200" → qty 200, repeat 1
 * "200 × 5" → five independent entries of 200 each (not one entry of 1000).
 */

export type QuantityRepeat = {
  /** Units on each independent line / entry. */
  qty: number;
  /** How many separate lines to create. Defaults to 1 when omitted. Alias: repeatCount. */
  times: number;
  /** Normalized keypad draft, e.g. "200" or "200 × 5". */
  display: string;
};

const TIMES_MAX = 100;

/** Splitters users type or tap: ×, x, X, *. */
const TIMES_SPLIT = /\s*[×xX*]\s*/;

export function parseQuantityRepeat(
  raw: string
): { ok: true; value: QuantityRepeat } | { ok: false; notice: string } {
  const text = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, notice: "Enter a quantity first." };

  const parts = text.split(TIMES_SPLIT);
  if (parts.length > 2) {
    return { ok: false, notice: "Use qty × entries (e.g. 200 × 5)." };
  }

  const qtyPart = parts[0]?.trim() ?? "";
  const timesPart = parts.length === 2 ? (parts[1]?.trim() ?? "") : "";

  if (!qtyPart || qtyPart === ".") {
    return { ok: false, notice: "Enter a valid quantity." };
  }
  const qty = Number(qtyPart);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, notice: "Enter a valid quantity." };
  }

  let times = 1;
  if (timesPart !== "") {
    const t = Number(timesPart);
    if (!Number.isFinite(t) || t <= 0 || !Number.isInteger(t)) {
      return { ok: false, notice: "Entries must be a whole number (e.g. 200 × 5)." };
    }
    if (t > TIMES_MAX) {
      return { ok: false, notice: `Entries can be at most ${TIMES_MAX}.` };
    }
    times = t;
  }

  const display = times === 1 ? stripTrailingDot(String(qtyPart)) : `${stripTrailingDot(String(qtyPart))} × ${times}`;
  return { ok: true, value: { qty, times, display } };
}

function stripTrailingDot(s: string): string {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

/** "12 Meter" — quantity of one entry only (never includes × repeat). */
export function formatQtyUnit(qty: number, unit: string): string {
  const u = String(unit ?? "").trim();
  return u ? `${fmtQty(qty)} ${u}` : fmtQty(qty);
}

/**
 * Compact summary for review / notices.
 * times=1 → "12 Meter"
 * times=5 → "12 Meter × 5 entries"
 */
export function formatQtyWithEntries(qty: number, unit: string, times: number): string {
  const base = formatQtyUnit(qty, unit);
  if (!times || times <= 1) return base;
  return `${base} × ${times} entries`;
}

/** Item + qty block without misusing × as the quantity operator. */
export function formatItemQtySummary(item: string, qty: number, unit: string, times = 1): string {
  const name = String(item ?? "").trim() || "Item";
  return `${name} — ${formatQtyWithEntries(qty, unit, times)}`;
}

/** Structured review lines for quantity / repeat. */
export function reviewQuantityLines(qty: number, unit: string, times: number): string[] {
  if (!times || times <= 1) {
    return [`Quantity: ${formatQtyUnit(qty, unit)}`];
  }
  return [
    `Quantity: ${formatQtyWithEntries(qty, unit, times)}`,
    `Total: ${formatQtyUnit(qty * times, unit)}`,
  ];
}

/**
 * Split a keypad draft for display while typing (may be incomplete).
 * "12 × 5" → { qtyLabel: "12", entriesLabel: "5", hasTimes: true }
 */
export function draftQtyParts(draft: string): { qtyLabel: string; entriesLabel: string | null; hasTimes: boolean } {
  const text = String(draft ?? "").trim();
  if (!text) return { qtyLabel: "—", entriesLabel: null, hasTimes: false };
  if (!/[×xX*]/.test(text)) {
    return { qtyLabel: text, entriesLabel: null, hasTimes: false };
  }
  const parts = text.split(TIMES_SPLIT);
  const qtyLabel = (parts[0] ?? "").trim() || "—";
  const timesSide = (parts[1] ?? "").trim();
  return {
    qtyLabel,
    entriesLabel: timesSide || "—",
    hasTimes: true,
  };
}

/**
 * One keypad press on a qty×entries draft.
 * `x` inserts the × separator (only once, after a qty has been started).
 */
export function pressQuantityKey(
  draft: string,
  pressed: string
): { value: string; notice?: string } {
  if (pressed === "del") return { value: draft.slice(0, -1) };

  if (pressed === "x" || pressed === "×") {
    if (!draft || draft === "." || draft === "0.") {
      return { value: draft, notice: "Enter the quantity first, then × entries." };
    }
    if (/[×xX*]/.test(draft)) {
      return { value: draft, notice: "Entries count is already started." };
    }
    return { value: `${draft} × ` };
  }

  const afterTimes = /[×xX*]/.test(draft);

  if (pressed === ".") {
    if (afterTimes) {
      return { value: draft, notice: "Entries must be a whole number." };
    }
    const qtySide = draft;
    if (qtySide.includes(".")) return { value: draft, notice: "Only one decimal point." };
    return { value: qtySide === "" ? "0." : `${qtySide}.` };
  }

  // Digit
  if (afterTimes) {
    const parts = draft.split(TIMES_SPLIT);
    const timesSide = (parts[1] ?? "").replace(/\s/g, "");
    if (timesSide.length >= 3) return { value: draft, notice: `Entries can be at most ${TIMES_MAX}.` };
    const nextTimes = timesSide === "0" ? pressed : timesSide + pressed;
    const n = Number(nextTimes);
    if (Number.isFinite(n) && n > TIMES_MAX) {
      return { value: draft, notice: `Entries can be at most ${TIMES_MAX}.` };
    }
    const qtySide = parts[0] ?? "";
    return { value: `${qtySide.replace(/\s+$/, "")} × ${nextTimes}` };
  }

  const digits = draft.replace(".", "");
  if (digits.length >= 12) return { value: draft, notice: "That's as long as a quantity can get." };
  return { value: draft === "0" ? pressed : draft + pressed };
}

export function quantityRepeatHint(): string {
  return "<i>Optional: qty × entries — e.g. 200 × 5 adds five separate entries of 200 (not 1000).</i>";
}
