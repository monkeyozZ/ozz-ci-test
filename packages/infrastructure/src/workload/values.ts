import type { WorkloadMetrics } from './contracts.js';

export function quantity(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = /^(\d+(?:\.\d+)?|\.\d+)([eE][+-]?\d+|[numkMGTPE]|[KMGTPE]i)?$/u.exec(value);
  if (!parts) return null;
  const units: Record<string, number> = {
    n: 1e-9,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
    P: 1e15,
    E: 1e18,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };
  const suffix = parts[2];
  const factor = !suffix
    ? 1
    : /^[eE][+-]?\d+$/u.test(suffix)
      ? 10 ** Number(suffix.slice(1))
      : units[suffix];
  if (factor === undefined) return null;
  const result = Number(parts[1]) * factor;
  return Number.isFinite(result) && result >= 0 && result <= Number.MAX_SAFE_INTEGER
    ? result
    : null;
}

export function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function date(value: unknown): string | null {
  if (!(typeof value === 'string' || value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function windowSeconds(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/gu)];
  if (!parts.length || parts.map((part) => part[0]).join('') !== value) return null;
  const units: Record<string, number> = {
    ns: 1e-9,
    us: 1e-6,
    µs: 1e-6,
    ms: 1e-3,
    s: 1,
    m: 60,
    h: 3600,
  };
  const result = parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]!]!, 0);
  return Number.isFinite(result) && result > 0 && result <= 86_400 ? result : null;
}

export function unknownMetrics(): WorkloadMetrics {
  return {
    state: 'unknown',
    cpuCores: null,
    memoryBytes: null,
    observedAt: null,
    windowSeconds: null,
  };
}
