import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";
import { deriveGroup, runHealthCheck } from "@/lib/telegram-health";

export const dynamic = "force-dynamic";

// Ping every group's bot in parallel, persist the results, then return the
// freshly-derived list so the console can update in a single round trip.
export async function POST() {
  const db = await getDb();
  const groups = await db.collection("telegramGroups").find({}).sort({ title: 1 }).toArray();
  await Promise.all(groups.map((g) => runHealthCheck(db, g as { _id: (typeof g)["_id"]; chatId: string; title?: string })));
  const refreshed = await db.collection("telegramGroups").find({}).sort({ title: 1 }).toArray();
  return NextResponse.json(toClientList(refreshed).map(deriveGroup));
}
