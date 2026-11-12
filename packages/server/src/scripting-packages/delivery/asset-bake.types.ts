/** One headless bake: a raw glb in, a self-contained scene out. */
export type BakeJob = {
  source: string;
  output: string;
  /** Normalized `.import` text, or null when the author never tuned the import. */
  preset: string | null;
};

/** One result entry of the `WIRED_BAKE_OK` payload. */
export type BakeToolResult = {
  source?: string;
  output: string;
  size?: number;
  animations?: string[];
  materials?: string[];
  warnings?: string[];
};

/** A package cannot be delivered because one of its assets cannot be baked. */
export class AssetBakeError extends Error {
  readonly code = 'package_asset_bake_failed';

  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'AssetBakeError';
  }
}
