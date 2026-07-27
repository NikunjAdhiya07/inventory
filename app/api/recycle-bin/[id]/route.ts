import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { invalidateCollection } from "@/lib/cache";

// POST = restore the entry back into its original collection.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const entry = await db.collection("recycleBin").findOne({ _id: new ObjectId(id) });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db.collection(entry.originalCollection).insertOne(entry.originalDoc);
  await db.collection("recycleBin").deleteOne({ _id: entry._id });
  invalidateCollection(String(entry.originalCollection));
  return NextResponse.json({ ok: true });
}

// DELETE = purge forever.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  await db.collection("recycleBin").deleteOne({ _id: new ObjectId(id) });
  return NextResponse.json({ ok: true });
}
