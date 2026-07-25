import { createCrudHandlers } from "@/lib/crud";

const handlers = createCrudHandlers({
  collection: "telegramGroups",
  dataType: "Telegram Group",
  entityName: (d) => String(d.title ?? ""),
  recycleDetail: (d) => `Chat id: ${d.chatId ?? ""}`,
  sort: { title: 1 },
});

export const { GET, POST } = handlers;
