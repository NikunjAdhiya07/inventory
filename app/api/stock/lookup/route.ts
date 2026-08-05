import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { lookupProducts } from "@/lib/stock";

// Item search for recording a movement (AC-01), with each item's current stock
// attached (AC-03's "view current stock information").
//
// Unlike the bot's stock search, this includes items with nothing on hand: the
// first movement an item ever gets is usually the one that puts stock there.
//
//   GET /api/stock/lookup?q=wire

async function GET(req: NextRequest) {
  const db = await getDb();
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 25;
  return NextResponse.json(await lookupProducts(db, q, limit));
}

const handler = withErrors(GET);
export { handler as GET };
