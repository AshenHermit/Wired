import Hashids from "hashids";
import { HASH_ID_SECRET } from "./variables";

export type HashIdType = "room" | "package" | "user";

function getHashIds(type: HashIdType) {
  return new Hashids(
    HASH_ID_SECRET + type,
    8,
    "QWERTYUIOPASDFGHJKLZXCVBNM1234567890"
  );
}

export function encodeId(type: HashIdType, id: number) {
  const hashids = getHashIds(type);
  return hashids.encode(id);
}

export function decodeId(type: HashIdType, encodedId: string): number {
  const hashids = getHashIds(type);
  const decoded = hashids.decode(encodedId);
  return decoded.length > 0 ? Number(decoded[0]) : -1;
}
