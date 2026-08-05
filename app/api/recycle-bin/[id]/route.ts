import { NextRequest, NextResponse } from "next/server";
import { ObjectId, type Document } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { invalidateCollection } from "@/lib/cache";

// POST = restore the entry back into its original collection.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = await getDb();
  const entry = await db.collection("recycleBin").findOne({ _id: new ObjectId(id) });
  if (!entry) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const restored = await db.collection(entry.originalCollection).insertOne(entry.originalDoc);

  // Rows that were deleted with it — a nested tree's options, say. They keep the
  // ids they had, so their references to each other still hold; only the pointer
  // to the parent is rewritten, because the parent came back under a new id.
  const children = entry.children;
  if (children?.collection && Array.isArray(children.docs) && children.docs.length) {
    await db
      .collection(String(children.collection))
      .insertMany(children.docs.map((d: Document) => ({ ...d, [String(children.parentField)]: restored.insertedId.toString() })));
    invalidateCollection(String(children.collection));
  }

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
