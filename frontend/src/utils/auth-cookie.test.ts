import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_COOKIE_NAME, readAccessToken } from "./auth-cookie";

function clearCookies() {
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCookies();
});

describe("readAccessToken", () => {
  it("returns null when the browser holds no session", () => {
    expect(readAccessToken()).toBeNull();
  });

  it("returns the token the backend set", () => {
    document.cookie = `${AUTH_COOKIE_NAME}=token-123; path=/`;
    expect(readAccessToken()).toBe("token-123");
  });

  it("decodes a percent-encoded token", () => {
    document.cookie = `${AUTH_COOKIE_NAME}=a%20b%2Bc; path=/`;
    expect(readAccessToken()).toBe("a b+c");
  });

  it("ignores a cookie whose name only ends with the token name", () => {
    document.cookie = `not_${AUTH_COOKIE_NAME}=leak; path=/`;
    expect(readAccessToken()).toBeNull();
  });

  it("returns null where there is no document to read", () => {
    vi.stubGlobal("document", undefined);
    expect(readAccessToken()).toBeNull();
  });
});
