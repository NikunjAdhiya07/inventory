// Extra questions an admin attaches to a Movement Type. Asked by the Telegram
// search-group bot after location + qty (and before legacy remarks/reference).
// Built on the Workflows page — not hardcoded in the bot.

export type MoveQuestionKind = "boolean" | "string" | "number" | "select";

/** Per-LOV-option ledger sign override (Accept). Unset / none = use movement direction. */
export type StockOptionEffect = "stock_in" | "stock_out" | "none";

export type MoveQuestion = {
  id: string;
  type: MoveQuestionKind;
  label: string;
  required: boolean;
  order: number;
  // select only — button labels offered to the user
  options?: string[];
  /**
   * select only — map option label → stock effect on Accept.
   * e.g. { Increase: "stock_in", Decrease: "stock_out" }
   */
  optionEffects?: Record<string, StockOptionEffect>;
  placeholder?: string;
};

export type MoveAnswer = {
  id: string;
  label: string;
  type: MoveQuestionKind;
  value: string | number | boolean;
  display: string;
};

const KINDS = new Set<MoveQuestionKind>(["boolean", "string", "number", "select"]);
const EFFECTS = new Set<StockOptionEffect>(["stock_in", "stock_out", "none"]);

export function newQuestionId(): string {
  // Works in Node and in the browser (Workflows builder).
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `q_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return `q_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}

function normalizeOptionEffects(
  raw: unknown,
  options: string[] | undefined
): Record<string, StockOptionEffect> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !options?.length) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, StockOptionEffect> = {};
  for (const opt of options) {
    const v = String(src[opt] ?? "").trim() as StockOptionEffect;
    if (EFFECTS.has(v) && v !== "none") out[opt] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function normalizeQuestions(raw: unknown): MoveQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: MoveQuestion[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = String(r.type ?? "") as MoveQuestionKind;
    if (!KINDS.has(type)) continue;
    const label = String(r.label ?? "").trim().slice(0, 120);
    if (!label) continue;
    const id = String(r.id ?? "").trim() || newQuestionId();
    const options =
      type === "select"
        ? (Array.isArray(r.options) ? r.options : String(r.optionsText ?? "").split("\n"))
            .map((o) => String(o ?? "").trim())
            .filter(Boolean)
            .slice(0, 20)
        : undefined;
    if (type === "select" && (!options || !options.length)) continue;
    const optionEffects =
      type === "select" ? normalizeOptionEffects(r.optionEffects, options) : undefined;
    out.push({
      id,
      type,
      label,
      required: Boolean(r.required),
      order: Number.isFinite(Number(r.order)) ? Number(r.order) : i,
      ...(options ? { options } : {}),
      ...(optionEffects ? { optionEffects } : {}),
      ...(r.placeholder ? { placeholder: String(r.placeholder).trim().slice(0, 80) } : {}),
    });
  }
  return out.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)).map((q, i) => ({ ...q, order: i }));
}

/**
 * Resolve stock effect from answered select questions.
 * When several selects define effects, the last one in `questionsInOrder` wins.
 */
export function resolveStockEffectFromAnswers(
  questionsInOrder: MoveQuestion[],
  answers: Record<string, { value: string | number | boolean; display: string }> | undefined
): "stock_in" | "stock_out" | undefined {
  if (!answers) return undefined;
  let effect: "stock_in" | "stock_out" | undefined;
  for (const q of questionsInOrder) {
    if (q.type !== "select" || !q.optionEffects) continue;
    const ans = answers[q.id];
    if (!ans) continue;
    const key = String(ans.display ?? ans.value ?? "").trim();
    const mapped = q.optionEffects[key];
    if (mapped === "stock_in" || mapped === "stock_out") effect = mapped;
  }
  return effect;
}

export function questionLibrary(): { type: MoveQuestionKind; name: string; desc: string; icon: string }[] {
  return [
    { type: "boolean", name: "Yes / No", desc: "Ask a yes-or-no question", icon: "☑" },
    { type: "string", name: "Text", desc: "Free-text answer typed in the group", icon: "Aa" },
    { type: "number", name: "Number", desc: "Numeric answer on an inline keypad", icon: "#" },
    { type: "select", name: "List", desc: "Pick one value from a list of options", icon: "≡" },
  ];
}
