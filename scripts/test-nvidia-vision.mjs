/**
 * Quick Nemotron vision smoke test (NVIDIA only).
 * Usage: node scripts/test-nvidia-vision.mjs
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!m || process.env[m[1]]) continue;
  process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const base = (process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const key = process.env.NVIDIA_API_KEY;
const model = process.env.NVIDIA_VISION_MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

if (!key) {
  console.error("NVIDIA_API_KEY missing");
  process.exit(1);
}

const mode = process.argv[2] || "url"; // url | b64
const remote = "https://assets.ngc.nvidia.com/products/api-catalog/phi-3-5-vision/example1b.jpg";

let imageUrl = remote;
if (mode === "b64") {
  const img = await fetch(remote);
  const buf = Buffer.from(await img.arrayBuffer());
  imageUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
  console.log("base64 bytes", buf.length, "dataUrl length", imageUrl.length);
}

console.log("Calling", model, "mode=", mode, "…");

const r = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          {
            type: "text",
            text: 'Identify the inventory item. Reply ONLY with a JSON array of 1-5 short names. Example: ["Mouse"]',
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 1024,
    chat_template_kwargs: { enable_thinking: false },
  }),
  signal: AbortSignal.timeout(90_000),
});

const body = await r.text();
console.log("status", r.status);
console.log(body.slice(0, 2500));
process.exit(r.ok ? 0 : 1);
