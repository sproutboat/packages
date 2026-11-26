/**
 * Compatibility flags as Cloudflare defines them, from https://developers.cloudflare.com/workers/configuration/compatibility-flags/
 * (read 2026-11-26). The flags are decided from the date the upload DECLARED, never from the date this build runs as: a
 * floor on an old date changes the runtime generation, and must not switch Node behaviour on or off.
 */

/** Flags that turn on Node built-ins and the free `Buffer`, `process` and `global` bindings. */
export const NODEJS_COMPAT_FLAGS: readonly string[] = ["nodejs_compat", "nodejs_compat_v2"];

/** "For compatibility dates of 2026-08-04 or later, Workers enables both nodejs_compat and nodejs_compat_v2 by default." */
export const NODEJS_COMPAT_DEFAULT_DATE = "2026-08-04";
/** `nodejs_compat_populate_process_env` is on by default from this date, with `nodejs_compat` ("Default as of 2025-04-01"). */
export const POPULATE_PROCESS_ENV_DEFAULT_DATE = "2025-04-01";
export const NODEJS_COMPAT_OFF_FLAG = "no_nodejs_compat";
/** With `no_nodejs_compat` it is how Cloudflare's docs switch the 2026-08-04 default off. Alone it asks for v1, which is not built. */
export const NODEJS_COMPAT_V2_OFF_FLAG = "no_nodejs_compat_v2";
export const POPULATE_PROCESS_ENV_FLAG = "nodejs_compat_populate_process_env";
export const DO_NOT_POPULATE_PROCESS_ENV_FLAG = "nodejs_compat_do_not_populate_process_env";

/** Flags whose behaviour the runtime already has, accepted as no-ops. Each needs a reason, and the test pins the list. */
export const NOOP_COMPATIBILITY_FLAGS: ReadonlyArray<readonly [flag: string, reason: string]> = [
  ["nodejs_als", "AsyncLocalStorage exists in the runtime"],
  ["global_fetch_strictly_public", "fetch() to an address of the platform itself is refused by the egress rules"],
  [
    "new_module_registry",
    "modules are resolved by name from the upload, as the new registry does (Alchemy v2 sends it)",
  ],
  [
    "legacy_module_registry",
    "uploads are resolved by name and carry no import attributes, the part of the registry the two differ on",
  ],
];

/** Honoured by the emitter itself, so not no-ops: each changes what is built. */
export const HONOURED_COMPATIBILITY_FLAGS: readonly string[] = [
  ...NODEJS_COMPAT_FLAGS,
  NODEJS_COMPAT_OFF_FLAG,
  NODEJS_COMPAT_V2_OFF_FLAG,
  POPULATE_PROCESS_ENV_FLAG,
  DO_NOT_POPULATE_PROCESS_ENV_FLAG,
  "no_nodejs_als",
];

/** Anything not listed is refused, as Cloudflare refuses an unknown flag. */
export const SUPPORTED_COMPATIBILITY_FLAGS: readonly string[] = [
  ...HONOURED_COMPATIBILITY_FLAGS,
  ...NOOP_COMPATIBILITY_FLAGS.map(([flag]) => flag),
];

/** Pairs a Worker cannot carry together: a flag and the flag that turns it off. */
const CONTRADICTIONS: ReadonlyArray<readonly [string, string]> = [
  ["nodejs_compat", NODEJS_COMPAT_OFF_FLAG],
  ["nodejs_compat_v2", NODEJS_COMPAT_V2_OFF_FLAG],
  ["nodejs_compat_v2", NODEJS_COMPAT_OFF_FLAG],
  ["nodejs_als", "no_nodejs_als"],
  [POPULATE_PROCESS_ENV_FLAG, DO_NOT_POPULATE_PROCESS_ENV_FLAG],
  ["new_module_registry", "legacy_module_registry"],
];

/** What the flags and the declared date make of Node support. */
export type NodeFlags = {
  /** Node built-ins resolve, and `Buffer`, `process` and `global` are bound. */
  compat: boolean;
  /** `AsyncLocalStorage` alone (without `compat`). */
  als: boolean;
  /** `process.env` holds the bindings that carry text or JSON. */
  populateProcessEnv: boolean;
};

export type NodeFlagsResult = { ok: true; value: NodeFlags } | { ok: false; message: string };

/** Decide Node support the way Cloudflare does, from the flags and the DECLARED compatibility date. */
export function resolveNodeFlags(flags: readonly string[], declaredDate: string): NodeFlagsResult {
  for (const [on, off] of CONTRADICTIONS)
    if (flags.includes(on) && flags.includes(off))
      return { ok: false, message: `compatibility flags "${on}" and "${off}" contradict each other` };
  const asked = flags.some((flag) => NODEJS_COMPAT_FLAGS.includes(flag));
  const off = flags.includes(NODEJS_COMPAT_OFF_FLAG);
  const compat = !off && (asked || declaredDate >= NODEJS_COMPAT_DEFAULT_DATE);
  if (compat && flags.includes(NODEJS_COMPAT_V2_OFF_FLAG))
    return {
      ok: false,
      message: `"${NODEJS_COMPAT_V2_OFF_FLAG}" selects Node.js compatibility v1, which is not supported; to turn Node.js compatibility off, send "${NODEJS_COMPAT_OFF_FLAG}" as well`,
    };
  if (compat && flags.includes("no_nodejs_als"))
    return {
      ok: false,
      message: `"no_nodejs_als" cannot take AsyncLocalStorage out of Node.js compatibility, which is on for this upload`,
    };
  const populate =
    compat &&
    !flags.includes(DO_NOT_POPULATE_PROCESS_ENV_FLAG) &&
    (flags.includes(POPULATE_PROCESS_ENV_FLAG) || declaredDate >= POPULATE_PROCESS_ENV_DEFAULT_DATE);
  return { ok: true, value: { compat, als: !compat && flags.includes("nodejs_als"), populateProcessEnv: populate } };
}
