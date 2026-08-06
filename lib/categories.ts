import type { Db, Document } from "mongodb";
import { cached } from "./cache";

// Shared reads over the category tree — same adjacency-list pattern as locations.
// Roots are product categories; children are nested groupings of any depth.

export async function activeCategories(db: Db): Promise<Document[]> {
  return cached("categories:active", async () => {
    const all = await db.collection("categories").find({ status: "Active" }).sort({ name: 1 }).toArray();
    return all.sort((a, b) => {
      const ao = typeof a.order === "number" ? a.order : Infinity;
      const bo = typeof b.order === "number" ? b.order : Infinity;
      if (ao !== bo) return ao - bo;
      return String(a.name).localeCompare(String(b.name));
    });
  });
}

export async function categorySubtreeIds(db: Db, rootId: string): Promise<Set<string>> {
  const all = await activeCategories(db);
  const childrenOf = new Map<string, string[]>();
  for (const c of all) {
    const parent = c.parent ? String(c.parent) : "";
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(c._id.toString());
    else childrenOf.set(parent, [c._id.toString()]);
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

export async function categoryChildren(db: Db, parent: string | null): Promise<Document[]> {
  const all = await activeCategories(db);
  return all.filter((c) => (c.parent ?? null) === parent);
}

export async function categoriesById(db: Db): Promise<Map<string, Document>> {
  const all = await activeCategories(db);
  return new Map(all.map((c) => [c._id.toString(), c]));
}

export async function categoryParentIds(db: Db): Promise<Set<string>> {
  const all = await activeCategories(db);
  const ids = new Set<string>();
  for (const c of all) if (c.parent) ids.add(String(c.parent));
  return ids;
}

export function categoryPathFrom(byId: Map<string, Document>, id: string): string {
  const names: string[] = [];
  let node = byId.get(id);
  for (let hops = 0; node && hops < 20; hops++) {
    names.unshift(String(node.name));
    node = node.parent ? byId.get(String(node.parent)) : undefined;
  }
  return names.join(" › ");
}

/** Root categories only (parent is null / missing). Used by the bot's category_select. */
export async function activeRootCategories(db: Db): Promise<Document[]> {
  return categoryChildren(db, null);
}

/**
 * Direct children of a category named `parentName`. Keeps subcategory_select and
 * the product form working while the master is a single tree keyed by id.
 */
export async function activeCategoryChildrenByParentName(db: Db, parentName?: string): Promise<Document[]> {
  const all = await activeCategories(db);
  const hasTreeChildren = all.some((c) => c.parent != null && c.parent !== "");

  if (hasTreeChildren) {
    if (!parentName) {
      return all.filter((c) => c.parent != null && c.parent !== "");
    }
    const parent = all.find((c) => (c.parent ?? null) === null && String(c.name) === parentName);
    if (!parent) return [];
    const parentId = parent._id.toString();
    return all.filter((c) => String(c.parent ?? "") === parentId);
  }

  // Pre-migration fallback: legacy name-linked subcategories collection.
  const legacy = await cached("subcategories:active", () =>
    db.collection("subcategories").find({ status: "Active" }).sort({ order: 1, name: 1 }).toArray()
  );
  return parentName ? legacy.filter((s) => s.parent === parentName) : legacy;
}
