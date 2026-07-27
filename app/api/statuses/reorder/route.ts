import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { invalidateCollection } from "@/lib/cache";

export async function POST(req: NextRequest) {
  const { ids }: { ids: string[] } = await req.json();
  const db = await getDb();
  await Promise.all(
    ids.map((id, i) => db.collection("statuses").updateOne({ _id: new ObjectId(id) }, { $set: { order: i + 1 } }))
  );
  invalidateCollection("statuses");
  return NextResponse.json({ ok: true });
}
