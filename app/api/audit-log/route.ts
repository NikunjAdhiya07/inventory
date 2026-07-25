import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";

// Filtering happens in the query itself (not fetch-all-then-filter-in-JS) so
// the response stays small and Mongo does the work via the ts/user/dataType
// indexes instead of the Node process scanning every row.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const dataType = searchParams.get("dataType");
  const user = searchParams.get("user");
  const action = searchParams.get("action");
  const q = searchParams.get("q");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const limit = Math.min(Number(searchParams.get("limit")) || 200, 200);

  const filter: Record<string, unknown> = {};
  if (dataType) filter.dataType = dataType;
  if (user) filter.user = user;
  if (action) filter.action = action;
  if (q) filter.entity = { $regex: q, $options: "i" };
  if (from || to) {
    const range: Record<string, string> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = `${to}T23:59:59`;
    filter.ts = range;
  }

  const db = await getDb();
  const docs = await db.collection("auditLog").find(filter).sort({ ts: -1 }).limit(limit).toArray();
  const total = await db.collection("auditLog").estimatedDocumentCount();
  return NextResponse.json({ rows: toClientList(docs), total });
}
