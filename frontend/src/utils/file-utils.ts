export function uint8ArrayToFile(
  uint8Array: Uint8Array,
  fileName: string,
  mimeType: string
) {
  // The cast is needed because the engine hands back a SharedArrayBuffer-backed
  // view, which the Blob constructor refuses without widening it to BlobPart.
  const blob = new Blob([uint8Array as BlobPart], { type: mimeType });
  return new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });
}
