/**
 * SHA-256 of the given bytes as a lowercase hex string.
 *
 * Uses the Web Crypto API, which is available in every browser that can run the
 * Godot Web export and on `localhost` during development.
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is not available in this environment");
  }
  // `slice()` yields an ArrayBuffer-backed view; `BufferSource` rejects a
  // `SharedArrayBuffer`-backed one, which Emscripten can hand us.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data.slice());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
