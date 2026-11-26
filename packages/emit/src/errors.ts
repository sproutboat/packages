/** Stable machine-readable reasons. The cloud API reuses these as its `reason` field, so a client can branch on one. */
export const EMIT_REASONS = [
  "metadata-invalid",
  "compat-date-invalid",
  "module-missing",
  "module-invalid",
  "module-type-unsupported",
  "service-worker-unsupported",
  "binding-type-unsupported",
  "binding-invalid",
  "flag-unsupported",
  "migration-unsupported",
  "limit-exceeded",
  "no-such-module",
  "import-attribute-refused",
  "assets-date-unsupported",
  "capability-check",
  "handler-missing",
  "do-class-not-exported",
  "bundle-failed",
  // Raised by the cloud API, not by this package (they need the app's stored state); listed so there is one enumeration.
  "migration-tag-mismatch",
  "storage-id-shared",
] as const;

export type EmitReason = (typeof EMIT_REASONS)[number];

export type EmitIssue = {
  reason: EmitReason;
  message: string;
  /** Where in the input: `metadata.bindings[2].type`, `modules[0].name`. */
  path?: string;
};

/** One or more refusals. `message` joins them; `issues` is what a caller branches on. */
export class EmitError extends Error {
  readonly issues: EmitIssue[];
  constructor(issues: EmitIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "EmitError";
    this.issues = issues;
  }
  get reason(): EmitReason {
    return this.issues[0]!.reason;
  }
}

export const issue = (reason: EmitReason, message: string, path?: string): EmitIssue =>
  path === undefined ? { reason, message } : { reason, message, path };
