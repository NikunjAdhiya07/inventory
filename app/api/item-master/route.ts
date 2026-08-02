import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";

// Item Master feed: Product Master rows + AI/manual reference names + entry counts.

export async function GET() {
  const db = await getDb();
  const [products, aliases, entries] = await Promise.all([
    db.collection("products").find({}).sort({ name: 1 }).limit(2000).toArray(),
    db.collection("productAliases").find({}).limit(5000).toArray(),
    db
      .collection("inventoryEntries")
      .find({ ticketNumber: { $exists: true, $ne: "" } })
      .sort({ createdAt: -1 })
      .limit(500)
      .toArray(),
  ]);

  const aliasesByProduct = new Map<string, { id: string; alias: string; source: string; hits: number }[]>();
  for (const a of aliases) {
    const pid = String(a.productId || "");
    if (!pid) continue;
    const list = aliasesByProduct.get(pid) || [];
    list.push({
      id: String(a._id),
      alias: String(a.alias || ""),
      source: String(a.source || "manual"),
      hits: Number(a.hits || 0),
    });
    aliasesByProduct.set(pid, list);
  }

  const entryStats = new Map<
    string,
    { entryCount: number; lastTicket?: string; lastAt?: string; lastQty?: number | null; lastLocation?: string }
  >();
  for (const e of entries) {
    const fields = (e.fields || {}) as Record<string, unknown>;
    const pid = String(fields.productId || "");
    if (!pid) continue;
    const cur = entryStats.get(pid) || { entryCount: 0 };
    cur.entryCount += 1;
    if (!cur.lastAt || String(e.createdAt) > String(cur.lastAt)) {
      cur.lastTicket = String(e.ticketNumber || "");
      cur.lastAt = String(e.createdAt || "");
      cur.lastQty = (fields.quantity as number | null) ?? null;
      cur.lastLocation = String(fields.locationPath || "");
    }
    entryStats.set(pid, cur);
  }

  const items = products.map((p) => {
    const c = toClient(p);
    const id = c.id;
    const refs = aliasesByProduct.get(id) || [];
    const stats = entryStats.get(id) || { entryCount: 0 };
    return {
      ...c,
      referenceNames: refs.sort((a, b) => b.hits - a.hits || a.alias.localeCompare(b.alias)),
      entryCount: stats.entryCount,
      lastEntryTicket: stats.lastTicket || null,
      lastEntryAt: stats.lastAt || null,
      lastEntryQty: stats.lastQty ?? null,
      lastEntryLocation: stats.lastLocation || null,
    };
  });

  return NextResponse.json(items);
}
