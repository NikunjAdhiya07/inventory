import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "departments",
  dataType: "Department",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => [d.code, d.contact].filter(Boolean).join(" · ") || "Department",
});

export const { PATCH, DELETE } = handlers;
