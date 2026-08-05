import type { Db, Document } from "mongodb";
import { cached } from "./cache";

// Shared reads over the location tree.
//
// These used to live inside the workflow engine, which was fine while the entry
// bot was the only thing that walked locations. The request bot resolves a
// location path for every stock line it shows, so a second copy would have meant
// a second cache of the same collection and two ways for a path to render.
//
// The whole active tree is fetched ONCE and cached; children, parents and full
// paths are all derived from that one array in memory, so walking a path costs
// no round trips at all.

export async function activeLocations(db: Db): Promise<Document[]> {
  return cached("locations:active", async () => {
    const all = await db.collection("locations").find({ status: "Active" }).sort({ name: 1 }).toArray();
    // Shelves and boxes are positional — "Shelf 10" belongs after "Shelf 9",
    // and a rack can be re-shuffled to match the room. `order` is written by
    // the reorder route for every sibling in a group at once, so a group is
    // either fully positioned or not positioned at all; the ones without it
    // keep the name order they already had, after the ones with it.
    return all.sort((a, b) => {
      const ao = typeof a.order === "number" ? a.order : Infinity;
      const bo = typeof b.order === "number" ? b.order : Infinity;
      if (ao !== bo) return ao - bo;
      return String(a.name).localeCompare(String(b.name));
    });
  });
}

// Every descendant id of a node, itself included. The guard against moving a
// rack into one of its own shelves — which would detach the whole branch from
// the tree and leave its stock unreachable.
export async function locationSubtreeIds(db: Db, rootId: string): Promise<Set<string>> {
  const all = await activeLocations(db);
  const childrenOf = new Map<string, string[]>();
  for (const l of all) {
    const parent = l.parent ? String(l.parent) : "";
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(l._id.toString());
    else childrenOf.set(parent, [l._id.toString()]);
  }
  const seen = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    for (const child of childrenOf.get(queue.pop() as string) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

export async function locationChildren(db: Db, parent: string | null): Promise<Document[]> {
  const all = await activeLocations(db);
  // Mongo's `{ parent: null }` matches a missing field too, so normalise here.
  return all.filter((l) => (l.parent ?? null) === parent);
}

export async function locationsById(db: Db): Promise<Map<string, Document>> {
  const all = await activeLocations(db);
  return new Map(all.map((l) => [l._id.toString(), l]));
}

// Path resolution for stock lines. Inactive (and even deleted-but-snapshotted)
// locations still hold balances, so the map used to *pick* a shelf must not be
// the one used to *name* a shelf.
export async function locationsByIdForPaths(db: Db): Promise<Map<string, Document>> {
  return cached("locations:byId:paths", async () => {
    const all = await db
      .collection("locations")
      .find({}, { projection: { name: 1, parent: 1 } })
      .toArray();
    return new Map(all.map((l) => [l._id.toString(), l]));
  });
}

// Ids that have at least one active child. Drives both the button icon and the
// decision to select-on-tap, without a query per option.
export async function locationParentIds(db: Db): Promise<Set<string>> {
  const all = await activeLocations(db);
  const ids = new Set<string>();
  for (const l of all) if (l.parent) ids.add(String(l.parent));
  return ids;
}

// Full path of a node, walked up through its parents. Independent of how the
// caller arrived there, so it stays correct after a jump between branches.
export async function locationPathById(db: Db, id: string): Promise<string> {
  const byId = await locationsById(db);
  return locationPathFrom(byId, id);
}

// The same walk against an already-loaded map. Rendering a page of stock touches
// a dozen locations at once, and re-awaiting the map for each one turned one
// cached read into a dozen.
export function locationPathFrom(byId: Map<string, Document>, id: string): string {
  const names: string[] = [];
  let node = byId.get(id);
  // Guard against a cycle in the stored parent pointers.
  for (let hops = 0; node && hops < 20; hops++) {
    names.unshift(String(node.name));
    node = node.parent ? byId.get(String(node.parent)) : undefined;
  }
  return names.join(" › ");
}
