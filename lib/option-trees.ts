import type { Db, Document } from "mongodb";
import { cached } from "./cache";

// Nested option trees — the master behind the bot's `nested_select` step.
//
// A tree turns one answer ("Wire") into a guided drill-down that asks for one
// detail at a time: Type of Wire → Subcategory → Colour → Size. Two things
// define it, and they are deliberately separate:
//
//   • LEVELS (`optionTrees.levels`) are the QUESTIONS — their order, their
//     prompt, and how each one is answered. Every branch of a tree asks the
//     same questions in the same order, which is what makes the flow
//     predictable to the person filling it in.
//   • NODES (`optionNodes`) are the ANSWERS to the levels that read from the
//     tree — a parent/child forest exactly like storage locations, so
//     "Copper → Flexible → 2.5 sq mm" is three rows, not one row per
//     combination.
//
// A level does not have to read from the tree: a fixed `list` (Colour: Red,
// Black, Blue…), free `text` or a `number` keypad all avoid enumerating a
// dimension that is the same everywhere. Only `nodes` levels move the cursor
// down the forest, which is why the Size level below a `list` Colour level
// still finds its options under the subcategory the user picked.
//
// Reads are cached whole and sliced in memory, like locations: the bot renders
// a level on every tap and the trees change on admin action.

export type OptionLevelInput = "nodes" | "list" | "text" | "number";

export type OptionLevel = {
  // The prompt the bot shows for this level ("Type of Wire").
  label: string;
  input: OptionLevelInput;
  // input: "list" — the fixed choices offered at this level.
  options?: string[];
  // nodes/list: accept a typed value that isn't on the keyboard.
  allowOther?: boolean;
  // input: "text" — hint under the prompt.
  placeholder?: string;
  // input: "number" — keypad bounds; 0 means "no limit", as elsewhere.
  min?: number;
  max?: number;
};

export type OptionTreeDoc = Document & {
  name: string;
  desc?: string;
  matches?: string[];
  levels?: OptionLevel[];
  status?: string;
};

export async function activeOptionTrees(db: Db): Promise<Document[]> {
  return cached("optionTrees:active", () =>
    db.collection("optionTrees").find({ status: "Active" }).sort({ name: 1 }).toArray()
  );
}

// The whole active forest, in the order the bot offers siblings. `order` is
// authored per sibling group; nodes without one keep name order behind those
// that have one — the same rule the location tree uses.
export async function activeOptionNodes(db: Db): Promise<Document[]> {
  return cached("optionNodes:active", async () => {
    const all = await db.collection("optionNodes").find({ status: "Active" }).sort({ name: 1 }).toArray();
    return all.sort((a, b) => {
      const ao = typeof a.order === "number" ? a.order : Infinity;
      const bo = typeof b.order === "number" ? b.order : Infinity;
      if (ao !== bo) return ao - bo;
      return String(a.name).localeCompare(String(b.name));
    });
  });
}

export async function optionNodeChildren(db: Db, treeId: string, parent: string | null): Promise<Document[]> {
  const all = await activeOptionNodes(db);
  // Mongo's `{ parent: null }` matches a missing field too, so normalise here.
  return all.filter((n) => String(n.treeId ?? "") === treeId && (n.parent ?? null) === parent);
}

