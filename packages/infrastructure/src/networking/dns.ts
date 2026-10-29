import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import {
  NetworkingAdapterError,
  type DomainDnsInspector,
  type DomainDnsObservation,
} from './contracts.js';

export interface NetworkDnsResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  cancel(): void;
}

export interface DomainDnsOptions {
  timeoutMs?: number;
  /** Per-instance resolvers support an explicit split-DNS lab without changing global DNS. */
  servers?: readonly string[];
  resolverFactory?: () => NetworkDnsResolver;
  now?: () => Date;
}

function name(value: string): string {
  const result = domainToASCII(value.replace(/\.$/u, '')).toLowerCase();
  if (
    !result ||
    result.length > 253 ||
    isIP(result) ||
    result
      .split('.')
      .some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
  )
    throw new NetworkingAdapterError('DNS_INPUT_INVALID', 'DNS 名称格式无效。');
  return result;
}

function address(value: string): string {
  const family = isIP(value);
  if (!family || value.includes('%'))
    throw new NetworkingAdapterError('DNS_RESPONSE_INVALID', 'DNS 返回了无效的地址。');
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

const negativeCodes = new Set(['ENODATA', 'ENOTFOUND']);

/** Each check owns its resolver, deadline and cancellation; no shared global resolver is modified. */
export class NodeDomainDnsInspector implements DomainDnsInspector {
  private readonly timeoutMs: number;
  constructor(private readonly options: DomainDnsOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 15_000)
      throw new TypeError('Invalid DNS inspection timeout');
  }

  async inspect(
    hostname: string,
    expected: { addresses: readonly string[]; cname: string | null },
    options: { signal?: AbortSignal } = {},
  ): Promise<DomainDnsObservation> {
    const queryName = name(hostname);
    if (expected.addresses.length > 8)
      throw new NetworkingAdapterError('DNS_INPUT_INVALID', 'DNS 入口地址超过允许数量。');
    const result: DomainDnsObservation = {
      state: 'error',
      observedAt: '',
      addresses: [],
      cnameChain: [],
      expectedAddresses: [...new Set(expected.addresses.map(address))].sort(),
      expectedCname: expected.cname ? name(expected.cname) : null,
      code: null,
      message: '',
    };
    const finish = (
      state: DomainDnsObservation['state'],
      code: string | null,
      message: string,
    ) => ({
      ...result,
      state,
      code,
      message,
      observedAt: (this.options.now?.() ?? new Date()).toISOString(),
    });
    if (!result.expectedAddresses.length && !result.expectedCname)
      return finish('unconfigured', 'NETWORK_ENTRY_REQUIRED', '尚未配置此集群的预期入口。');
    const resolver =
      this.options.resolverFactory?.() ??
      new Resolver({ timeout: Math.min(2_000, this.timeoutMs), tries: 1 });
    if (this.options.servers?.length && resolver instanceof Resolver)
      resolver.setServers([...this.options.servers]);
    let stop!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = reject;
    });
    const abort = () => {
      resolver.cancel();
      stop(new NetworkingAdapterError('DNS_CANCELLED', 'DNS 检查已取消。'));
    };
    const timer = setTimeout(() => {
      resolver.cancel();
      stop(new NetworkingAdapterError('DNS_TIMEOUT', 'DNS 检查超时，请稍后重试。', true));
    }, this.timeoutMs);
    timer.unref();
    options.signal?.addEventListener('abort', abort, { once: true });
    const query = async (request: Promise<string[]>): Promise<string[]> => {
      try {
        const values = await Promise.race([request, stopped]);
        if (
          !Array.isArray(values) ||
          values.length > 16 ||
          values.some((value) => typeof value !== 'string' || value.length > 253)
        )
          throw new NetworkingAdapterError('DNS_RESPONSE_INVALID', 'DNS 响应超过允许的范围。');
        return values;
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          negativeCodes.has(String(error.code))
        )
          return [];
        throw error;
      }
    };
    try {
      if (options.signal?.aborted) abort();
      const [ipv4, ipv6, firstAlias] = await Promise.all([
        query(resolver.resolve4(queryName)),
        query(resolver.resolve6(queryName)),
        query(resolver.resolveCname(queryName)),
      ]);
      result.addresses = [...new Set([...ipv4, ...ipv6].map(address))].sort();
      let aliases = firstAlias;
      const visited = new Set([queryName]);
      while (aliases.length) {
        if (aliases.length !== 1 || result.cnameChain.length >= 8)
          throw new NetworkingAdapterError(
            'DNS_CNAME_LIMIT',
            'CNAME 链超过允许的长度或包含冲突记录。',
          );
        const next = name(aliases[0]!);
        if (visited.has(next))
          throw new NetworkingAdapterError('DNS_CNAME_LOOP', '检测到循环 CNAME，请检查 DNS 记录。');
        visited.add(next);
        result.cnameChain.push(next);
        aliases = await query(resolver.resolveCname(next));
      }
      if (!result.addresses.length)
        return finish(
          'not_found',
          'DNS_RECORD_NOT_FOUND',
          '尚未解析到入口地址，请检查记录并等待递归解析器更新。',
        );
      if (
        (result.expectedCname && !result.cnameChain.includes(result.expectedCname)) ||
        (result.expectedAddresses.length &&
          result.addresses.join(',') !== result.expectedAddresses.join(','))
      )
        return finish(
          'mismatch',
          'DNS_ENTRY_MISMATCH',
          '当前 A、AAAA 或 CNAME 与此集群的预期入口不一致。',
        );
      return finish(
        'matched',
        null,
        '当前解析器的 DNS 结果与预期入口匹配；路由与证书仍需独立检查。',
      );
    } catch (error) {
      if (error instanceof NetworkingAdapterError)
        return finish('error', error.code, error.message);
      return finish(
        'error',
        options.signal?.aborted ? 'DNS_CANCELLED' : 'DNS_QUERY_FAILED',
        options.signal?.aborted
          ? 'DNS 检查已取消。'
          : '无法取得完整 DNS 结果，请检查解析器和网络后重试。',
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolver.cancel();
    }
  }
}
