import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "roles",
  dataType: "Role",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => `${d.users ?? 0} users assigned`,
});

export const { GET, POST } = handlers;
