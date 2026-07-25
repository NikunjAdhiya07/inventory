import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient } from "@/lib/serialize";

const SETTINGS_KEY = "notifications";

const EVENT_COUNT = 6;

const DEFAULTS = {
  key: SETTINGS_KEY,
  email: "ops@vertexsupplies.in",
  tg: "@vertex_alerts",
  matrix: Array.from({ length: EVENT_COUNT }, (_, i) => [i < 2, i < 3, true]),
};

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
