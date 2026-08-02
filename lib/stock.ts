import type { Db, Document } from "mongodb";
import { cached, invalidate } from "./cache";
import { locationPathFrom, locationsByIdForPaths } from "./locations";
import { isDuplicateKeyError } from "./mongodb";
import { activeProducts } from "./product-store";
import { aliasesByProductId, scoreProductQuery } from "./product-match";
import { type ProductAttribute } from "./products";

// The stock ledger.
//
// On-hand is NEVER stored as a number on a product or a location. It is summed
// from movement rows, per product per location, every time it is asked for. That
// costs an aggregation, and it buys the one property a running total cannot
// give: the balance and its own history can never disagree. A miskeyed issue is
// corrected by writing the opposite movement, not by editing a total that
// nothing else can verify.
//
// Receipts come from the inventory-entry bot (a completed entry adds stock at
// the location it was logged against). Issues come from the request bot (an
// Inventory Manager accepting a request takes the items out). Both write through
// `recordMovement`.

export type MovementReason =
  | "receipt" // an inventory entry was completed in the entry group
  | "issue" // an Inventory Manager accepted a request and handed items over
  | "return" // an accepted request was cancelled and the items went back
  | "purchase-receipt" // a purchased item was received into stock
  | "adjustment"; // a manual correction from the console

export type StockMovement = {
  // Deterministic id for this movement. Two attempts to record the same physical
  // event derive the same key and the unique index keeps one — which is what
  // makes a retried webhook update safe.
  movementKey: string;
  productId: string;
  productName: string;
  productNumber: string;
  locationId: string;
  locationPath: string;
  // Signed: positive adds to stock, negative removes. Summing the column is the
  // whole of the balance calculation.
  qty: number;
  unit: string;
  reason: MovementReason;
  refType: "inventoryEntry" | "request";
  refId: string; // the ticket number that caused it
  requestId?: string;
  by: string;
  createdAt: string;
};

// One product's holding at one location.
export type StockLine = {
  productId: string;
  locationId: string;
  locationPath: string;
  qty: number;
  unit: string;
};

// A product that has stock somewhere, with every location holding it.
export type StockHit = {
  productId: string;
  name: string;
  productNumber: string;
  category: string;
  subcategory: string;
  unit: string;
  attributes: ProductAttribute[];
  lines: StockLine[];
  total: number;
};

const STOCK_CACHE_PREFIX = "stock:";
// Deliberately shorter than the 30s master-data default. Stock is the one thing
// here that a user changes and then immediately looks at: a manager accepts a
// request and the next search must not still be offering what they just issued.
const STOCK_TTL_MS = Number(process.env.STOCK_CACHE_TTL_MS) || 5_000;

// Build the idempotency key for a movement. Every caller goes through one of
// these so the shape is defined in exactly one place.
export function receiptKey(ticketNumber: string): string {
  return `receipt:${ticketNumber}`;
}

export function issueKey(requestTicket: string, lineId: string): string {
  return `issue:${requestTicket}:${lineId}`;
}

export function returnKey(requestTicket: string, lineId: string): string {
  return `return:${requestTicket}:${lineId}`;
}

