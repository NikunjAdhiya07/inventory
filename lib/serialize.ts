import type { ObjectId, WithId, Document } from "mongodb";

export function toClient<T extends Document>(doc: WithId<T>): Omit<T, "_id"> & { id: string } {
  const { _id, ...rest } = doc;
  return { id: (_id as ObjectId).toString(), ...rest } as Omit<T, "_id"> & { id: string };
}

export function toClientList<T extends Document>(docs: WithId<T>[]): (Omit<T, "_id"> & { id: string })[] {
  return docs.map(toClient);
}
