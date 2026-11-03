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

/**
 * Decodes a URL id, or returns null when the code is not a valid hashid.
 *
 * Hashids reports "not our code" in two different ways: it throws when the code
 * holds characters outside its alphabet, and it returns an empty list when the
 * salt does not match. Both mean the same thing to a caller — there is no such
 * object — so both end up as null rather than as a crash.
 */
export function decodeId(type: HashIdType, encodedId: string): number | null {
  let decoded: Array<number | bigint>;
  try {
    decoded = getHashIds(type).decode(encodedId);
  } catch {
    return null;
  }
  return decoded.length > 0 ? Number(decoded[0]) : null;
}
