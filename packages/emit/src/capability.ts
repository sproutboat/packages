import { validateHttpSyncSource } from "@sproutboat/runtime";
import { EmitError, issue } from "./errors";

/** The source check on the bundled output, so a dependency reaching for a Node API fails as hand-written code would. */
export function checkCapabilities(bundled: string, compatibilityDate: string): void {
  const result = validateHttpSyncSource(bundled, compatibilityDate);
  if (!result.ok) throw new EmitError(result.errors.map((message) => issue("capability-check", message)));
}
