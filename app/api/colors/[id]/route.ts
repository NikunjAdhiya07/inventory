import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const patch = await req.json();
  const db = await getDb();
  await db.collection("colors").updateOne({ _id: new ObjectId(id) }, { $set: patch });
  const after = await db.collection("colors").findOne({ _id: new ObjectId(id) });
  return NextResponse.json(toClient(after!));
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  await db.collection("colors").deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
