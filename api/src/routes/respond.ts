// api/src/routes/respond.ts
import type { Response } from 'express';
import { UseCaseError } from '../usecases/errors';

const STATUS = { NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412 } as const;

/** A refused rule keeps its code and message; anything else is logged and becomes a 500. */
export function sendFailure(res: Response, err: unknown, log: string, publicMessage: string): void {
  if (err instanceof UseCaseError) {
    res.status(STATUS[err.code]).json({ error: err.message });
    return;
  }
  console.error(log, err);
  res.status(500).json({ error: publicMessage });
}
