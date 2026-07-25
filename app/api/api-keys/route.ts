import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";

export async function GET() {
  const db = await getDb();
  const docs = await db.collection("apiKeys").find({}).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  const doc = { name: "New API Key", masked: "mb_live_••••" + Math.random().toString(16).slice(2, 6), scope: "Read", lastUsed: "Never", ...body };
  const result = await db.collection("apiKeys").insertOne(doc);
  return NextResponse.json(toClient({ _id: result.insertedId, ...doc }), { status: 201 });
}
