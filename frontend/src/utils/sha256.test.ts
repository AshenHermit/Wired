import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "./sha256";

/** Digest of "abc", the canonical sample from the FIPS 180-2 test vectors. */
const ABC_DIGEST =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("hashes bytes to a lowercase hex digest", async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      ABC_DIGEST,
    );
  });

  it("hashes an empty payload", async () => {
    await expect(sha256Hex(new Uint8Array())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("accepts a SharedArrayBuffer-backed view", async () => {
    const view = new Uint8Array(new SharedArrayBuffer(3));
    view.set(new TextEncoder().encode("abc"));

    await expect(sha256Hex(view)).resolves.toBe(ABC_DIGEST);
  });

  it("explains a missing Web Crypto API instead of hashing to nothing", async () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", {});

    try {
      await expect(sha256Hex(new Uint8Array())).rejects.toThrow(
        "Web Crypto API is not available in this environment",
      );
    } finally {
      vi.stubGlobal("crypto", original);
      vi.unstubAllGlobals();
    }
  });
});
