const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

export type FileSizeUnit = "kb" | "mb";

/** Splits a byte count into the unit the package card renders. */
export function formatFileSize(bytes: number): {
  value: number;
  unit: FileSizeUnit;
} {
  return bytes >= BYTES_PER_MB
    ? { value: bytes / BYTES_PER_MB, unit: "mb" }
    : { value: bytes / BYTES_PER_KB, unit: "kb" };
}
