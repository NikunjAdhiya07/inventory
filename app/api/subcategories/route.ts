import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "subcategories",
  dataType: "Subcategory",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Parent: ${d.parent ?? ""}`,
  sort: { parent: 1, order: 1 },
});

export const { GET, POST } = handlers;
