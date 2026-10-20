export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, details?: Record<string, unknown>) =>
  new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Sign in required') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'You do not have access to this') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, msg: string, details?: Record<string, unknown>) =>
  new AppError(409, code, msg, details);
export const tooMany = (code: string, msg: string, details?: Record<string, unknown>) =>
  new AppError(429, code, msg, details);
