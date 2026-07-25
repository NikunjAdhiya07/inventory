import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";

// Completed inventory entries produced by the bot, newest first. Read-only view
// for the console (the last 200).
export async function GET() {
  const db = await getDb();
  const docs = await db.collection("inventoryEntries").find({}).sort({ createdAt: -1 }).limit(200).toArray();
  return NextResponse.json(toClientList(docs));
}
