import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";

export async function GET() {
  const db = await getDb();
  const docs = await db.collection("users").find({}).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  try {
    const result = await db.collection("users").insertOne(body);
    const doc = await db.collection("users").findOne({ _id: result.insertedId });
    return NextResponse.json(toClient(doc!), { status: 201 });
  } catch {
    return NextResponse.json({ error: "A user with that Telegram ID already exists" }, { status: 409 });
  }
}
