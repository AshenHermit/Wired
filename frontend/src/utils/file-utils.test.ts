import { describe, expect, it } from "vitest";

import { uint8ArrayToFile } from "./file-utils";

describe("uint8ArrayToFile", () => {
  it("wraps the bytes in a File with the given name and type", async () => {
    const file = uint8ArrayToFile(
      new Uint8Array([1, 2, 3]),
      "hero.gd",
      "text/plain",
    );

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("hero.gd");
    expect(file.type).toBe("text/plain");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("keeps an empty file empty", async () => {
    const file = uint8ArrayToFile(
      new Uint8Array(),
      "empty.bin",
      "application/octet-stream",
    );

    expect(file.size).toBe(0);
    expect(file.type).toBe("application/octet-stream");
  });
});
