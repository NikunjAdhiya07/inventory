// NVIDIA NIM / Nemotron vision + text for the Telegram entry bot.
// Ollama is intentionally not used — only NVIDIA_API_KEY credentials.
//
// Env:
//   NVIDIA_API_KEY (required unless AI_MOCK=true)
//   NVIDIA_BASE_URL (default https://integrate.api.nvidia.com/v1)
//   NVIDIA_VISION_MODEL (default nvidia/nemotron-3-nano-omni-30b-a3b-reasoning)
//   NVIDIA_TEXT_MODEL (default nvidia/nemotron-3-nano-30b-a3b)
//   AI_MOCK=true — stub labels without a network call
//   AI_TIMEOUT_MS, AI_MAX_IMAGE_BYTES, AI_VISION_MAX_TOKENS

const BASE_URL = (process.env.NVIDIA_BASE_URL || process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(
  /\/$/,
  ""
);
const API_KEY = (process.env.NVIDIA_API_KEY || process.env.AI_API_KEY || "").trim();
const VISION_MODEL =
  process.env.NVIDIA_VISION_MODEL || process.env.AI_VISION_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const TEXT_MODEL = process.env.NVIDIA_TEXT_MODEL || process.env.AI_TEXT_MODEL || "nvidia/nemotron-3-nano-30b-a3b";
const MOCK = /^(1|true|yes)$/i.test(process.env.AI_MOCK || "");
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 90_000;
// Reasoning VLMs burn tokens on thinking; leave room for the JSON answer.
const VISION_MAX_TOKENS = Number(process.env.AI_VISION_MAX_TOKENS) || 1024;
const TEXT_MAX_TOKENS = Number(process.env.AI_TEXT_MAX_TOKENS) || 256;
const MAX_IMAGE_BYTES = Number(process.env.AI_MAX_IMAGE_BYTES) || 1_200_000;

export function aiConfigured(): boolean {
  return MOCK || Boolean(API_KEY);
}

type ChatContent = string | { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function parseLabelJson(raw: string): string[] {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1")
    .trim();
  const arrMatch = cleaned.match(/\[[\s\S]*?\]/);
  if (arrMatch) {
    try {
      const parsed = JSON.parse(arrMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((x) => {
            if (typeof x === "string") return x.trim();
            if (x && typeof x === "object" && "label" in x) return String((x as { label: unknown }).label).trim();
            return "";
          })
          .filter(Boolean)
          .slice(0, 12);
      }
    } catch {
      /* fall through */
    }
  }
  const line = cleaned
    .split(/\n/)
    .map((l) => l.replace(/^[-*\d.)]+\s*/, "").trim())
    .find((l) => l && !/^none$/i.test(l) && !/^thinking/i.test(l));
  if (!line) return [];
  return line
    .split(/,|\/|\bor\b/i)
    .map((s) => s.replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 10);
}

function extractMessageText(message: {
  content?: unknown;
  reasoning_content?: unknown;
  reasoning?: unknown;
}): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
    else if (Array.isArray(v)) {
      for (const p of v) {
        if (typeof p === "string") parts.push(p);
        else if (p && typeof p === "object" && "text" in p) parts.push(String((p as { text: unknown }).text));
      }
    }
  };
  // Prefer final answer content; fall back to reasoning if that is all we got.
  push(message.content);
  if (!parts.length) {
    push(message.reasoning_content);
    push(message.reasoning);
  }
  return parts.join("\n").trim();
}

