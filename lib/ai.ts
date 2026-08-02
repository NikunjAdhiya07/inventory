// Vision + text helpers for the Telegram entry bot.
//
// Primary: NVIDIA NIM (OpenAI-compatible) with thinking disabled for speed.
// Fallback: local Ollama vision (OLLAMA_BASE_URL + OLLAMA_VISION_MODEL) when set.
// Dev: AI_MOCK=true returns stub labels without a network call.

const BASE_URL = (process.env.NVIDIA_BASE_URL || process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(
  /\/$/,
  ""
);
const API_KEY = process.env.NVIDIA_API_KEY || process.env.AI_API_KEY || "";
const VISION_MODEL =
  process.env.NVIDIA_VISION_MODEL || process.env.AI_VISION_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const TEXT_MODEL = process.env.NVIDIA_TEXT_MODEL || process.env.AI_TEXT_MODEL || "nvidia/nemotron-3-nano-30b-a3b";
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || "").replace(/\/$/, "");
const OLLAMA_VISION = process.env.OLLAMA_VISION_MODEL || "qwen2.5vl:7b";
const MOCK = /^(1|true|yes)$/i.test(process.env.AI_MOCK || "");
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 45000;
// Keep payloads small — Telegram "largest" photos can be several MB as base64.
const MAX_IMAGE_BYTES = Number(process.env.AI_MAX_IMAGE_BYTES) || 1_200_000;

export function aiConfigured(): boolean {
  return MOCK || Boolean(API_KEY) || Boolean(OLLAMA_BASE);
}

type ChatContent = string | { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function parseLabelJson(raw: string): string[] {
  const cleaned = raw
    // Strip common thinking / reasoning wrappers if the model ignored our flag.
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
          .slice(0, 8);
      }
    } catch {
      /* fall through */
    }
  }
  // Prose fallback: split on commas / newlines / "or"
  const line = cleaned
    .split(/\n/)
    .map((l) => l.replace(/^[-*\d.)]+\s*/, "").trim())
    .find((l) => l && !/^none$/i.test(l));
  if (!line) return [];
  return line
    .split(/,|\/|\bor\b/i)
    .map((s) => s.replace(/^["']|["']$/g, "").trim())
    .filter((s) => s.length > 1 && s.length < 60)
    .slice(0, 5);
}

async function nvidiaChat(model: string, messages: { role: string; content: ChatContent | ChatContent[] }[]): Promise<string> {
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
      temperature: 0.1,
      max_tokens: 256,
      // Omni models think by default — that burns tokens/time before any labels.
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NVIDIA ${res.status}: ${body.slice(0, 280)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

async function ollamaVision(bytes: Buffer, hint?: string): Promise<string[]> {
  if (!OLLAMA_BASE) throw new Error("OLLAMA_BASE_URL is not set");
  const prompt =
    `Identify the inventory / office / warehouse item in this photo.\n` +
    `Reply with ONLY a JSON array of 1-5 short product names, most likely first.\n` +
    `Example: ["Mouse","Computer mouse","USB mouse"]` +
    (hint ? `\nUser caption: ${hint.slice(0, 80)}` : "");

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_VISION,
      stream: false,
      messages: [
        {
          role: "user",
          content: prompt,
          images: [bytes.toString("base64")],
        },
      ],
      options: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return parseLabelJson(String(data.message?.content ?? ""));
}

function maybeShrink(bytes: Buffer): Buffer {
  if (bytes.length <= MAX_IMAGE_BYTES) return bytes;
  // Without an image codec we can't resize — refuse oversized payloads so the
  // caller can fall back to a smaller Telegram size instead of timing out.
  throw new Error(`image too large (${bytes.length} bytes)`);
}

const VISION_PROMPT =
  `You identify warehouse / office inventory items in photos for a stock system.\n` +
  `Return ONLY a JSON array of 1–5 short product name strings, most likely first.\n` +
  `Use common English product names (e.g. "Mouse", "USB-C cable", "Keyboard").\n` +
  `No sentences. No markdown. JSON array only.`;

// Identify inventory item names from a photo (JPEG/PNG bytes).
export async function identifyItemFromImage(
  bytes: Buffer,
  mime = "image/jpeg",
  hint?: string
): Promise<string[]> {
  if (MOCK) {
    const fromHint = (hint || "").trim();
    return fromHint ? [fromHint, `${fromHint} item`] : ["Mouse", "Computer mouse", "USB mouse"];
  }

  const errors: string[] = [];
  const prompt = VISION_PROMPT + (hint ? `\nCaption hint: "${hint.slice(0, 80)}"` : "");

  if (API_KEY) {
    try {
      const payload = maybeShrink(bytes);
      const dataUrl = `data:${mime};base64,${payload.toString("base64")}`;
      const raw = await nvidiaChat(VISION_MODEL, [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ]);
      const labels = parseLabelJson(raw);
      if (labels.length) return labels;
      errors.push(`NVIDIA returned no labels: ${raw.slice(0, 120)}`);
    } catch (err) {
      errors.push(String(err));
      console.error("[ai] NVIDIA vision failed:", err);
    }
  }

  if (OLLAMA_BASE) {
    try {
      const labels = await ollamaVision(maybeShrink(bytes), hint);
      if (labels.length) return labels;
      errors.push("Ollama returned no labels");
    } catch (err) {
      errors.push(String(err));
      console.error("[ai] Ollama vision failed:", err);
    }
  }

  if (errors.length) console.error("[ai] identifyItemFromImage exhausted:", errors.join(" | "));
  return [];
}

export async function normalizeItemName(typed: string, knownNames: string[]): Promise<string | null> {
  const q = typed.trim();
  if (!q || MOCK || !API_KEY) return null;

  const sample = knownNames.slice(0, 40).join(", ");
  try {
    const raw = await nvidiaChat(TEXT_MODEL, [
      {
        role: "user",
        content:
          `The warehouse worker typed "${q}" (likely misspelled).\n` +
          `Known products (sample): ${sample || "(none)"}.\n` +
          `Reply with ONLY the corrected short product name, or ONLY the word NONE if unsure.`,
      },
    ]);
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^["']|["']$/g, "").trim();
    if (!cleaned || /^none$/i.test(cleaned)) return null;
    return cleaned.slice(0, 80);
  } catch (err) {
    console.error("[ai] normalizeItemName failed:", err);
    return null;
  }
}
