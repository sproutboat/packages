/** Flags that turn on Node built-ins and the free `Buffer`, `process` and `global` bindings. */
export const NODEJS_COMPAT_FLAGS: readonly string[] = ["nodejs_compat", "nodejs_compat_v2"];

/** Flags whose behaviour the runtime already has, accepted as no-ops. Each needs a reason, and the test pins the list. */
export const NOOP_COMPATIBILITY_FLAGS: ReadonlyArray<readonly [flag: string, reason: string]> = [
  ["nodejs_als", "AsyncLocalStorage exists in the runtime"],
  ["nodejs_compat_populate_process_env", "process.env holds the text bindings from compatibility date 2026-11-23"],
  ["global_fetch_strictly_public", "fetch() to an address of the platform itself is refused by the egress rules"],
];

/** Anything not listed is refused, as Cloudflare refuses an unknown flag. */
export const SUPPORTED_COMPATIBILITY_FLAGS: readonly string[] = [
  ...NODEJS_COMPAT_FLAGS,
  ...NOOP_COMPATIBILITY_FLAGS.map(([flag]) => flag),
];

export const hasNodejsCompat = (flags: readonly string[]): boolean =>
  flags.some((flag) => NODEJS_COMPAT_FLAGS.includes(flag));
