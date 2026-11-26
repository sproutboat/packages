/** Caps shared by the CLI, the API and the emit unit, so one implementation answers all three. */
export const MAX_MODULES = 256;
export const MAX_MODULE_NAME_LENGTH = 256;
/** Code modules (esm, cjs, text) together: today's source cap. Cloudflare allows 3 MiB free and 10 MiB paid, compressed. */
export const MAX_CODE_BYTES = 8 * 1024 * 1024;
/** A `data` module becomes a latin1 string in the module's static-data region (1 MiB for the whole module). */
export const MAX_DATA_MODULE_BYTES = 1024 * 1024;
export const MAX_METADATA_BYTES = 256 * 1024;
/** Record bindings plus service bindings (vars and version metadata are baked, not bindings of the record). */
export const MAX_BINDINGS = 64;
export const MAX_CRONS = 16;
export const MAX_QUEUE_CONSUMERS = 16;
