import { HttpException } from '@nestjs/common';

/** Public errors carry safe text only. Never pass driver errors or raw input. */
export class Problem extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    detail: string,
    public readonly errors?: Record<string, string[]>,
  ) {
    super({ code, detail, ...(errors ? { errors } : {}) }, status);
  }
}
