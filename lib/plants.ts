import type { Db, Document } from "mongodb";
import { cached } from "./cache";

/** Active plants for bot keyboards and workflow pick_plant. */
export async function activePlants(db: Db): Promise<Document[]> {
  return cached("plants:active", async () => {
    const all = await db
      .collection("plants")
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
