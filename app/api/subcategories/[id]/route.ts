import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "subcategories",
  dataType: "Subcategory",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Parent: ${d.parent ?? ""}`,
});

export const { PATCH, DELETE } = handlers;
