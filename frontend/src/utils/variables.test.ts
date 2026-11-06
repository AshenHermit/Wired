import { describe, expect, it } from "vitest";

import { API_PREFIX, GODOT_EDITOR_URL, withApiPrefix } from "./variables";

describe("withApiPrefix", () => {
  it("prefixes an absolute backend path", () => {
    expect(withApiPrefix("/godot-project/wired/")).toBe(
      `${API_PREFIX}/godot-project/wired/`,
    );
  });

  it("adds the missing separator for a path without a leading slash", () => {
    expect(withApiPrefix("rooms/7/game")).toBe(`${API_PREFIX}/rooms/7/game`);
  });

  it("keeps one separator at the API root", () => {
    expect(withApiPrefix("/")).toBe(`${API_PREFIX}/`);
  });
});

describe("GODOT_EDITOR_URL", () => {
  it("is served through the API rewrite", () => {
    expect(GODOT_EDITOR_URL).toBe(`${API_PREFIX}/godot-editor`);
  });
});
