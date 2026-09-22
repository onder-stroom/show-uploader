/**
 * A rule refusing the request, as opposed to something breaking.
 *
 * Use cases throw this instead of a transport error so they stay callable from
 * anywhere (tRPC, REST, a script). The router maps `code` onto its own error
 * type; anything that isn't a UseCaseError is an unexpected failure (500).
 */
export type UseCaseErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED';

export class UseCaseError extends Error {
  constructor(
    readonly code: UseCaseErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'UseCaseError';
  }
}
