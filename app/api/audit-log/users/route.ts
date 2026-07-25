import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";

export async function GET() {
  const db = await getDb();
  const users = await db.collection("auditLog").distinct("user");
  return NextResponse.json(users);
}
