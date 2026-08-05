import type { Db, Document } from "mongodb";
import { activeLocations } from "./locations";
import { activeProducts } from "./product-store";

// The physical picture of one site: sections, the racks standing in them, the
// boxes on those racks, and what is actually inside each box.
//
// There is no rack collection and no box collection. A rack IS a location node
// and a box IS a location node one level below it — the same arbitrary-depth
// tree the console already edits. That is deliberate: stock is bound to a
// `locationId`, so the moment a box exists as a node the ledger can hold stock
// "in box C-04" with no new join and no second place for a physical position to
// be recorded (and disagree).
//
// What this module adds is the read in the other direction. The tree answers
// "where does this box sit"; a warehouse operator standing in front of a rack
// needs "what is in this box", which is the balance aggregation grouped by
// location instead of by product.

export type BoxItem = {
  productId: string;
  name: string;
  productNumber: string;
  qty: number;
  unit: string;
};

export type MapNode = {
  id: string;
  name: string;
  code: string;
  level: string;
  capacity: number | null;
  // Direct holdings of this node only.
  items: BoxItem[];
  qty: number;
  // Rolled up through every descendant — a rack's total is its boxes' totals,
  // even though the rack itself normally holds nothing directly.
  totalQty: number;
  children: MapNode[];
};

export type MapSection = MapNode;

// Every location holding stock, as productId → qty, keyed by locationId.
//
// One aggregation for the whole ledger. `lib/stock.ts` runs the same grouping
// the other way round (per product, for search); doing it per rack here would
// be one round trip per box on a page that renders a hundred of them.
async function holdingsByLocation(db: Db): Promise<Map<string, Map<string, { qty: number; unit: string }>>> {
  const rows = await db
    .collection("stockMovements")
    .aggregate<{ _id: { locationId: string; productId: string }; qty: number; unit: string }>([
      {
        $group: {
          _id: { locationId: "$locationId", productId: "$productId" },
          qty: { $sum: "$qty" },
          unit: { $last: "$unit" },
        },
      },
      // A pair that has netted to zero is not stock and must not draw a box as
      // occupied.
      { $match: { qty: { $gt: 0 } } },
    ])
    .toArray();

  const byLocation = new Map<string, Map<string, { qty: number; unit: string }>>();
  for (const r of rows) {
    const locationId = String(r._id?.locationId ?? "");
    const productId = String(r._id?.productId ?? "");
    if (!locationId || !productId) continue;
    let held = byLocation.get(locationId);
    if (!held) {
      held = new Map();
      byLocation.set(locationId, held);
    }
    held.set(productId, { qty: r.qty, unit: String(r.unit ?? "") });
  }
  return byLocation;
}

function toNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Build the subtree under `rootId` with contents attached at every level.
//
// Returns null when the root id does not name an active location, so the caller
// can say "that site is gone" rather than render an empty warehouse.
export async function storageMap(db: Db, rootId: string): Promise<{ root: MapNode; sections: MapSection[] } | null> {
  const [locations, products, holdings] = await Promise.all([
    activeLocations(db),
    activeProducts(db),
    holdingsByLocation(db),
  ]);

  const root = locations.find((l) => l._id.toString() === rootId);
  if (!root) return null;

  const childrenOf = new Map<string, Document[]>();
  for (const l of locations) {
    const parent = l.parent ? String(l.parent) : "";
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(l);
    else childrenOf.set(parent, [l]);
  }

  const productsById = new Map(products.map((p) => [p._id.toString(), p]));

  function itemsAt(id: string): BoxItem[] {
    const held = holdings.get(id);
    if (!held) return [];
    const items: BoxItem[] = [];
    for (const [productId, { qty, unit }] of held) {
      const p = productsById.get(productId);
      items.push({
        productId,
        // A product that was deactivated after stock landed in the box is still
        // physically in the box. Name it from the ledger's own reach rather than
        // dropping the line and drawing the box as empty.
        name: String(p?.name ?? "(unknown product)"),
        productNumber: String(p?.productNumber ?? ""),
        qty,
        unit: unit || String(p?.unit ?? ""),
      });
    }
    // Most-stocked first: that is what the box is really "for".
    return items.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
  }

  // Depth-limited so a cycle in the stored parent pointers cannot hang the page.
  function build(node: Document, depth: number): MapNode {
    const id = node._id.toString();
    const items = itemsAt(id);
    const qty = items.reduce((sum, i) => sum + i.qty, 0);
    const children = depth >= 8 ? [] : (childrenOf.get(id) || []).map((c) => build(c, depth + 1));
    return {
      id,
      name: String(node.name ?? ""),
      code: String(node.code ?? ""),
      level: String(node.level ?? ""),
      capacity: toNumber(node.capacity),
      items,
      qty,
      totalQty: qty + children.reduce((sum, c) => sum + c.totalQty, 0),
      children,
    };
  }

  const built = build(root, 0);
  return { root: built, sections: built.children };
}

// Roots offered in the map's site picker — the top level of the tree.
export async function storageRoots(db: Db): Promise<{ id: string; name: string }[]> {
  const locations = await activeLocations(db);
  return locations
    .filter((l) => (l.parent ?? null) === null)
    .map((l) => ({ id: l._id.toString(), name: String(l.name ?? "") }));
}
