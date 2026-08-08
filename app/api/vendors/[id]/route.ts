import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "vendors",
  dataType: "Vendor",
  entityName: (d) => String(d.name ?? ""),
  recycleDetail: (d) => [d.code, d.contact, d.phone].filter(Boolean).join(" · ") || "Vendor",
});

export const { PATCH, DELETE } = handlers;
