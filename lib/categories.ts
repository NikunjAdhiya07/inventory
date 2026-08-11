import type { Db, Document } from "mongodb";
import { aiConfigured, suggestCategoryForProduct } from "./ai";
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
 * Parent may be anywhere in the tree (not only roots) — e.g. "PVC Pipe" under Pipe.
 */
export async function activeCategoryChildrenByParentName(db: Db, parentName?: string): Promise<Document[]> {
  const all = await activeCategories(db);
  const hasTreeChildren = all.some((c) => c.parent != null && c.parent !== "");

  if (hasTreeChildren) {
    if (!parentName) {
      return all.filter((c) => c.parent != null && c.parent !== "");
    }
    const matches = all.filter((c) => String(c.name) === parentName);
    if (!matches.length) return [];
    // Prefer the node that actually has children when names collide.
    const parent =
      matches.find((p) => all.some((c) => String(c.parent ?? "") === p._id.toString())) ?? matches[0];
    const parentId = parent._id.toString();
    return all.filter((c) => String(c.parent ?? "") === parentId);
  }

  // Pre-migration fallback: legacy name-linked subcategories collection.
  const legacy = await cached("subcategories:active", () =>
    db.collection("subcategories").find({ status: "Active" }).sort({ order: 1, name: 1 }).toArray()
  );
  return parentName ? legacy.filter((s) => s.parent === parentName) : legacy;
}

/** Names of every direct child under a category — used for search-group subcategory buttons. */
export async function categoryChildNames(db: Db, parentName: string): Promise<string[]> {
  const name = String(parentName ?? "").trim();
  if (!name) return [];
  const kids = await activeCategoryChildrenByParentName(db, name);
  return kids.map((c) => String(c.name ?? "").trim()).filter(Boolean);
}

/** Resolve a category document by exact name (prefers a node that has children). */
export async function findCategoryByName(db: Db, name: string): Promise<Document | null> {
  const want = String(name ?? "").trim();
  if (!want) return null;
  const all = await activeCategories(db);
  const matches = all.filter((c) => String(c.name) === want);
  if (!matches.length) return null;
  return matches.find((p) => all.some((c) => String(c.parent ?? "") === p._id.toString())) ?? matches[0];
}

function normCat(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Match a typed item name (e.g. "pipe", "pvc pipe", "pipes") to a category node
// anywhere in the tree — not only roots — so the bot can open the drill-down
// under Pipe when the user typed that word. Prefer the deepest / most specific hit.
export function matchCategory(categories: Document[], itemName: string): Document | null {
  const item = normCat(itemName);
  if (!item) return null;
  const padded = ` ${item} `;
  const words = new Set(item.split(" "));
  // Light stemming so "pipes" still opens Pipe without needing an alias list.
  const stems = new Set<string>([item]);
  for (const w of words) {
    stems.add(w);
    if (w.endsWith("ies") && w.length > 4) stems.add(`${w.slice(0, -3)}y`);
    else if (w.endsWith("ses") && w.length > 4) stems.add(w.slice(0, -2));
    else if (w.endsWith("s") && w.length > 3) stems.add(w.slice(0, -1));
  }

  // Depth so "PVC" under Pipe beats a shallower accidental name clash, and so
  // "Pipe" under Plumbing beats a root that merely contains the word.
  const byId = new Map(categories.map((c) => [c._id.toString(), c]));
  function depthOf(c: Document): number {
    let d = 0;
    let node: Document | undefined = c;
    for (let hops = 0; node && hops < 20; hops++) {
      const parentId = node.parent ? String(node.parent) : "";
      if (!parentId) break;
      d += 1;
      node = byId.get(parentId);
    }
    return d;
  }

  let best: Document | null = null;
  let bestScore = 0;
  for (const cat of categories) {
    const keys = [String(cat.name ?? ""), String(cat.code ?? "")].filter(Boolean);
    for (const key of keys) {
      const k = normCat(key);
      if (!k) continue;
      let score = 0;
      if (k === item || stems.has(k)) score = 100;
      else if (padded.includes(` ${k} `)) score = 70 + k.length;
      else if (k.split(" ").every((w) => words.has(w) || stems.has(w))) score = 50 + k.length;
      if (!score) continue;
      // Deeper + longer name wins ties: typing "pipe" prefers the Pipe node over
      // a shallow "Plumbing" alias that also scored.
      score += depthOf(cat) * 3 + String(cat.name ?? "").length * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = cat;
      }
    }
  }
  return best;
}

// Ancestors from root → node (inclusive), for ticket paths and summaries.
export function categoryAncestorChain(byId: Map<string, Document>, id: string): Document[] {
  const chain: Document[] = [];
  let node = byId.get(id);
  for (let hops = 0; node && hops < 20; hops++) {
    chain.unshift(node);
    node = node.parent ? byId.get(String(node.parent)) : undefined;
  }
  return chain;
}

/** Every Active category as a display trail ("Pipe" / "Pipe › PVC Pipe"). */
export async function categoryMasterPaths(db: Db): Promise<string[]> {
  const all = await activeCategories(db);
  const byId = new Map(all.map((c) => [c._id.toString(), c]));
  return [
    ...new Set(
      all
        .map((c) => categoryPathFrom(byId, c._id.toString()).trim())
        .filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));
}

/** Root category names from Category Master (picker when nothing matches the query). */
export async function rootCategoryNames(db: Db): Promise<string[]> {
  const roots = await activeRootCategories(db);
  return roots.map((c) => String(c.name ?? "").trim()).filter(Boolean);
}

export type ResolvedCategoryPath = {
  /** Root → matched node names from Category Master. */
  path: string[];
  source: "match" | "ai" | "none";
};

/**
 * Resolve a typed product/query (e.g. "pipe") to a Category Master path.
 * 1) Deterministic name match on the tree
 * 2) Nemotron pick from master paths when available
 * Empty path means no confident match — caller may show master roots.
 */
export async function resolveCategoryPathForItem(
  db: Db,
  itemName: string
): Promise<ResolvedCategoryPath> {
  const query = String(itemName ?? "").trim();
  if (!query) return { path: [], source: "none" };

  const all = await activeCategories(db);
  if (!all.length) return { path: [], source: "none" };

  const byId = new Map(all.map((c) => [c._id.toString(), c]));
  const matched = matchCategory(all, query);
  if (matched) {
    const chain = categoryAncestorChain(byId, matched._id.toString());
    const path = chain.map((c) => String(c.name ?? "").trim()).filter(Boolean);
    if (path.length) return { path, source: "match" };
  }

  if (!aiConfigured()) return { path: [], source: "none" };

  const masterPaths = await categoryMasterPaths(db);
  if (!masterPaths.length) return { path: [], source: "none" };

  const suggestion = await suggestCategoryForProduct(query, masterPaths);
  if (suggestion?.path?.length) {
    return { path: suggestion.path, source: "ai" };
  }
  return { path: [], source: "none" };
}
