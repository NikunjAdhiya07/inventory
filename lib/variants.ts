import { createHash } from "node:crypto";
import type { Db } from "mongodb";
import { invalidateCollection } from "./cache";
import { isDuplicateKeyError } from "./mongodb";
import { productNumberKey, trimmed, type ProductAttribute, type VariantPathSegment } from "./products";

// Variants — what turns a nested drill-down from a questionnaire into an item.
//
// The rule the whole two-bot design rests on:
//
//     a completed identity path IS a product.
//     treeId + pathKey resolves to exactly one productId.
//
// Before this, walking "Wire › Copper › Flexible (FR) › 2.5 sq mm" wrote four
// lines of prose onto the ticket and then posted stock against whatever the
// `product_select` step had captured — so 100 m of red 2.5 sq mm and 50 m of
// black 4 sq mm landed on ONE balance and the ledger read "150 m of Wire". The
// distinction existed only in the text of two tickets, which meant the search
// bot had nothing to drill into and a manager issuing 20 m could not say which
// wire left the shelf.
//
// Resolving the path to a product row fixes both ends at once. The entry bot
// counts stock against the exact thing on the shelf, and the search bot can
// offer a level's options filtered to what is actually in stock — because "in
// stock" is now a fact about a variant rather than about a category.
//
// WHY a product row rather than a `productVariants` collection: every consumer
// downstream — the stock ledger, `RequestLine`, `lib/movements.ts`, the storage
// map, the issue/return flow — already keys on `productId`. Reusing it means
// none of them change. Products were always "half-fixed, half-open" (see
// `lib/products.ts`); a variant is a product whose open half was answered by a
// tree instead of by hand.

export type VariantInput = {
  treeId: string;
  treeName: string;
  // IDENTITY segments only, in the order the tree asked them. The caller is
  // responsible for having dropped capture levels — see `levelIsIdentity`.
  path: VariantPathSegment[];
  // Seeds for a variant being created for the first time. Each is whatever the
  // entry already established; none is required, because a workflow is free not
  // to ask. They are never written back onto a variant that already exists — the
  // first entry defines the item, later entries only count against it.
  category?: string;
  subcategory?: string;
  unit?: string;
};

// Shaped to drop straight into the engine's `ProductSnapshot`, so a resolved
// variant is usable everywhere a chosen product is.
export type ResolvedVariant = {
  id: string;
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  attributes: ProductAttribute[];
  // Whether this call is what brought the item into the catalogue. Only used for
  // the audit trail — the caller behaves the same either way.
  created: boolean;
};

