import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { toClientList } from "@/lib/serialize";
import { withErrors } from "@/lib/api-error";

// Compatibility shim while the console uses a single category tree.
// Prefer children already folded into `categories`; fall back to the legacy
// `subcategories` collection until migrate-category-tree has been applied.

async function GET() {
  const db = await getDb();
  const treeKids = await db
    .collection("categories")
    .find({ parent: { $nin: [null, ""] } })
    .sort({ order: 1, name: 1 })
    .toArray();

  if (treeKids.length) {
    const roots = await db
      .collection("categories")
      .find({ $or: [{ parent: null }, { parent: { $exists: false } }, { parent: "" }] })
      .toArray();
    const nameById = new Map(roots.map((c) => [c._id.toString(), String(c.name)]));
    const mapped = treeKids.map((c) => ({
      ...c,
      parent: nameById.get(String(c.parent)) || String(c.parent),
    }));
    return NextResponse.json(toClientList(mapped));
  }

  const legacy = await db.collection("subcategories").find({}).sort({ order: 1, name: 1 }).toArray();
  return NextResponse.json(toClientList(legacy));
}

async function POST() {
  return NextResponse.json(
    { error: "Subcategories are part of the category tree. Add a child under Categories." },
    { status: 410 }
  );
}

export const GET = withErrors(GET);
export const POST = withErrors(POST);
