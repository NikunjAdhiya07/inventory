import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { listStockUnavailable } from "@/lib/stock-unavailable";

export async function GET() {
  const db = await getDb();
  const rows = await listStockUnavailable(db, 300);
  return NextResponse.json({
    items: rows.map((r) => ({
      id: String(r._id ?? ""),
      productId: r.productId,
      productName: r.productName,
      productNumber: r.productNumber,
      locationId: r.locationId,
      locationPath: r.locationPath,
      qtyRequested: r.qtyRequested,
      qtyAvailable: r.qtyAvailable,
      unit: r.unit,
      movementCode: r.movementCode ?? "",
      movementName: r.movementName ?? "",
      requesterName: r.requesterName ?? "",
      ticketNumber: r.ticketNumber ?? null,
      source: r.source,
      status: r.status,
      createdAt: r.createdAt,
    })),
  });
}
