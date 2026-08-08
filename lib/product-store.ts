import { ObjectId, type Db, type Document } from "mongodb";
import { cached, invalidateCollection } from "./cache";
import { isDuplicateKeyError } from "./mongodb";
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

// Find an Active product by name, ignoring case and surrounding whitespace.
// Used when a Telegram entry typed a free-text item name that should still
// land on Product Master (and therefore be searchable from the Search group).
export async function findActiveProductByName(db: Db, name: string): Promise<Document | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const products = await activeProducts(db);
  return products.find((p) => String(p.name ?? "").trim().toLowerCase() === needle) ?? null;
}

// Ensure a Product Master row exists for a free-text inventory entry. The
// ledger and Search group are product-keyed — without this, a completed entry
// that only captured an item name never appears in search and never posts stock.
//
// Reuses an existing Active product of the same name (case-insensitive) when
// one exists; otherwise creates an AUTO- numbered product stamped with the
// entry's category / unit so the catalogue is immediately usable.
export async function ensureProductForEntry(
  db: Db,
  opts: {
    name: string;
    ticketNumber: string;
    category?: string;
    subcategory?: string;
    unit?: string;
  }
): Promise<{ id: string; name: string; productNumber: string; category: string; subcategory: string; unit: string; attributes: ProductAttribute[] } | null> {
  const name = trimmed(opts.name, 120);
  if (!name) return null;

  const existing = await findActiveProductByName(db, name);
  if (existing) {
    return {
      id: existing._id.toString(),
      name: String(existing.name ?? name),
      productNumber: String(existing.productNumber ?? ""),
      category: String(existing.category ?? ""),
      subcategory: String(existing.subcategory ?? ""),
      unit: String(existing.unit ?? ""),
      attributes: Array.isArray(existing.attributes)
        ? (existing.attributes as ProductAttribute[]).filter((a) => a?.name && a?.value)
        : [],
    };
  }

  const productNumber = `AUTO-${opts.ticketNumber}`;
  const now = new Date().toISOString();
  const category = trimmed(opts.category, 120);
  const subcategory = trimmed(opts.subcategory, 120);
  const unit = trimmed(opts.unit, 120);
  const doc = {
    name,
    productNumber,
    productNumberKey: productNumberKey(productNumber),
    category,
    subcategory,
    unit,
    desc: `Created automatically from inventory entry ${opts.ticketNumber}.`,
    attributes: [] as ProductAttribute[],
    status: "Active" as const,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const res = await db.collection("products").insertOne(doc as never);
    // Search reads the catalogue from cache; without this the new product is
    // invisible until the TTL lapses.
    invalidateCollection("products");
    return {
      id: res.insertedId.toString(),
      name,
      productNumber,
      category,
      subcategory,
      unit,
      attributes: [],
    };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    // Two entries finishing at once minted the same AUTO number, or a product
    // of this name landed between the read and the write. Prefer the name match
    // (same physical item) then fall back to the raced AUTO row.
    const byName = await findActiveProductByName(db, name);
    if (byName) {
      return {
        id: byName._id.toString(),
        name: String(byName.name ?? name),
        productNumber: String(byName.productNumber ?? ""),
        category: String(byName.category ?? ""),
        subcategory: String(byName.subcategory ?? ""),
        unit: String(byName.unit ?? ""),
        attributes: Array.isArray(byName.attributes)
          ? (byName.attributes as ProductAttribute[]).filter((a) => a?.name && a?.value)
          : [],
      };
    }
    const raced = await db.collection("products").findOne({ productNumberKey: productNumberKey(productNumber) });
    if (!raced) return null;
    return {
      id: raced._id.toString(),
      name: String(raced.name ?? name),
      productNumber: String(raced.productNumber ?? productNumber),
      category: String(raced.category ?? ""),
      subcategory: String(raced.subcategory ?? ""),
      unit: String(raced.unit ?? ""),
      attributes: Array.isArray(raced.attributes)
        ? (raced.attributes as ProductAttribute[]).filter((a) => a?.name && a?.value)
        : [],
    };
  }
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
