/** Flags that turn on Node built-ins and the free `Buffer`, `process` and `global` bindings. */
export const NODEJS_COMPAT_FLAGS: readonly string[] = ["nodejs_compat", "nodejs_compat_v2"];

/** Cloudflare turns `nodejs_compat` on from this date, so a flag for it is redundant there (Alchemy v2 sends none). */
export const NODEJS_COMPAT_DEFAULT_DATE = "2026-08-04";
export const NODEJS_COMPAT_OFF_FLAG = "no_nodejs_compat";

/** Flags whose behaviour the runtime already has, accepted as no-ops. Each needs a reason, and the test pins the list. */
export const NOOP_COMPATIBILITY_FLAGS: ReadonlyArray<readonly [flag: string, reason: string]> = [
  ["nodejs_als", "AsyncLocalStorage exists in the runtime"],
  ["nodejs_compat_populate_process_env", "process.env holds the text bindings from compatibility date 2026-11-23"],
  ["global_fetch_strictly_public", "fetch() to an address of the platform itself is refused by the egress rules"],
  [
    "new_module_registry",
    "modules are resolved by name from the upload, as the new registry does (Alchemy v2 sends it)",
  ],
];

/** Anything not listed is refused, as Cloudflare refuses an unknown flag. */
export const SUPPORTED_COMPATIBILITY_FLAGS: readonly string[] = [
  ...NODEJS_COMPAT_FLAGS,
  NODEJS_COMPAT_OFF_FLAG,
  ...NOOP_COMPATIBILITY_FLAGS.map(([flag]) => flag),
];

/** Node built-ins and globals are on by the flag, or by the date unless `no_nodejs_compat` says otherwise. */
export function nodejsCompatEnabled(flags: readonly string[], compatibilityDate: string): boolean {
  if (flags.includes(NODEJS_COMPAT_OFF_FLAG)) return false;
  return flags.some((flag) => NODEJS_COMPAT_FLAGS.includes(flag)) || compatibilityDate >= NODEJS_COMPAT_DEFAULT_DATE;
}
