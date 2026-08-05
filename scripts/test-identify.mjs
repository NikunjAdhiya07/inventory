/**
 * End-to-end test of lib/ai.ts identifyItemFromImage (Nemotron only).
 * Usage: node --experimental-strip-types scripts/test-identify.mjs
 * or: npx tsx scripts/test-identify.mjs
 */
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (!m || process.env[m[1]]) continue;
  process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { identifyItemFromImage } = await import("../lib/ai.ts");
const img = await fetch("https://assets.ngc.nvidia.com/products/api-catalog/phi-3-5-vision/example1b.jpg");
const buf = Buffer.from(await img.arrayBuffer());
const labels = await identifyItemFromImage(buf, "image/jpeg");
console.log("labels", labels);
process.exit(labels.length ? 0 : 1);
