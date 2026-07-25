import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";

const SETTINGS_KEY = "general";

const DEFAULTS = {
  key: SETTINGS_KEY,
  company: "Vertex Building Supplies",
  tz: "Asia/Kolkata (GMT+5:30)",
  dateFmt: "DD MMM YYYY",
  currency: "INR — ₹",
  lang: "English",
  toggles: { softDelete: true, approval: true, duplicate: true, autoSync: true },
};

// Single settings document — GET upserts the defaults on first read so the
// page never has to special-case "no settings yet".
export async function GET() {
  const db = await getDb();
  const doc = await db.collection("settings").findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $setOnInsert: DEFAULTS },
    { upsert: true, returnDocument: "after" }
  );
  return NextResponse.json(toClient(doc!));
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  await db.collection("settings").updateOne({ key: SETTINGS_KEY }, { $set: body }, { upsert: true });
  return NextResponse.json({ ok: true });
}
