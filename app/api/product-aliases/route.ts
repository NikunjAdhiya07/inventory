import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import { aliasKey, upsertAliases } from "@/lib/product-aliases";
import { toClientList } from "@/lib/serialize";

// Reference names / AI tags linked to Product Master rows.

export async function GET(req: NextRequest) {
  const db = await getDb();
  const productId = new URL(req.url).searchParams.get("productId");
  const filter = productId ? { productId } : {};
  const docs = await db
    .collection("productAliases")
    .find(filter)
    .sort({ hits: -1, alias: 1 })
    .limit(5000)
    .toArray();
  return NextResponse.json(toClientList(docs));
}

export async function POST(req: NextRequest) {
  const db = await getDb();
  const body = (await req.json()) as {
    productId?: string;
    productName?: string;
    aliases?: string[];
    alias?: string;
    source?: "ai" | "user" | "manual";
  };
  const productId = String(body.productId || "").trim();
  if (!productId) return NextResponse.json({ error: "productId required" }, { status: 400 });

  let productName = String(body.productName || "").trim();
  if (!productName) {
    try {
      const p = await db.collection("products").findOne({ _id: new ObjectId(productId) });
      productName = String(p?.name || "");
    } catch {
      /* ignore */
    }
  }
  if (!productName) return NextResponse.json({ error: "productName required" }, { status: 400 });

  const list = [
    ...(Array.isArray(body.aliases) ? body.aliases : []),
    ...(body.alias ? [body.alias] : []),
  ]
    .map((a) => String(a).trim())
    .filter(Boolean);

  if (!list.length) return NextResponse.json({ error: "alias required" }, { status: 400 });

  await upsertAliases(db, productId, productName, list, body.source || "manual");
  const docs = await db.collection("productAliases").find({ productId }).sort({ hits: -1, alias: 1 }).toArray();
  return NextResponse.json(toClientList(docs));
}

export async function DELETE(req: NextRequest) {
  const db = await getDb();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const alias = searchParams.get("alias");
  if (id) {
    try {
      await db.collection("productAliases").deleteOne({ _id: new ObjectId(id) });
    } catch {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
  } else if (alias) {
    await db.collection("productAliases").deleteOne({ aliasKey: aliasKey(alias) });
  } else {
    return NextResponse.json({ error: "id or alias required" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
