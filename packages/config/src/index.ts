import { z } from 'zod';
import { isIP } from 'node:net';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function dnsServer(value: string): boolean {
  if (isIP(value)) return true;
  const match =
    value.match(/^\[([0-9a-f:]+)\]:(\d{1,5})$/iu) ?? value.match(/^([0-9.]+):(\d{1,5})$/u);
  return Boolean(match && isIP(match[1]!) && Number(match[2]) >= 1 && Number(match[2]) <= 65535);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z
    .string()
    .url()
    .refine((s) => /^postgres(ql)?:/.test(s)),
  REDIS_URL: z
    .string()
    .url()
    .refine((s) => /^rediss?:/.test(s)),
  APP_ORIGIN: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MASTER_KEY_FILE: z.string().min(1),
  RESTORE_MODE: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(28800),
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .refine((values) =>
      values.every((value) => {
        if (['loopback', 'linklocal', 'uniquelocal'].includes(value)) return true;
        const parts = value.split('/');
        if (parts.length > 2) return false;
        const [address, prefix] = parts;
        const family = isIP(address ?? '');
        return (
          family !== 0 &&
          (prefix === undefined ||
            (/^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)))
        );
      }),
    ),
  TASK_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  TASK_LOG_MAX_BYTES: z.coerce.number().int().min(1024).max(1048576).default(16384),
  NETWORK_DNS_SERVERS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .refine((values) => values.length <= 4 && values.every(dnsServer)),
  NETWORK_LOCAL_ACME_CONFIG_FILE: z.string().max(4096).default(''),
  REGISTRY_HTTP_PROXY: z.string().max(2048).default(''),
  REGISTRY_PROXY_BLOB_ORIGINS: z.string().max(4096).default(''),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigurationError(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  const e = parsed.data;
  const origin = new URL(e.APP_ORIGIN);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new ConfigurationError('APP_ORIGIN must be an origin without credentials or a path');
  }
  if (!['http:', 'https:'].includes(origin.protocol))
    throw new ConfigurationError('Invalid APP_ORIGIN protocol');
  if (e.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    throw new ConfigurationError('Production APP_ORIGIN must use HTTPS');
  }
  if (e.NODE_ENV === 'production' && e.NETWORK_LOCAL_ACME_CONFIG_FILE)
    throw new ConfigurationError(
      'NETWORK_LOCAL_ACME_CONFIG_FILE is only allowed in a development or test process',
    );
  const registryProxyBlobOrigins = e.REGISTRY_PROXY_BLOB_ORIGINS.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  try {
    if (e.REGISTRY_HTTP_PROXY) {
      const proxy = new URL(e.REGISTRY_HTTP_PROXY);
      if (
        !['http:', 'https:'].includes(proxy.protocol) ||
        proxy.username ||
        proxy.password ||
        proxy.pathname !== '/' ||
        proxy.search ||
        proxy.hash
      )
        throw new Error();
    }
    if (
      registryProxyBlobOrigins.length > 8 ||
      (registryProxyBlobOrigins.length && !e.REGISTRY_HTTP_PROXY)
    )
      throw new Error();
    for (const origin of registryProxyBlobOrigins) {
      const blob = new URL(origin);
      if (blob.protocol !== 'https:' || blob.origin !== origin || blob.username || blob.password)
        throw new Error();
    }
  } catch {
    throw new ConfigurationError('Invalid REGISTRY_HTTP_PROXY or REGISTRY_PROXY_BLOB_ORIGINS');
  }
  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    appOrigin: origin.origin,
    host: e.HOST,
    port: e.PORT,
    workerHealthPort: e.WORKER_HEALTH_PORT,
    masterKeyFile: e.MASTER_KEY_FILE,
    restoreMode: e.RESTORE_MODE === 'true',
    logLevel: e.LOG_LEVEL,
    sessionTtlSeconds: e.SESSION_TTL_SECONDS,
    trustedProxyCidrs: e.TRUSTED_PROXY_CIDRS,
    taskLogRetentionDays: e.TASK_LOG_RETENTION_DAYS,
    taskLogMaxBytes: e.TASK_LOG_MAX_BYTES,
    networkDnsServers: e.NETWORK_DNS_SERVERS,
    networkLocalAcmeConfigFile: e.NETWORK_LOCAL_ACME_CONFIG_FILE || undefined,
    registryHttpProxy: e.REGISTRY_HTTP_PROXY || undefined,
    registryProxyBlobOrigins,
  };
}

export type RuntimeConfig = ReturnType<typeof loadConfig>;

/** Callers log identifiers and outcomes, never request bodies or credential values. */
export function createLogger(
  name: string,
  options: LoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      name,
      level: process.env.LOG_LEVEL ?? 'info',
      ...options,
      redact: {
        paths: [
          'password',
          'passwordHash',
          'token',
          'csrfToken',
          'cookie',
          'authorization',
          'payload',
          'encryptedPayload',
          'nonce',
          'tag',
          'databaseUrl',
          'redisUrl',
          'privateKey',
          'passphrase',
          'connectionString',
          'req.headers.cookie',
          'req.headers.authorization',
          'req.headers["x-csrf-token"]',
          'req.body',
          'res.headers["set-cookie"]',
          '*.password',
          '*.passwordHash',
          '*.token',
          '*.csrfToken',
          '*.payload',
          '*.encryptedPayload',
          '*.privateKey',
          '*.passphrase',
          '*.connectionString',
        ],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}
