export function uint8ArrayToFile(
  uint8Array: Uint8Array,
  fileName: string,
  mimeType: string
) {
  // 1. Create a Blob from the Uint8Array
  // The Blob constructor accepts an array of data chunks.
  const blob = new Blob([uint8Array as BlobPart], { type: mimeType });

  // 2. Create a File object from the Blob
  // The File constructor is essentially the Blob constructor with added file properties.
  const file = new File([blob], fileName, {
    type: mimeType,
    lastModified: Date.now(),
  });

  return file;
}
