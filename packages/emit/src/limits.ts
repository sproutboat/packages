/** Caps shared by the CLI, the API and the emit unit, so one implementation answers all three. */
export const MAX_MODULES = 256;
export const MAX_MODULE_NAME_LENGTH = 256;
/**
 * Code modules (esm, cjs, text) together: today's source cap, in bytes. Cloudflare's limits page (read 2026-11-26) gives
 * a Worker 64 MiB uncompressed on both plans and no compressed limit, so this and the caps below are Sproutboat's own,
 * deliberately tighter (see "Parity notes" in the README). Every cap here counts UTF-8 bytes.
 */
export const MAX_CODE_BYTES = 8 * 1024 * 1024;
/** A `data` module becomes a latin1 string in the module static-data region, which is 1 MiB for the whole module. */
export const MAX_DATA_MODULE_BYTES = 1024 * 1024;
/** All `data` modules together: the static-data region is one per module, so the sum has the same cap. */
export const MAX_DATA_TOTAL_BYTES = MAX_DATA_MODULE_BYTES;
/** All `sourcemap` modules together. Stored, never compiled; Cloudflare counts every part toward the script size. */
export const MAX_SOURCEMAP_BYTES = 8 * 1024 * 1024;
/** Every module of the upload together (code, data and sourcemaps), before any expansion. */
export const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/**
 * What the bundler is handed: code modules plus text and data modules as the string literals they become (a control
 * character grows to 6 bytes), in bytes. Checked before bundling, and again on the bundled output in UTF-8 bytes.
 */
export const MAX_BUNDLED_BYTES = 16 * 1024 * 1024;
export const MAX_METADATA_BYTES = 256 * 1024;
/** Record bindings plus service bindings (vars and version metadata are baked, not bindings of the record). */
export const MAX_BINDINGS = 64;
export const MAX_CRONS = 16;
export const MAX_QUEUE_CONSUMERS = 16;
