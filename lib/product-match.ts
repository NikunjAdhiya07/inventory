import type { Db, Document } from "mongodb";
import { allAliasKeys, findAlias, type ProductAlias } from "./product-aliases";
import { activeProducts } from "./product-store";
import { productMatches } from "./products";

export type MatchCandidate = {
  name: string;
  productId?: string;
  productNumber?: string;
  score: number; // 0–100
  source: "exact" | "alias" | "fuzzy" | "ai";
};

// Cheap Levenshtein — catalogue sizes are hundreds, not millions.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function similarity(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return 0;
  if (x === y) return 100;
  if (y.includes(x) || x.includes(y)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return Math.round(70 + ratio * 25);
  }
  const dist = levenshtein(x, y);
  const maxLen = Math.max(x.length, y.length);
  return Math.max(0, Math.round((1 - dist / maxLen) * 100));
}

function pushUnique(out: MatchCandidate[], c: MatchCandidate): void {
  const key = (c.productId || c.name).toLowerCase();
  const existing = out.find((x) => (x.productId || x.name).toLowerCase() === key);
  if (existing) {
    if (c.score > existing.score) Object.assign(existing, c);
    return;
  }
  out.push(c);
}

// Rank Product Master + aliases against free text and optional AI labels.
export async function rankItemSuggestions(
  db: Db,
  opts: { typed?: string; labels?: string[]; limit?: number }
): Promise<MatchCandidate[]> {
  const limit = opts.limit ?? 5;
  const typed = (opts.typed ?? "").trim();
  const labels = (opts.labels ?? []).map((l) => l.trim()).filter(Boolean);
  const out: MatchCandidate[] = [];

  const [products, aliases] = await Promise.all([activeProducts(db), allAliasKeys(db)]);

  if (typed) {
    const aliasHit = await findAlias(db, typed);
    if (aliasHit) {
      pushUnique(out, {
        name: aliasHit.productName,
        productId: aliasHit.productId,
        score: 98,
        source: "alias",
      });
    }

    for (const p of products) {
      const name = String(p.name ?? "");
      const id = p._id.toString();
      if (!name) continue;
      if (name.toLowerCase() === typed.toLowerCase()) {
        pushUnique(out, {
          name,
          productId: id,
          productNumber: String(p.productNumber ?? ""),
          score: 100,
          source: "exact",
        });
        continue;
      }
      if (productMatches(p, typed)) {
        pushUnique(out, {
          name,
          productId: id,
          productNumber: String(p.productNumber ?? ""),
          score: 88,
          source: "fuzzy",
        });
        continue;
      }
      const score = similarity(typed, name);
      if (score >= 62) {
        pushUnique(out, {
          name,
          productId: id,
          productNumber: String(p.productNumber ?? ""),
          score,
          source: "fuzzy",
        });
      }
    }

    for (const [key, a] of aliases) {
      const score = similarity(typed, key);
      if (score >= 70) {
        pushUnique(out, {
          name: a.productName,
          productId: a.productId,
          score: Math.min(95, score),
          source: "alias",
        });
      }
    }
  }

  for (const label of labels) {
    pushUnique(out, { name: label, score: 55, source: "ai" });
    for (const p of products) {
      const name = String(p.name ?? "");
      if (!name) continue;
      const score = Math.max(similarity(label, name), productMatches(p, label) ? 90 : 0);
      if (score >= 60) {
        pushUnique(out, {
          name,
          productId: p._id.toString(),
          productNumber: String(p.productNumber ?? ""),
          score,
          source: score >= 95 ? "exact" : "fuzzy",
        });
      }
    }
    const a = aliases.get(label.toLowerCase());
    if (a) {
      pushUnique(out, { name: a.productName, productId: a.productId, score: 96, source: "alias" });
    }
  }

  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

// Soft filter for product_select / stock search: widen substring match with fuzzy.
export function productMatchesFuzzy(
  p: Document,
  query: string,
  aliases?: Map<string, ProductAlias> | ProductAlias[]
): boolean {
  return scoreProductQuery(p, query, aliases) >= 55;
}

/**
 * Score how well a product matches a search query (0–100), using name /
 * attributes plus SEO-style reference names (productAliases).
 * Used by entry suggestions and the search/request group stock finder.
 */
export function scoreProductQuery(
  p: Document,
  query: string,
  aliases?: Map<string, ProductAlias> | ProductAlias[]
): number {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return 100;

  let best = 0;
  const name = String(p.name ?? "");
  const id = p._id?.toString?.() ?? String((p as { id?: string }).id ?? "");

  if (name.toLowerCase() === q) best = Math.max(best, 100);
  if (productMatches(p, query)) best = Math.max(best, 90);
  best = Math.max(best, similarity(q, name));

  const list: ProductAlias[] = Array.isArray(aliases)
    ? aliases
    : aliases
      ? [...aliases.values()].filter((a) => a.productId === id)
      : [];

  for (const a of list) {
    const key = a.aliasKey || a.alias.toLowerCase();
    if (!key) continue;
    if (key === q) best = Math.max(best, 98);
    else if (key.includes(q) || q.includes(key)) {
      const ratio = Math.min(q.length, key.length) / Math.max(q.length, key.length);
      best = Math.max(best, Math.round(82 + ratio * 14));
    } else {
      best = Math.max(best, similarity(q, key));
    }
  }

  return best;
}

/** Load aliases grouped by productId for stock / SEO search. */
export async function aliasesByProductId(db: Db): Promise<Map<string, ProductAlias[]>> {
  const map = new Map<string, ProductAlias[]>();
  const all = await allAliasKeys(db);
  for (const a of all.values()) {
    const list = map.get(a.productId) || [];
    list.push(a);
    map.set(a.productId, list);
  }
  return map;
}
