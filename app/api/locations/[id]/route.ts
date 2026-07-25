import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "locations",
  dataType: "Storage Location",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Level: ${d.level ?? ""}`,
});

export const { PATCH, DELETE } = handlers;
