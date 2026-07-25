import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "categories",
  dataType: "Category",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Category code: ${d.code ?? ""}`,
});

export const { PATCH, DELETE } = handlers;
