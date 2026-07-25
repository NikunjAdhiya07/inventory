import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";

export async function GET() {
  const db = await getDb();
  const docs = await db.collection("statuses").find({}).sort({ order: 1 }).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  if (body.isDefault) {
    await db.collection("statuses").updateMany({}, { $set: { isDefault: false } });
  }
  const count = await db.collection("statuses").countDocuments();
  const result = await db.collection("statuses").insertOne({ ...body, order: count + 1 });
  const doc = await db.collection("statuses").findOne({ _id: result.insertedId });
  return NextResponse.json(toClient(doc!), { status: 201 });
}
