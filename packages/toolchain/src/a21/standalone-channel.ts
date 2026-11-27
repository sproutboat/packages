import { CURRENT_ALPHA, type PorfforA21Channel } from "./pin";

/**
 * Which Porffor channel a standalone build uses: `CURRENT_ALPHA` (alpha 26). `SPROUTBOAT_PORFFOR_CHANNEL` may name it; older alphas are refused with an error
 * rather than built under their name. The CLI, the native tests and `scripts/test-native.ts` all resolve it here so they cannot disagree.
 */
export type StandaloneChannel = PorfforA21Channel;

export const STANDALONE_DEFAULT_CHANNEL: StandaloneChannel = CURRENT_ALPHA;
export const STANDALONE_CHANNEL_ENV = "SPROUTBOAT_PORFFOR_CHANNEL";

export function standaloneChannel(env: Record<string, string | undefined> = process.env): StandaloneChannel {
  const raw = env[STANDALONE_CHANNEL_ENV];
  if (!raw) return STANDALONE_DEFAULT_CHANNEL;
  if (raw === CURRENT_ALPHA) return raw;
  const retired = /^alpha-(19|2[12345])$/.test(raw)
    ? `; ${raw} is no longer supported, the toolchain keeps one alpha`
    : "";
  throw new Error(`${STANDALONE_CHANNEL_ENV}=${raw}: expected ${CURRENT_ALPHA}${retired}`);
}

/** The compiler channel a standalone channel renders with (the same one: there is one alpha). */
export function standaloneA21Channel(channel: StandaloneChannel): PorfforA21Channel {
  return channel;
}
