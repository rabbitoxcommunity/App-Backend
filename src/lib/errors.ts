import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const errorCodes: Record<string, number> = JSON.parse(
  readFileSync(path.join(__dirname, '../shared/error-codes.json'), 'utf-8'),
);

export type ErrorCode = string;

/** §11 — one shape everywhere: { error: { code, message, details, requestId } }. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = errorCodes[code] ?? 500;
    this.details = details;
  }

  static validationFailed(details: Record<string, unknown>): AppError {
    return new AppError('VALIDATION_FAILED', 'The request body failed validation.', details);
  }

  static notFound(what: string): AppError {
    return new AppError('NOT_FOUND', `${what} was not found.`);
  }

  static forbidden(message = 'You do not have permission to do that.'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static unauthenticated(message = 'Missing or expired credentials.'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static conflict(message: string, details: Record<string, unknown> = {}): AppError {
    return new AppError('CONFLICT', message, details);
  }
}