// Every descendant of a node, itself included — the guard against re-parenting a
// node under one of its own children, which would detach the branch.
export async function optionSubtreeIds(db: Db, rootId: string): Promise<Set<string>> {
  const all = await activeOptionNodes(db);
  const childrenOf = new Map<string, string[]>();
  for (const n of all) {
    const parent = n.parent ? String(n.parent) : "";
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(n._id.toString());
    else childrenOf.set(parent, [n._id.toString()]);
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

// Levels as the engine wants them: labelled, typed, and never undefined. A tree
// authored before a field existed still runs — an unknown input reads as a node
// level, which is the one that always has a keyboard behind it.
export function treeLevels(tree: Document | null | undefined): OptionLevel[] {
  if (!tree || !Array.isArray(tree.levels)) return [];
  return tree.levels
    .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === "object")
    .map((l, i) => {
      const input = String(l.input ?? "nodes");
      return {
        label: String(l.label ?? `Level ${i + 1}`),
        input: (["nodes", "list", "text", "number"].includes(input) ? input : "nodes") as OptionLevelInput,
        options: Array.isArray(l.options) ? l.options.map(String).filter(Boolean) : [],
        allowOther: Boolean(l.allowOther),
        placeholder: String(l.placeholder ?? ""),
        min: Number(l.min) || 0,
        max: Number(l.max) || 0,
      };
    })
    .filter((l) => l.label);
}

// The stored shape of a tree, from whatever the console posted. Shared by the
// create and update routes so a tree written by either is the same document.
export function normalizeTreeInput(body: Record<string, unknown>) {
  return {
    name: String(body.name ?? "").trim(),
    desc: String(body.desc ?? ""),
    matches: normalizeMatches(body.matches),
    levels: normalizeLevels(body.levels),
    status: body.status === "Inactive" ? "Inactive" : "Active",
  };
}

// Levels as authored: trimmed, typed, and without the half-filled rows the
// console's "add level" button leaves behind.
export function normalizeLevels(input: unknown): OptionLevel[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((l): l is Record<string, unknown> => Boolean(l) && typeof l === "object")
    .map((l) => {
      const kind = String(l.input ?? "nodes");
      return {
        label: String(l.label ?? "").trim(),
        input: (["nodes", "list", "text", "number"].includes(kind) ? kind : "nodes") as OptionLevelInput,
        options: Array.isArray(l.options)
          ? l.options.map(String).map((o) => o.trim()).filter(Boolean)
          : String(l.options ?? "")
              .split(",")
              .map((o) => o.trim())
              .filter(Boolean),
        allowOther: Boolean(l.allowOther),
        placeholder: String(l.placeholder ?? ""),
        min: Number(l.min) || 0,
        max: Number(l.max) || 0,
      };
    })
    .filter((l) => l.label);
}

// Alternate spellings that should reach this tree ("cable" → Wire). Accepts the
// array the console sends or a comma-separated string from an import.
export function normalizeMatches(input: unknown): string[] {
  if (Array.isArray(input)) return input.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof input === "string") return input.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// A Mongo matcher for a name regardless of case, for the uniqueness checks in
// the write routes. Both the step config and the item matcher find a tree by
// name case-insensitively, so two names that differ only in case are one name
// as far as anything reading them is concerned. Escaped and anchored, so a name
// with regex characters in it ("2.5 sq mm") compares as the literal text it is.
export function sameNameFilter(name: string) {
  return { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" };
}

function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findTreeByName(trees: Document[], name: string): Document | null {
  const wanted = norm(name);
  if (!wanted) return null;
  return trees.find((t) => norm(t.name) === wanted) ?? null;
}

// Which tree an item name asks for. The whole point of the step is that one
// workflow serves every item: someone typing "Wire" — or "copper wire", or
// "MS Wire 2.5" — gets the Wire drill-down, and someone typing "Cement" gets
// whatever tree names Cement (or none, and the step steps aside).
//
// Scoring, best match wins:
//   exact name/alias            100
//   alias appears as a whole word in the item   70 + its length
//   every word of the alias appears in the item 50 + its length
//
// Length breaks ties towards the more specific tree, so "Armoured Wire" beats a
// bare "Wire" for "armoured wire 4 core".
export function matchOptionTree(trees: Document[], itemName: string): Document | null {
  const item = norm(itemName);
  if (!item) return null;
  const padded = ` ${item} `;
  const words = new Set(item.split(" "));

  let best: Document | null = null;
  let bestScore = 0;
  for (const tree of trees) {
    const keys = [String(tree.name ?? ""), ...(Array.isArray(tree.matches) ? tree.matches.map(String) : [])];
    for (const key of keys) {
      const k = norm(key);
      if (!k) continue;
      let score = 0;
      if (k === item) score = 100;
      else if (padded.includes(` ${k} `)) score = 70 + k.length;
      else if (k.split(" ").every((w) => words.has(w))) score = 50 + k.length;
      if (score > bestScore) {
        bestScore = score;
        best = tree;
      }
    }
  }
  return best;
}
