import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "categories",
  dataType: "Category",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Category code: ${d.code ?? ""}`,
  sort: { order: 1 },
});

export const { GET, POST } = handlers;
