export interface Resource<T> {
  data: T;
}
export interface Page<T> extends Resource<T[]> {
  page: { nextCursor: string | null; hasMore: boolean };
}
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: Record<string, string[]>;
}
export type { components, paths, operations } from './schema';
