import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";

export const dynamic = "force-dynamic";

// Per-group activity log for the console's log viewer. Supports a `level` filter
// (all | error) so admins can jump straight to failed updates / connection
// issues, and caps the response so a chatty group can't blow up the payload.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);
  const level = searchParams.get("level");
  const limit = Math.min(Number(searchParams.get("limit")) || 100, 200);

  const db = await getDb();
  const group = await db.collection("telegramGroups").findOne({ _id: new ObjectId(id) });
  if (!group) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const filter: Record<string, unknown> = {
    $or: [{ groupId: id }, { chatId: String(group.chatId) }],
  };
  if (level === "error") filter.level = "error";

  const docs = await db.collection("telegramLogs").find(filter).sort({ ts: -1 }).limit(limit).toArray();
  return NextResponse.json(toClientList(docs));
}
