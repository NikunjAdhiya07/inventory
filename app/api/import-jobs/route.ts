import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClient, toClientList } from "@/lib/serialize";

export async function GET() {
  const db = await getDb();
  const docs = await db.collection("importJobs").find({}).sort({ when: -1 }).limit(50).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const db = await getDb();
  const doc = { ...body, when: new Date().toISOString() };
  const result = await db.collection("importJobs").insertOne(doc);
  return NextResponse.json(toClient({ _id: result.insertedId, ...doc }), { status: 201 });
}
