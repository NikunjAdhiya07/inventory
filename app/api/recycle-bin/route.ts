import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";

const PURGE_AFTER_DAYS = 30;

export async function GET() {
  const db = await getDb();
  const docs = await db.collection("recycleBin").find({}).sort({ deletedAt: -1 }).toArray();
  const withDaysLeft = docs.map((d) => {
    const elapsed = (Date.now() - new Date(d.deletedAt).getTime()) / 86_400_000;
    return { ...d, daysLeft: Math.max(0, Math.ceil(PURGE_AFTER_DAYS - elapsed)) };
  });
  return NextResponse.json(toClientList(withDaysLeft));
}

// Emptying the bin is a hard delete of every recycle-bin entry (originals were
// already removed from their source collection at soft-delete time).
export async function DELETE() {
  const db = await getDb();
  await db.collection("recycleBin").deleteMany({});
  return NextResponse.json({ ok: true });
}
