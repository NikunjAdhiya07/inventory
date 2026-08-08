import type { Db, Document } from "mongodb";
import { cached } from "./cache";

export type Vendor = {
  id: string;
  name: string;
  code: string;
  contact: string;
  phone: string;
  email: string;
  notes: string;
  status: "Active" | "Inactive";
  order: number;
};

/** Active vendors for bot keyboards and workflow pick_vendor. */
export async function activeVendors(db: Db): Promise<Document[]> {
  return cached("vendors:active", async () => {
    const all = await db
      .collection("vendors")
      .find({ status: "Active" })
      .sort({ order: 1, name: 1 })
      .toArray();
    return all.sort((a, b) => {
      const ao = typeof a.order === "number" ? a.order : Infinity;
      const bo = typeof b.order === "number" ? b.order : Infinity;
      if (ao !== bo) return ao - bo;
      return String(a.name).localeCompare(String(b.name));
    });
  });
}
