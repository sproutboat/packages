/**
 * The Porffor pin (one alpha at a time: `CURRENT_ALPHA`). It names the patched tree: `vendor/porffor-patched.tar.gz` is upstream's commit with
 * `porffor-patches/` applied, `vendor/porffor-patched.json` records the commit, series hash and tarball sha256. To move to a new alpha:
 * "Upgrading to a new alpha" in PATCHES.md.
 */
import manifest from "../../vendor/porffor-patched.json" with { type: "json" };

/** The one supported alpha. A test checks it against the manifest. */
export const CURRENT_ALPHA = "alpha-25";

export type PorfforA21Channel = typeof CURRENT_ALPHA;

export interface PorfforA21Pin {
  readonly channel: PorfforA21Channel;
  /** The upstream commit the series is applied to. */
  readonly commitFull: string;
  readonly commit: string;
  /** sha256 of the vendored PATCHED tarball (not of upstream's archive). */
  readonly archiveSha256: string;
  /** sha256 over the patch series, in order (`seriesSha256` in scripts/porffor-patches.ts). */
  readonly seriesSha256: string;
  /** The npm `porffor` version with this gitHead. */
  readonly npmVersion: string;
  /** The tarball vendored beside this package (`vendor/porffor-patched.tar.gz`). */
  readonly vendoredArchive: string;
}

const commitFull = manifest.upstream.commit;

export const PORFFOR_A21_PINS = {
  [CURRENT_ALPHA]: {
    channel: CURRENT_ALPHA,
    commitFull,
    commit: commitFull.slice(0, 7),
    archiveSha256: manifest.tarball.sha256,
    seriesSha256: manifest.series.sha256,
    npmVersion: manifest.upstream.npmVersion,
    vendoredArchive: manifest.tarball.file,
  },
} as const satisfies Readonly<Record<PorfforA21Channel, PorfforA21Pin>>;

export const PORFFOR_A25_CHANNEL = PORFFOR_A21_PINS["alpha-25"].channel;
export const PORFFOR_A25_COMMIT_FULL = PORFFOR_A21_PINS["alpha-25"].commitFull;
export const PORFFOR_A25_COMMIT = PORFFOR_A21_PINS["alpha-25"].commit;
/** sha256 of the vendored patched tarball. */
export const PORFFOR_A25_ARCHIVE_SHA256 = PORFFOR_A21_PINS["alpha-25"].archiveSha256;
export const PORFFOR_A25_SERIES_SHA256 = PORFFOR_A21_PINS["alpha-25"].seriesSha256;
export const PORFFOR_A25_NPM_VERSION = PORFFOR_A21_PINS["alpha-25"].npmVersion;

/** A compact identity string for a manifest / report (`alpha-25 (c9af40c)`). */
export function porfforA21Version(channel: PorfforA21Channel = CURRENT_ALPHA): string {
  const p = PORFFOR_A21_PINS[channel];
  return `${p.channel} (${p.commit})`;
}

/** Feature level of the compiler's refusal of its own intrinsics in app code (patch 0026); a test checks it against the shipped tree's `REFUSAL_LEVEL`. */
export const INTRINSIC_REFUSAL = 1;
