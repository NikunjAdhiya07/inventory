import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";
import { deriveGroup, runHealthCheck } from "@/lib/telegram-health";

export const dynamic = "force-dynamic";

// Ping a single group's bot on demand (the row-level "Check" action) and return
// the updated, derived group.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const group = await db.collection("telegramGroups").findOne({ _id: new ObjectId(id) });
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await runHealthCheck(db, group as { _id: ObjectId; chatId: string; title?: string });
  const updated = await db.collection("telegramGroups").findOne({ _id: new ObjectId(id) });
  return NextResponse.json(deriveGroup(toClient(updated!)));
}
