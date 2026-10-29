import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Build DSNs inside the process so passwords containing URI punctuation remain
// valid and are never interpolated into shell commands or baked into an image.
if (!process.env.DATABASE_URL && process.env.POSTGRES_PASSWORD) {
  const url = new URL('postgresql://postgres:5432/');
  url.username = process.env.POSTGRES_USER || 'ozz';
  url.password = process.env.POSTGRES_PASSWORD;
  url.pathname = `/${encodeURIComponent(process.env.POSTGRES_DB || 'ozz')}`;
  url.searchParams.set('schema', process.env.DATABASE_SCHEMA || 'public');
  url.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT || '5');
  url.searchParams.set('pool_timeout', '5');
  url.searchParams.set('connect_timeout', '5');
  process.env.DATABASE_URL = url.toString();
}
if (!process.env.REDIS_URL && process.env.REDIS_PASSWORD) {
  const url = new URL('redis://redis:6379/0');
  url.password = process.env.REDIS_PASSWORD;
  process.env.REDIS_URL = url.toString();
}
const [target, ...args] = process.argv.slice(2);
if (!target) throw new Error('A runtime entrypoint is required');
const entry = resolve(target);
process.argv = [process.execPath, entry, ...args];
await import(pathToFileURL(entry).href);
