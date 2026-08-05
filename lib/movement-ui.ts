// Client-safe bits of the movement vocabulary, shared by the Movement Types
// master and the Stock Movements screen. Kept out of `lib/movements.ts` so the
// pages don't drag the Mongo driver into the browser bundle — the same split
// `lib/products.ts` and `lib/product-store.ts` already use.

export type Direction = "in" | "out" | "transfer" | "adjust";

export const DIRECTION_GROUPS: { direction: Direction; title: string; hint: string; color: string; tint: string }[] = [
  { direction: "in", title: "Stock In", hint: "Adds stock at one location", color: "#0f9d63", tint: "#eafaf1" },
  { direction: "out", title: "Stock Out", hint: "Removes stock from one location", color: "#d63a3a", tint: "#fdecec" },
  { direction: "transfer", title: "Stock Transfer", hint: "Moves stock between two locations", color: "#1560f0", tint: "#eaf2ff" },
  // Only system corrections carry this: the sign comes from the count entered,
  // not from the type.
  { direction: "adjust", title: "Correction", hint: "Sign decided by the count entered", color: "#8a5cf6", tint: "#f2effc" },
];

export function directionGroup(d: Direction) {
  return DIRECTION_GROUPS.find((g) => g.direction === d) ?? DIRECTION_GROUPS[0];
}

// A location's full path, built from the flat list the locations API returns.
// The bot resolves paths server-side against the same tree; a console screen
// with the whole list already in hand can do it without another round trip.
export function pathOf(nodes: { id: string; parent: string | null; name: string }[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const names: string[] = [];
  let node = byId.get(id);
  for (let hops = 0; node && hops < 20; hops++) {
    names.unshift(node.name);
    node = node.parent ? byId.get(node.parent) : undefined;
  }
  return names.join(" › ");
}
