import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "productAttributes",
  dataType: "Product Attribute",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Input type: ${d.inputType ?? "text"}`,
});

export const { PATCH, DELETE } = handlers;
