import { createItemHandlers } from "@/lib/crud";

const handlers = createItemHandlers({
  collection: "telegramGroups",
  dataType: "Telegram Group",
  entityName: (d) => String(d.title ?? ""),
  recycleDetail: (d) => `Chat id: ${d.chatId ?? ""}`,
});

export const { PATCH, DELETE } = handlers;
