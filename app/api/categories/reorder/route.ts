import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";

// Persists a full drag-and-drop reorder in one round trip: body is the list
// of category ids in their new display order.
export async function POST(req: NextRequest) {
  const { ids }: { ids: string[] } = await req.json();
  const db = await getDb();
  await Promise.all(
    ids.map((id, i) => db.collection("categories").updateOne({ _id: new ObjectId(id) }, { $set: { order: i + 1 } }))
  );
  return NextResponse.json({ ok: true });
}
