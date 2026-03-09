export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly retryable: boolean;

  constructor(message: string, options?: { code?: string; statusCode?: number; retryable?: boolean }) {
    super(message);
    this.name = 'AppError';
    this.code = options?.code ?? 'APP_ERROR';
    this.statusCode = options?.statusCode ?? 500;
    this.retryable = options?.retryable ?? false;
  }
}
