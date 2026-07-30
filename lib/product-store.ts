import { ObjectId, type Db, type Document } from "mongodb";
import { cached } from "./cache";
import { MAX_ATTRIBUTES, normalizeAttributes, productNumberKey, trimmed, type ProductAttribute } from "./products";

// Server-side Product Master access. Kept out of `lib/products.ts` so that the
// pure shapes and matching helpers stay importable from client components
// without dragging the Mongo driver into the browser bundle.

export type ProductWriteResult =
  | { ok: true; doc: Document }
  | { ok: false; status: number; error: string };

// Build (or patch) a product document from a request body. Every field the
// client can set is coerced here, so neither route handler has to trust the
// shape of what it was sent.
//
// `existing` is passed on edit: only the keys actually present in the body are
// touched, so a PATCH that flips the status can't blank out the attributes.
export function buildProductDoc(body: unknown, existing?: Document): ProductWriteResult {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "Invalid request body." };
  const b = body as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const now = new Date().toISOString();
  const doc: Document = {};

  if (has("name") || !existing) {
    const name = trimmed(b.name, 120);
    if (!name) return { ok: false, status: 400, error: "Product Name is required." };
    doc.name = name;
  }

  if (has("productNumber") || !existing) {
    const productNumber = trimmed(b.productNumber, 60);
    if (!productNumber) return { ok: false, status: 400, error: "Product Number is required." };
    doc.productNumber = productNumber;
    // Maintained in lockstep with the visible number — it is what the unique
    // index is built on, so it must never be set independently of it.
    doc.productNumberKey = productNumberKey(productNumber);
  }

  if (has("attributes") || !existing) {
    if (Array.isArray(b.attributes) && b.attributes.length > MAX_ATTRIBUTES) {
      return { ok: false, status: 400, error: `A product can carry at most ${MAX_ATTRIBUTES} attributes.` };
    }
    doc.attributes = normalizeAttributes(b.attributes);
  }

  for (const key of ["category", "subcategory", "unit", "desc"]) {
    if (has(key) || !existing) doc[key] = trimmed(b[key], key === "desc" ? 500 : 120);
  }

  if (has("status") || !existing) doc.status = b.status === "Inactive" ? "Inactive" : "Active";

  doc.updatedAt = now;
  if (!existing) doc.createdAt = now;

  return { ok: true, doc };
}

// Is this product number already taken by a DIFFERENT product? The unique index
// is the real guarantee; this exists so the console can say which product holds
// the number instead of surfacing a driver error.
export async function duplicateProductNumber(db: Db, key: string, excludeId?: string): Promise<Document | null> {
  const query: Document = { productNumberKey: key };
  if (excludeId) query._id = { $ne: new ObjectId(excludeId) };
  return db.collection("products").findOne(query, { projection: { name: 1, productNumber: 1 } });
}

// Active products for the bot, cached like every other master on the hot path.
// Sorted deterministically so the callback indices a rendered keyboard produces
// still point at the same products when the tap comes back.
export async function activeProducts(db: Db): Promise<Document[]> {
  return cached("products:active", () =>
    db.collection("products").find({ status: "Active" }).sort({ name: 1, productNumber: 1 }).toArray()
  );
}

// Audit-trail rendering: attributes are a nested array, and the generic
// `JSON.stringify` fallback in `lib/crud.ts` turns them into unreadable JSON in
// the log. Flatten them into one readable line instead.
export function productFieldPairs(doc: Document): [string, string][] {
  const attrs = (Array.isArray(doc.attributes) ? doc.attributes : []) as ProductAttribute[];
  return [
    ["Product", String(doc.name ?? "—")],
    ["Product Number", String(doc.productNumber ?? "—")],
    ["Category", String(doc.category || "—")],
    ["Subcategory", String(doc.subcategory || "—")],
    ["Unit", String(doc.unit || "—")],
    ["Attributes", attrs.length ? attrs.map((a) => `${a.name}: ${a.value}`).join(", ") : "—"],
    ["Status", String(doc.status ?? "—")],
  ];
}
