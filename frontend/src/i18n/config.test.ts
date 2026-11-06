import { describe, expect, it } from "vitest";
import { defaultLocale, isLocale, resolveLocale } from "./config";

describe("resolveLocale", () => {
  it("defaults to English for missing, unknown, and malformed values", () => {
    expect(defaultLocale).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale(null)).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale("de")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
  });

  it("accepts supported locales", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("ru")).toBe("ru");
    expect(isLocale("ru")).toBe(true);
    expect(isLocale("EN")).toBe(false);
  });
});