async function nvidiaChat(
  model: string,
  messages: { role: string; content: ChatContent | ChatContent[] }[],
  maxTokens: number
): Promise<string> {
  if (!API_KEY) throw new Error("NVIDIA_API_KEY is not set");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: maxTokens,
      // Nemotron Omni thinks by default — disable so labels fit in the budget.
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NVIDIA ${res.status}: ${body.slice(0, 280)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const text = extractMessageText(choice?.message || {});
  if (!text) {
    throw new Error(`NVIDIA empty content (finish=${choice?.finish_reason || "?"})`);
  }
  return text;
}

function maybeShrink(bytes: Buffer): Buffer {
  if (bytes.length <= MAX_IMAGE_BYTES) return bytes;
  throw new Error(`image too large (${bytes.length} bytes; max ${MAX_IMAGE_BYTES})`);
}

const VISION_PROMPT =
  `Look at this photo and name the physical object(s) shown for a warehouse inventory system.\n` +
  `Reply with ONLY a JSON array of 4–8 short English names / reference spellings, most likely first.\n` +
  `Include the common product name PLUS alternate names people might type (slang, typos, short forms).\n` +
  `Example for a USB-C cable: ["USB-C cable","USB C cable","C type cable","C-type wire","Type C cable","USBC cable"]\n` +
  `Example for a mouse: ["Mouse","Computer mouse","Wireless mouse","USB mouse"]\n` +
  `Always guess — never return an empty array. No sentences. No markdown. JSON array only.`;

const VISION_PROMPT_RETRY =
  `What object is in this image? Reply ONLY a JSON array of 4–8 short names and common alternate spellings (e.g. ["USB-C cable","C type cable"]). Always include at least one guess.`;

/** Identify inventory item names + alternate reference spellings from a photo. */
export async function identifyItemFromImage(
  bytes: Buffer,
  mime = "image/jpeg",
  hint?: string
): Promise<string[]> {
  if (MOCK) {
    const fromHint = (hint || "").trim();
    if (fromHint) return [fromHint, `${fromHint} item`, `usb ${fromHint}`, `c type ${fromHint}`].slice(0, 6);
    return ["Mouse", "Computer mouse", "USB mouse", "Wireless mouse"];
  }

  if (!API_KEY) {
    console.error("[ai] NVIDIA_API_KEY missing — cannot identify image");
    return [];
  }

  const payload = maybeShrink(bytes);
  const dataUrl = `data:${mime};base64,${payload.toString("base64")}`;
  const hintLine = hint ? `\nCaption hint: "${hint.slice(0, 80)}"` : "";
  const prompts = [VISION_PROMPT + hintLine, VISION_PROMPT_RETRY + hintLine];

  let lastRaw = "";
  let lastErr: unknown = null;

  for (const prompt of prompts) {
    try {
      const raw = await nvidiaChat(
        VISION_MODEL,
        [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl } },
              { type: "text", text: prompt },
            ],
          },
        ],
        VISION_MAX_TOKENS
      );
      lastRaw = raw;
      const labels = parseLabelJson(raw);
      if (labels.length) return labels;
      console.warn("[ai] Nemotron empty/unparseable labels, retrying…", raw.slice(0, 200));
    } catch (err) {
      lastErr = err;
      console.error("[ai] Nemotron vision attempt failed:", err);
    }
  }

  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  console.error("[ai] Nemotron returned no parseable labels:", lastRaw.slice(0, 400));
  return [];
}

/** Extra reference spellings for a confirmed product name (typos, slang, short forms). */
export async function expandReferenceNames(canonical: string, seed: string[] = []): Promise<string[]> {
  const base = [canonical, ...seed].map((s) => s.trim()).filter(Boolean);
  const local = localReferenceExpansions(canonical);
  const merged = uniqueNames([...base, ...local]);

  if (MOCK || !API_KEY) return merged.slice(0, 12);

  try {
    const raw = await nvidiaChat(
      TEXT_MODEL,
      [
        {
          role: "user",
          content:
            `Product name: "${canonical}"\n` +
            `Known labels: ${merged.slice(0, 8).join(", ") || "(none)"}\n` +
            `List alternate reference names warehouse staff might type (slang, short forms, common misspellings).\n` +
            `Example if product is USB-C cable: ["C type cable","C-type wire","usb c cable","type c cable","usbc wire"]\n` +
            `Reply ONLY a JSON array of 4–10 short strings. No sentences.`,
        },
      ],
      400
    );
    return uniqueNames([...merged, ...parseLabelJson(raw)]).slice(0, 16);
  } catch (err) {
    console.error("[ai] expandReferenceNames failed:", err);
    return merged.slice(0, 12);
  }
}

