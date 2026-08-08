import type { Db } from "mongodb";
import { invalidateCollection } from "./cache";

// Alternate spellings / AI labels linked to a Product Master row.
// Exact alias hits are the cheapest autocorrect for repeat typos.

export type ProductAlias = {
  _id?: unknown;
  productId: string;
  productName: string;
  alias: string;
  aliasKey: string; // lowercased trimmed
  source: "ai" | "user" | "manual";
  hits: number;
  createdAt: string;
  updatedAt: string;
};

const COLLECTION = "productAliases";

export function aliasKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function findAlias(db: Db, raw: string): Promise<ProductAlias | null> {
  const key = aliasKey(raw);
  if (!key) return null;
  return (await db.collection(COLLECTION).findOne({ aliasKey: key })) as ProductAlias | null;
}

export async function listAliasesForProduct(db: Db, productId: string): Promise<ProductAlias[]> {
  return (await db
    .collection(COLLECTION)
    .find({ productId })
    .sort({ hits: -1, alias: 1 })
    .limit(50)
    .toArray()) as ProductAlias[];
}

export async function allAliasKeys(db: Db): Promise<Map<string, ProductAlias>> {
  const rows = (await db.collection(COLLECTION).find({}).limit(5000).toArray()) as ProductAlias[];
  const map = new Map<string, ProductAlias>();
  for (const r of rows) map.set(r.aliasKey, r);
  return map;
}

// Remember that this spelling/label belongs to a product. Safe to call on every confirm.
export async function upsertAliases(
  db: Db,
  productId: string,
  productName: string,
  aliases: string[],
  source: ProductAlias["source"]
): Promise<void> {
  const now = new Date().toISOString();
  const seen = new Set<string>();
  for (const raw of aliases) {
    const key = aliasKey(raw);
    if (!key || key === aliasKey(productName) || seen.has(key)) continue;
    seen.add(key);
    await db.collection(COLLECTION).updateOne(
      { aliasKey: key },
      {
        $set: {
          productId,
          productName,
          alias: raw.trim().slice(0, 80),
          aliasKey: key,
          source,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
        $inc: { hits: 1 },
      },
      { upsert: true }
    );
  }
  // Search group reads products + aliases from process cache — clear both so a
  // just-submitted entry is findable on the next message in this instance.
  invalidateCollection("productAliases");
  invalidateCollection("products");
}