// Case-, spacing- and punctuation-insensitive form of one path value, joined
// into the key the unique index is built on.
//
// This normalisation is the whole of the junk-SKU defence for levels that accept
// a typed answer: "2.5 SQ MM", "2.5 sq mm" and "2.5  sq-mm" are one item, and
// collapsing them here is what stops three of them appearing on the shelf list.
// It cannot save a genuine misspelling ("coper"), which is why the console needs
// a merge — but it removes the class of duplicate that pure keyboard noise makes.
export function variantPathKey(path: VariantPathSegment[]): string {
  return path
    .map((s) =>
      String(s.value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .join("|");
}

// A visibly synthetic product number, derived rather than counted.
//
// Deterministic on purpose: two entries racing the same brand-new path derive
// the SAME number, so the loser hits the unique index and re-reads the winner
// instead of creating a second row under a second number. A counter would hand
// each of them a distinct number and quietly produce the duplicate this whole
// module exists to prevent.
export function variantProductNumber(treeId: string, pathKey: string): string {
  const digest = createHash("sha1").update(`${treeId}:${pathKey}`).digest("hex").slice(0, 10);
  return `VAR-${digest.toUpperCase()}`;
}

// "Wire — Copper · Flexible (FR) · 2.5 sq mm". The tree names the kind of thing
// and the path narrows it, which reads correctly in a search result, on a
// ticket, and in the one-line form the console table shows.
export function variantName(treeName: string, path: VariantPathSegment[]): string {
  const detail = path.map((s) => s.value).filter(Boolean).join(" · ");
  const base = trimmed(treeName, 60) || "Item";
  return trimmed(detail ? `${base} — ${detail}` : base, 120);
}

// The identity path as product attributes.
//
// Not a duplicate of `treePath`: attributes are what every existing surface
// already renders — the bot's confirmation, the request line snapshot, the audit
// log, the console detail panel. Writing the path into them is what makes a
// variant display correctly in all of those without touching any of them.
// `treePath` stays alongside as the structured form the drill-down reads back.
export function variantAttributes(path: VariantPathSegment[]): ProductAttribute[] {
  return path
    .map((s) => ({ name: trimmed(s.label, 40), value: trimmed(s.value, 120) }))
    .filter((a) => a.name && a.value);
}

// Find the product this identity path names, creating it the first time anyone
// logs it.
//
// Auto-creation is deliberate: the store never hand-enumerates the catalogue,
// it builds itself as stock physically arrives, and an employee is never blocked
// mid-entry by an item an admin has not registered yet.
//
// Returns null when the path identifies nothing — a walk that answered only
// capture levels, or none at all. The caller then behaves exactly as it did
// before variants existed.
export async function resolveVariant(db: Db, input: VariantInput): Promise<ResolvedVariant | null> {
  const path = input.path.filter((s) => s && String(s.value ?? "").trim());
  if (!input.treeId || !path.length) return null;

  const pathKey = variantPathKey(path);
  if (!pathKey) return null;

  const products = db.collection("products");
  const existing = await products.findOne({ treeId: input.treeId, pathKey });
  // An Inactive variant is still the item that is physically on the shelf, so it
  // is returned rather than re-created: the ledger has to stay honest about what
  // arrived, and hiding an item from search is a separate decision an admin made
  // on purpose.
  if (existing) return fromDoc(existing, false);

  const productNumber = variantProductNumber(input.treeId, pathKey);
  const now = new Date().toISOString();
  const name = variantName(input.treeName, path);
  const doc = {
    name,
    productNumber,
    productNumberKey: productNumberKey(productNumber),
    category: trimmed(input.category, 120),
    subcategory: trimmed(input.subcategory, 120),
    unit: trimmed(input.unit, 120),
    desc: `Created automatically from the ${trimmed(input.treeName, 60)} drill-down.`,
    attributes: variantAttributes(path),
    treeId: input.treeId,
    treeName: trimmed(input.treeName, 60),
    treePath: path.map((s) => ({ label: trimmed(s.label, 40), value: trimmed(s.value, 120) })),
    pathKey,
    status: "Active" as const,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await products.insertOne(doc as never);
    // The bot renders the catalogue from a cached read; without this the new
    // variant is invisible to search until the TTL lapses.
    invalidateCollection("products");
    return fromDoc({ ...doc, _id: res.insertedId }, true);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Another entry created this exact variant between the read above and this
    // insert. Whichever row landed is the one to count against — either index
    // could have caught it, so re-read by the identity that matters.
    const raced = await products.findOne({ treeId: input.treeId, pathKey });
    if (raced) return fromDoc(raced, false);
    // Only reachable if the collision was on productNumberKey against a row that
    // is NOT this variant — a hand-typed product that happens to hold the
    // derived number. Vanishingly unlikely, and not worth failing an entry over.
    return null;
  }
}

function fromDoc(doc: Record<string, unknown>, created: boolean): ResolvedVariant {
  const attributes = Array.isArray(doc.attributes) ? (doc.attributes as ProductAttribute[]) : [];
  return {
    id: String((doc._id as { toString(): string })?.toString() ?? ""),
    name: String(doc.name ?? ""),
    productNumber: String(doc.productNumber ?? ""),
    category: String(doc.category ?? ""),
    subcategory: String(doc.subcategory ?? ""),
    unit: String(doc.unit ?? ""),
    attributes,
    created,
  };
}
