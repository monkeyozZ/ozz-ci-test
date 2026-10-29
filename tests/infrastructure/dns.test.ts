import { describe, expect, it } from 'vitest';
import { Resolver } from 'node:dns/promises';
import {
  NodeDomainDnsInspector,
  type NetworkDnsResolver,
} from '../../packages/infrastructure/src/networking.js';

function resolver(
  values: { v4?: string[]; v6?: string[]; aliases?: Record<string, string[]> } = {},
): NetworkDnsResolver & { cancellations: number } {
  return {
    cancellations: 0,
    resolve4: async () => values.v4 ?? [],
    resolve6: async () => values.v6 ?? [],
    resolveCname: async (name) => values.aliases?.[name] ?? [],
    cancel() {
      this.cancellations++;
    },
  };
}

describe('isolated bounded DNS inspection', () => {
  it('keeps the inherited resolver when the optional server list is empty and overrides it only when configured', async () => {
    for (const servers of [[], ['192.0.2.54:1053']]) {
      const source = Object.assign(new Resolver(), resolver({ v4: ['192.0.2.1'] }));
      source.setServers(['192.0.2.53']);
      const inspector = new NodeDomainDnsInspector({ servers, resolverFactory: () => source });
      expect(
        (await inspector.inspect('app.example.test', { addresses: ['192.0.2.1'], cname: null }))
          .state,
      ).toBe('matched');
      expect(source.getServers()).toEqual(servers.length ? servers : ['192.0.2.53']);
    }
  });
  it('requires all configured address families and reports an unexpected AAAA as a mismatch', async () => {
    const source = resolver({ v4: ['192.0.2.1'], v6: ['2001:db8::2'] });
    const inspector = new NodeDomainDnsInspector({ resolverFactory: () => source });
    const result = await inspector.inspect('app.example.test', {
      addresses: ['192.0.2.1'],
      cname: null,
    });
    expect(result.state).toBe('mismatch');
    expect(result.addresses).toEqual(['192.0.2.1', '2001:db8::2']);
    expect(source.cancellations).toBe(1);
  });
  it('normalizes IPv6 and follows a bounded CNAME chain independently from address results', async () => {
    const source = resolver({
      v6: ['2001:db8:0:0::1'],
      aliases: { 'app.example.test': ['EDGE.EXAMPLE.TEST.'] },
    });
    const result = await new NodeDomainDnsInspector({ resolverFactory: () => source }).inspect(
      'app.example.test',
      { addresses: ['2001:db8::1'], cname: 'edge.example.test' },
    );
    expect(result.state).toBe('matched');
    expect(result.cnameChain).toEqual(['edge.example.test']);
  });
  it('does not claim a CNAME is usable when its target has no address', async () => {
    const source = resolver({ aliases: { 'app.example.test': ['edge.example.test'] } });
    const result = await new NodeDomainDnsInspector({ resolverFactory: () => source }).inspect(
      'app.example.test',
      { addresses: [], cname: 'edge.example.test' },
    );
    expect(result.state).toBe('not_found');
  });
  it('bounds CNAME cycles and never returns raw resolver error contents', async () => {
    const source = resolver({
      v4: ['192.0.2.1'],
      aliases: {
        'app.example.test': ['edge.example.test'],
        'edge.example.test': ['app.example.test'],
      },
    });
    expect(
      (
        await new NodeDomainDnsInspector({ resolverFactory: () => source }).inspect(
          'app.example.test',
          { addresses: ['192.0.2.1'], cname: null },
        )
      ).code,
    ).toBe('DNS_CNAME_LOOP');
    source.resolve4 = async () => {
      throw new Error('RAW-RESOLVER-SECRET');
    };
    const result = await new NodeDomainDnsInspector({ resolverFactory: () => source }).inspect(
      'app.example.test',
      { addresses: ['192.0.2.1'], cname: null },
    );
    expect(result.state).toBe('error');
    expect(JSON.stringify(result)).not.toContain('RAW-RESOLVER-SECRET');
  });
  it('reclaims a hung resolver on deadline and on cancellation', async () => {
    const source = resolver();
    source.resolve4 = () => new Promise(() => {});
    const inspector = new NodeDomainDnsInspector({ resolverFactory: () => source, timeoutMs: 20 });
    expect(
      (await inspector.inspect('app.example.test', { addresses: ['192.0.2.1'], cname: null })).code,
    ).toBe('DNS_TIMEOUT');
    const abort = new AbortController();
    const pending = inspector.inspect(
      'app.example.test',
      { addresses: ['192.0.2.1'], cname: null },
      { signal: abort.signal },
    );
    abort.abort();
    expect((await pending).code).toBe('DNS_CANCELLED');
    expect(source.cancellations).toBe(4);
  });
  it('creates no resolver for an unconfigured entry', async () => {
    let created = 0;
    const result = await new NodeDomainDnsInspector({
      resolverFactory: () => {
        created++;
        return resolver();
      },
    }).inspect('app.example.test', { addresses: [], cname: null });
    expect(result.state).toBe('unconfigured');
    expect(created).toBe(0);
  });
});
