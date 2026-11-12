/** Suffix of the baked scene that replaces a raw glTF asset at runtime. */
export const BAKED_SUFFIX = '.scn';

/** Bumped whenever the bake tool or its output format changes. */
export const BAKE_TOOL_VERSION = 1;

/** Bumped whenever the pipeline changes what an artifact contains. */
export const ASSET_BAKE_VERSION = 1;

/** Formats that need an editor importer and are not baked in v1. */
export const UNSUPPORTED_ASSET_EXTENSIONS = ['.gltf', '.fbx', '.dae', '.obj', '.blend'] as const;
