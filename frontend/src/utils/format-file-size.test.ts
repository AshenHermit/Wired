import { describe, expect, it } from "vitest";
import { formatFileSize } from "./format-file-size";

describe("formatFileSize", () => {
  it("uses KB below one MiB", () => {
    expect(formatFileSize(900_000)).toEqual({
      value: 878.90625,
      unit: "kb",
    });
    expect(formatFileSize(1_048_575).unit).toBe("kb");
  });

  it("switches to MB from one MiB", () => {
    expect(formatFileSize(1_048_576)).toEqual({ value: 1, unit: "mb" });
    expect(formatFileSize(1_500_000).unit).toBe("mb");
  });

  it("keeps zero as a zero KB size", () => {
    expect(formatFileSize(0)).toEqual({ value: 0, unit: "kb" });
  });
});