/** Cheap deterministic variants so we still tag items when the text model is slow. */
export function localReferenceExpansions(name: string): string[] {
  const n = name.trim();
  if (!n) return [];
  const out: string[] = [];
  const lower = n.toLowerCase();

  const push = (s: string) => {
    const t = s.trim().replace(/\s+/g, " ");
    if (t && t.toLowerCase() !== lower) out.push(t);
  };

  push(n.replace(/-/g, " "));
  push(n.replace(/\s+/g, "-"));
  push(n.replace(/-/g, ""));

  // USB-C / Type-C style cables & wires
  if (/\busb[-\s]?c\b/i.test(n) || /\bc[-\s]?type\b/i.test(n) || /\btype[-\s]?c\b/i.test(n)) {
    push("C type cable");
    push("C-type cable");
    push("C type wire");
    push("C-type wire");
    push("USB C cable");
    push("USB-C cable");
    push("USBC cable");
    push("Type C cable");
    push("Type-C cable");
    push("usb c type cable");
  }
  if (/\bhdmi\b/i.test(n)) {
    push("HDMI cable");
    push("hdmi wire");
  }
  if (/\bmouse\b/i.test(n)) {
    push("Computer mouse");
    push("USB mouse");
  }
  if (/\bkeyboard\b/i.test(n)) {
    push("Computer keyboard");
    push("USB keyboard");
  }

  return out;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const t = raw.trim().replace(/\s+/g, " ").slice(0, 80);
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export async function normalizeItemName(typed: string, knownNames: string[]): Promise<string | null> {
  const q = typed.trim();
  if (!q || MOCK || !API_KEY) return null;

  const sample = knownNames.slice(0, 40).join(", ");
  try {
    const raw = await nvidiaChat(
      TEXT_MODEL,
      [
        {
          role: "user",
          content:
            `The warehouse worker typed "${q}" (likely misspelled).\n` +
            `Known products (sample): ${sample || "(none)"}.\n` +
            `Reply with ONLY the corrected short product name, or ONLY the word NONE if unsure.`,
        },
      ],
      TEXT_MAX_TOKENS
    );
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^["']|["']$/g, "").trim();
    if (!cleaned || /^none$/i.test(cleaned)) return null;
    return cleaned.slice(0, 80);
  } catch (err) {
    console.error("[ai] normalizeItemName failed:", err);
    return null;
  }
}

/**
 * Canonical Product Master name for a free-text entry (spelling, casing, clarity).
 * Always returns a short name when the model responds; callers compare to decide
 * whether anything actually changed.
 */
export async function fixProductName(raw: string): Promise<string | null> {
  const q = raw.trim().slice(0, 80);
  if (!q) return null;

  if (MOCK) {
    // Deterministic "cleanup" so tests see a rename without NVIDIA.
    const titled = q
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
      .join(" ")
      .trim();
    return titled || q;
  }
  if (!API_KEY) return null;

  try {
    const rawOut = await nvidiaChat(
      TEXT_MODEL,
      [
        {
          role: "user",
          content:
            `Warehouse inventory item name typed by a worker: "${q}"\n` +
            `Rewrite it as the official Product Master name:\n` +
            `- Fix spelling and obvious typos\n` +
            `- Use clear Title Case (e.g. "USB-C Cable", "HDMI Cable 2m")\n` +
            `- Keep it short (product name only, no sentences)\n` +
            `- Keep meaningful size/colour details the worker included\n` +
            `Reply with ONLY the fixed name. If it is already perfect, reply with the same name.`,
        },
      ],
      TEXT_MAX_TOKENS
    );
    const cleaned = rawOut
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^["']|["']$/g, "")
      .replace(/^[-*]\s*/, "")
      .trim()
      .split(/\n/)[0]
      ?.trim()
      .slice(0, 80);
    if (!cleaned || /^none$/i.test(cleaned)) return null;
    return cleaned;
  } catch (err) {
    console.error("[ai] fixProductName failed:", err);
    return null;
  }
}

export type CategorySuggestion = { category: string; subcategory: string };

/**
 * Pick the best existing category / subcategory for a product name.
 * `categoryPaths` are display trails like "Electronics" or "Electronics › Cables".
 */
export async function suggestCategoryForProduct(
  productName: string,
  categoryPaths: string[]
): Promise<CategorySuggestion | null> {
  const name = productName.trim();
  if (!name || !categoryPaths.length) return null;

  if (MOCK) {
    const first = categoryPaths[0] || "";
    const parts = first.split(/\s*›\s*/).map((s) => s.trim()).filter(Boolean);
    return parts.length
      ? { category: parts[0], subcategory: parts[1] || "" }
      : null;
  }
  if (!API_KEY) return null;

  const sample = categoryPaths.slice(0, 80).join("\n");
  try {
    const raw = await nvidiaChat(
      TEXT_MODEL,
      [
        {
          role: "user",
          content:
            `Product name: "${name}"\n` +
            `Choose the single best category path from this list (exact spelling):\n${sample}\n\n` +
            `Reply ONLY JSON: {"path":"<exact path from list>"}\n` +
            `If none fit, reply {"path":""}.`,
        },
      ],
      200
    );
    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1")
      .trim();
    const match = cleaned.match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { path?: unknown; category?: unknown; subcategory?: unknown };
    let path = typeof parsed.path === "string" ? parsed.path.trim() : "";
    if (!path && typeof parsed.category === "string") {
      const cat = parsed.category.trim();
      const sub = typeof parsed.subcategory === "string" ? parsed.subcategory.trim() : "";
      path = sub ? `${cat} › ${sub}` : cat;
    }
    if (!path) return null;

    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const hit =
      categoryPaths.find((p) => norm(p) === norm(path)) ||
      categoryPaths.find((p) => norm(p).includes(norm(path)) || norm(path).includes(norm(p)));
    if (!hit) return null;
    const parts = hit.split(/\s*›\s*/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return null;
    return {
      category: parts[0],
      subcategory: parts.length > 1 ? parts[parts.length - 1] : "",
    };
  } catch (err) {
    console.error("[ai] suggestCategoryForProduct failed:", err);
    return null;
  }
}
