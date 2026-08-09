import type { Db, Document } from "mongodb";
import { cached } from "./cache";

/** Active departments for bot keyboards and workflow pick_department. */
export async function activeDepartments(db: Db): Promise<Document[]> {
  return cached("departments:active", async () => {
    const all = await db
      .collection("departments")
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
