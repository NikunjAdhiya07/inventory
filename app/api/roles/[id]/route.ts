import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "roles",
  dataType: "Role",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `${d.users ?? 0} users assigned`,
});

export const { PATCH, DELETE } = handlers;
