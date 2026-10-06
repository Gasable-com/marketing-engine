/** One error type the API layer maps straight to a status and a code. */
export class DiscoveryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

/**
 * Claude's plan has run out for now. Not a failure: the job or task waits
 * until `resetsAt` (an hour when nobody said) and carries on from where it was.
 */
export class UsageLimitError extends Error {
  constructor(readonly resetsAt: Date | null) {
    super('claude usage limit reached');
  }
}

/** Retrying cannot help: a key is wrong, a provider refuses, a product is unknowable. */
export class PermanentError extends Error {}
