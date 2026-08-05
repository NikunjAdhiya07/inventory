import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { withErrors } from "@/lib/api-error";
import { storageMap, storageRoots } from "@/lib/storage-map";

// The rack/box picture for one site, with contents attached.
//
//   GET /api/storage-map            → roots only, for the site picker
//   GET /api/storage-map?root=<id>  → that site's sections → racks → boxes

async function GET(req: NextRequest) {
  const db = await getDb();
  const roots = await storageRoots(db);

  const requested = req.nextUrl.searchParams.get("root");
  // Default to Canteen when it exists — it is where the physical inventory
  // actually is, so landing anywhere else means a click before every visit.
  const fallback = roots.find((r) => r.name.toLowerCase() === "canteen") || roots[0];
  const rootId = requested || fallback?.id;
  if (!rootId) return NextResponse.json({ roots, rootId: null, sections: [] });

  const map = await storageMap(db, rootId);
  if (!map) return NextResponse.json({ error: "That location no longer exists." }, { status: 404 });

  return NextResponse.json({ roots, rootId, root: { id: map.root.id, name: map.root.name }, sections: map.sections });
}

const handler = withErrors(GET);
export { handler as GET };
