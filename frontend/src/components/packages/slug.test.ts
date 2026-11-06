import { describe, expect, it } from "vitest";
import { slugHintKey } from "./slug";

describe("slugHintKey", () => {
  it("maps each checked state to a catalog key", () => {
    expect(slugHintKey("invalid")).toBe("Slug.invalid");
    expect(slugHintKey("checking")).toBe("Slug.checking");
    expect(slugHintKey("available")).toBe("Slug.available");
    expect(slugHintKey("taken")).toBe("Slug.taken");
    expect(slugHintKey("error")).toBe("Slug.checkFailed");
    expect(slugHintKey("idle")).toBeUndefined();
  });
});