// Write one movement. Returns false when this exact movement was already
// recorded, so a caller can tell a genuine write from a replay.
export async function recordMovement(db: Db, movement: StockMovement): Promise<boolean> {
  try {
    await db.collection("stockMovements").insertOne(movement as never);
  } catch (err) {
    // The unique index on movementKey did its job — this event is already in the
    // ledger. Not an error: it is the retry path working as designed.
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
  // The balance this movement changed is now stale everywhere it was cached.
  invalidate(STOCK_CACHE_PREFIX);
  return true;
}

// Write several movements as one batch — issuing a multi-line request. Written
// unordered so one already-recorded line does not stop the rest, which is what
// makes a partially-completed retry finish cleanly.
export async function recordMovements(db: Db, movements: StockMovement[]): Promise<void> {
  if (!movements.length) return;
  try {
    await db.collection("stockMovements").insertMany(movements as never[], { ordered: false });
  } catch (err) {
    // insertMany surfaces duplicates as a bulk write error even when every other
    // document went in. Anything that is NOT purely duplicates has to propagate.
    if (!isDuplicateKeyError(err) && !isBulkDuplicateOnly(err)) throw err;
  }
  invalidate(STOCK_CACHE_PREFIX);
}

// A bulk write whose every error was a duplicate key. Distinguishes "all of
// these were already recorded" from "the database rejected something real".
function isBulkDuplicateOnly(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errors = (err as { writeErrors?: { code?: number }[] }).writeErrors;
  if (!Array.isArray(errors) || !errors.length) return false;
  return errors.every((e) => e?.code === 11000);
}

type Balance = { productId: string; locationId: string; qty: number; unit: string; locationPath: string };

// Every non-zero balance in the system, keyed `productId:locationId`.
//
// One aggregation for the whole ledger rather than one per product searched: a
// search matching twelve products would otherwise fan out into twelve grouped
// queries, and the result is small enough (one row per product-location pair
// that has ever moved) to hold and filter in memory.
async function balances(db: Db): Promise<Map<string, Balance>> {
  return cached(
    `${STOCK_CACHE_PREFIX}balances`,
    async () => {
      const rows = await db
        .collection("stockMovements")
        .aggregate<{
          _id: { productId: string; locationId: string };
          qty: number;
          unit: string;
          locationPath: string;
        }>([
          {
            $group: {
              _id: { productId: "$productId", locationId: "$locationId" },
              qty: { $sum: "$qty" },
              // The unit travels with the product, so any row's copy is the same
              // one. `$last` just avoids carrying the field through the group.
              unit: { $last: "$unit" },
              // Snapshotted path from the movement — used when the location is
              // Inactive or gone and the live tree cannot name it.
              locationPath: { $last: "$locationPath" },
            },
          },
          // A product-location pair that has netted to zero (or below, from a
          // correction) is not stock and must never be offered.
          { $match: { qty: { $gt: 0 } } },
        ])
        .toArray();

      const map = new Map<string, Balance>();
      for (const r of rows) {
        const productId = String(r._id?.productId ?? "");
        const locationId = String(r._id?.locationId ?? "");
        if (!productId || !locationId) continue;
        map.set(`${productId}:${locationId}`, {
          productId,
          locationId,
          qty: r.qty,
          unit: String(r.unit ?? ""),
          locationPath: String(r.locationPath ?? ""),
        });
      }
      return map;
    },
    STOCK_TTL_MS
  );
}

// On-hand for one product at one location. The authority for "can this request
// line actually be issued".
export async function onHand(db: Db, productId: string, locationId: string): Promise<number> {
  const all = await balances(db);
  return all.get(`${productId}:${locationId}`)?.qty ?? 0;
}

// Uncached on-hand, read straight from the ledger for a single pair.
//
// Every balance the bot renders comes from the cached aggregation, which is what
// keeps a search cheap. Deciding whether stock may actually leave the building
// is the one place that cannot accept a five-second-old answer, so it pays for
// its own round trip.
export async function onHandLive(db: Db, productId: string, locationId: string): Promise<number> {
  const rows = await db
    .collection("stockMovements")
    .aggregate<{ qty: number }>([
      { $match: { productId, locationId } },
      { $group: { _id: null, qty: { $sum: "$qty" } } },
    ])
    .toArray();
  return rows[0]?.qty ?? 0;
}

function productAttributes(p: Document): ProductAttribute[] {
  if (!Array.isArray(p.attributes)) return [];
  return p.attributes
    .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
    .map((a) => ({ name: String(a.name ?? ""), value: String(a.value ?? "") }))
    .filter((a) => a.name && a.value);
}

// Products in stock that match a free-text query, each with the locations
// holding them.
//
// Match uses Product Master (name, number, attributes) PLUS AI/manual reference
// names (SEO keywords in productAliases) — so "c type cable" finds "USB-C Cable"
// when those tags were saved from the entry bot. Only products with a positive
// balance somewhere are returned.
export async function searchStock(db: Db, query: string, limit = 40): Promise<StockHit[]> {
  const [products, all, byId, aliasMap] = await Promise.all([
    activeProducts(db),
    balances(db),
    locationsByIdForPaths(db),
    aliasesByProductId(db),
  ]);

  // Group the balances by product once, so the per-product lookup below is a map
  // hit rather than a scan of every balance in the system.
  const linesByProduct = new Map<string, Balance[]>();
  for (const b of all.values()) {
    const list = linesByProduct.get(b.productId);
    if (list) list.push(b);
    else linesByProduct.set(b.productId, [b]);
  }

  const scored: { hit: StockHit; score: number }[] = [];
  for (const p of products) {
    const productId = p._id.toString();
    const held = linesByProduct.get(productId);
    if (!held?.length) continue;

    const score = scoreProductQuery(p, query, aliasMap.get(productId) || []);
    // 55 ≈ fuzzy / strong keyword hit; below that is noise for stock search.
    if (score < 55) continue;

    const lines: StockLine[] = held
      .map((b) => ({
        productId,
        locationId: b.locationId,
        // Prefer the live tree (covers renames), then the path snapshotted onto
        // the movement (covers Inactive / deleted locations).
        locationPath: locationPathFrom(byId, b.locationId) || b.locationPath || "(unknown location)",
        qty: b.qty,
        unit: b.unit || String(p.unit ?? ""),
      }))
      // Most-stocked location first: it is the one a requester is most likely to
      // be sent to, so it should not be the one below the fold.
      .sort((a, b) => b.qty - a.qty || a.locationPath.localeCompare(b.locationPath));

    scored.push({
      score,
      hit: {
        productId,
        name: String(p.name ?? ""),
        productNumber: String(p.productNumber ?? ""),
        category: String(p.category ?? ""),
        subcategory: String(p.subcategory ?? ""),
        unit: String(p.unit ?? ""),
        attributes: productAttributes(p),
        lines,
        total: lines.reduce((sum, l) => sum + l.qty, 0),
      },
    });
  }

  // Best SEO / name match first, then most stock on hand.
  scored.sort((a, b) => b.score - a.score || b.hit.total - a.hit.total || a.hit.name.localeCompare(b.hit.name));
  return scored.slice(0, limit).map((s) => s.hit);
}
