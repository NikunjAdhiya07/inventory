import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";

export async function GET() {
  const db = await getDb();
  const docs = await db.collection("colors").find({}).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  const result = await db.collection("colors").insertOne(body);
  const doc = await db.collection("colors").findOne({ _id: result.insertedId });
  return NextResponse.json(toClient(doc!), { status: 201 });
}
