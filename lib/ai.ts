// OpenAI-compatible client for NVIDIA NIM (build.nvidia.com).
//
// Env:
//   NVIDIA_API_KEY / AI_API_KEY
//   NVIDIA_BASE_URL (default https://integrate.api.nvidia.com/v1)
//   NVIDIA_VISION_MODEL / NVIDIA_TEXT_MODEL
//   AI_MOCK=true — skip network, return stub labels (dev without credits)

const BASE_URL = (process.env.NVIDIA_BASE_URL || process.env.AI_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(
  /\/$/,
  ""
);
const API_KEY = process.env.NVIDIA_API_KEY || process.env.AI_API_KEY || "";
const VISION_MODEL =
  process.env.NVIDIA_VISION_MODEL || process.env.AI_VISION_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const TEXT_MODEL = process.env.NVIDIA_TEXT_MODEL || process.env.AI_TEXT_MODEL || "nvidia/nemotron-3-nano-30b-a3b";
const MOCK = /^(1|true|yes)$/i.test(process.env.AI_MOCK || "");
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 45000;

export type AiLabel = { label: string; confidence?: number };

export function aiConfigured(): boolean {
  return MOCK || Boolean(API_KEY);
}

type ChatContent = string | { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

async function chat(model: string, messages: { role: string; content: ChatContent | ChatContent[] }[]): Promise<string> {
  if (MOCK) return "";
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
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI ${res.status}: ${body.slice(0, 240)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return String(data.choices?.[0]?.message?.content ?? "").trim();
}

function parseLabelJson(raw: string): string[] {
  // Models often wrap JSON in ``` fences or add prose — pull the first array.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : raw;
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  if (!arrMatch) return [];
  try {
    const parsed = JSON.parse(arrMatch[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => {
        if (typeof x === "string") return x.trim();
        if (x && typeof x === "object" && "label" in x) return String((x as { label: unknown }).label).trim();
        return "";
      })
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

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

  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const prompt =
    `You identify warehouse / office inventory items in photos for a stock system.\n` +
    `Return ONLY a JSON array of 1–5 short product name strings, most likely first.\n` +
    `Use common English product names (e.g. "Mouse", "USB-C cable", "Keyboard").\n` +
    `No sentences, no markdown outside the JSON array.` +
    (hint ? `\nCaption hint from the user: "${hint.slice(0, 80)}"` : "");

  const raw = await chat(VISION_MODEL, [
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
  // Last resort: first non-empty line of prose.
  const line = raw.split("\n").map((l) => l.replace(/^[-*\d.]+\s*/, "").trim()).find(Boolean);
  return line ? [line.slice(0, 60)] : [];
}

// Normalize a misspelled inventory name to a short canonical guess (optional).
export async function normalizeItemName(typed: string, knownNames: string[]): Promise<string | null> {
  const q = typed.trim();
  if (!q) return null;
  if (MOCK) return null;

  const sample = knownNames.slice(0, 40).join(", ");
  const raw = await chat(TEXT_MODEL, [
    {
      role: "user",
      content:
        `The warehouse worker typed "${q}" (likely misspelled).\n` +
        `Known products (sample): ${sample || "(none)"}.\n` +
        `Reply with ONLY the corrected short product name, or ONLY the word NONE if unsure.`,
    },
  ]);
  const cleaned = raw.replace(/^["']|["']$/g, "").trim();
  if (!cleaned || /^none$/i.test(cleaned)) return null;
  return cleaned.slice(0, 80);
}
