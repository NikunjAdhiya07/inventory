import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";

// Status Master entries are workflow configuration, not tracked master data,
// so edits/deletes here are plain (no audit trail, no recycle bin) — matching
// how General Settings / Notifications config is treated too.

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const patch = await req.json();
  const db = await getDb();

  if (patch.isDefault) {
    await db.collection("statuses").updateMany({}, { $set: { isDefault: false } });
  }
  await db.collection("statuses").updateOne({ _id: new ObjectId(id) }, { $set: patch });
  const after = await db.collection("statuses").findOne({ _id: new ObjectId(id) });
  return NextResponse.json(toClient(after!));
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  await db.collection("statuses").deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
