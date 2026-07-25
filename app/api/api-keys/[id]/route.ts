import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  await db.collection("apiKeys").deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
