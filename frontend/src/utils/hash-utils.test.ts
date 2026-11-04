import { describe, expect, it } from "vitest";
import { decodeId, encodeId, type HashIdType } from "./hash-utils";

const TYPES: HashIdType[] = ["room", "package", "user"];

describe("hash ids", () => {
  it("round-trips every id type", () => {
    for (const type of TYPES) {
      for (const id of [1, 42, 12345]) {
        expect(decodeId(type, encodeId(type, id))).toBe(id);
      }
    }
  });

  it("pads a code to eight characters so links stay uniform", () => {
    expect(encodeId("room", 1)).toHaveLength(8);
  });

  it("does not accept a code minted for another type", () => {
    // Each type has its own salt, so a room code is not a package code: a
    // shared salt would let one kind of link address another kind of object.
    for (const type of TYPES) {
      for (const other of TYPES) {
        if (type === other) continue;
        expect(decodeId(type, encodeId(other, 7))).toBeNull();
      }
    }
  });

  it("reports a code that is not a hashid as absent", () => {
    expect(decodeId("room", "")).toBeNull();
    expect(decodeId("room", "lowercase-not-in-alphabet")).toBeNull();
  });
});
