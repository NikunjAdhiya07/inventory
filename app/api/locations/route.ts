import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "locations",
  dataType: "Storage Location",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `Level: ${d.level ?? ""}`,
});

export const { GET, POST } = handlers;
