import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createProxyServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as ProxyServer,
} from 'node:http';
import { createServer, type Server } from 'node:https';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  parseImageReference,
  parseRegistryAccess,
  RegistryAdapter,
  RegistryAdapterError,
  registryPullSecretData,
  type ImagePlatform,
  type RegistryAccessInput,
  type RegistryErrorCode,
  type ResolvedImage,
} from '../../packages/infrastructure/dist/registry.js';
import { publicRedirectAddress } from '../../packages/infrastructure/dist/registry/redirects.js';

const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const INDEX = 'application/vnd.oci.image.index.v1+json';
const CONFIG = 'application/vnd.oci.image.config.v1+json';
const arm64: ImagePlatform[] = [{ os: 'linux', architecture: 'arm64' }];
const both: ImagePlatform[] = [...arm64, { os: 'linux', architecture: 'amd64' }];
const directory = mkdtempSync(join(tmpdir(), 'ozz-registry-protocol-'));
const fixtures: Fixture[] = [];
const proxies: { server: ProxyServer; sockets: Set<Socket> }[] = [];
const secretSentinel = 'SYNTHETIC_REGISTRY_PASSWORD_DO_NOT_LOG';
const configSentinel = 'SYNTHETIC_IMAGE_ENV_DO_NOT_RETURN';
let pki: { ca: string; certificate: string; key: string; badSan: string; badKey: string };

function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

interface Artifact {
  body: Buffer;
  digest: string;
  mediaType: string;
}

function artifact(value: unknown, mediaType: string): Artifact {
  const body = Buffer.from(JSON.stringify(value));
  return { body, mediaType, digest: digest(body) };
}

function image(architecture: 'arm64' | 'amd64' = 'arm64', variant?: string) {
  const config = artifact(
    {
      architecture,
      os: 'linux',
      ...(variant ? { variant } : {}),
      rootfs: { type: 'layers', diff_ids: [] },
      config: { Env: [configSentinel] },
    },
    CONFIG,
  );
  const manifest = artifact(
    {
      schemaVersion: 2,
      mediaType: MANIFEST,
      config: { mediaType: config.mediaType, digest: config.digest, size: config.body.length },
      layers: [],
    },
    MANIFEST,
  );
  return { config, manifest, architecture, variant };
}

function imageIndex(images: ReturnType<typeof image>[]) {
  return artifact(
    {
      schemaVersion: 2,
      mediaType: INDEX,
      manifests: images.map((value) => ({
        mediaType: value.manifest.mediaType,
        digest: value.manifest.digest,
        size: value.manifest.body.length,
        platform: {
          os: 'linux',
          architecture: value.architecture,
          ...(value.variant ? { variant: value.variant } : {}),
        },
      })),
    },
    INDEX,
  );
}

interface Fixture {
  server: Server;
  origin: string;
  registry: string;
  sockets: Set<Socket>;
  paths: { path: string; authorization?: string; scope: string | null }[];
  manifests: Map<string, Artifact>;
  blobs: Map<string, Artifact>;
  auth: 'none' | 'basic' | 'bearer';
  tokenRequiresBasic: boolean;
  token: string;
  challenge?: string;
  override?: (request: IncomingMessage, response: ServerResponse, url: URL) => boolean;
}

function send(response: ServerResponse, value: Artifact) {
  response.writeHead(200, {
    'Content-Type': value.mediaType,
    'Docker-Content-Digest': value.digest,
    'Content-Length': value.body.length,
  });
  response.end(value.body);
}

async function fixture(auth: Fixture['auth'] = 'none', badSan = false): Promise<Fixture> {
  const state = {
    origin: '',
    registry: '',
    sockets: new Set<Socket>(),
    paths: [],
    manifests: new Map<string, Artifact>(),
    blobs: new Map<string, Artifact>(),
    auth,
    tokenRequiresBasic: auth === 'bearer',
    token: 'synthetic-registry-pull-token',
  } as unknown as Fixture;
  const basic = `Basic ${Buffer.from(`test-reader:${secretSentinel}`).toString('base64')}`;
  state.server = createServer(
    { key: badSan ? pki.badKey : pki.key, cert: badSan ? pki.badSan : pki.certificate },
    (request, response) => {
      const url = new URL(request.url!, state.origin);
      state.paths.push({
        path: url.pathname,
        authorization: request.headers.authorization,
        scope: url.searchParams.get('scope'),
      });
      if (state.override?.(request, response, url)) return;
      if (url.pathname === '/token') {
        if (state.tokenRequiresBasic && request.headers.authorization !== basic) {
          response.writeHead(401).end(secretSentinel);
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ token: state.token, expires_in: 300 }));
        return;
      }
      const expected = state.auth === 'basic' ? basic : `Bearer ${state.token}`;
      if (state.auth !== 'none' && request.headers.authorization !== expected) {
        const challenge =
          state.challenge ??
          (state.auth === 'basic'
            ? 'Basic realm="restricted, image registry"'
            : `Bearer realm="${state.origin}/token",service="registry",scope="repository:demo/app:pull,push"`);
        response.writeHead(401, { 'WWW-Authenticate': challenge }).end(secretSentinel);
        return;
      }
      const manifest = /^\/v2\/demo\/app\/manifests\/(.+)$/u.exec(url.pathname);
      const blob = /^\/v2\/demo\/app\/blobs\/(.+)$/u.exec(url.pathname);
      const value = manifest
        ? state.manifests.get(decodeURIComponent(manifest[1]!))
        : blob
          ? state.blobs.get(decodeURIComponent(blob[1]!))
          : undefined;
      if (value) send(response, value);
      else response.writeHead(404).end(secretSentinel);
    },
  );
  state.server.on('connection', (socket: Socket) => {
    state.sockets.add(socket);
    socket.once('close', () => state.sockets.delete(socket));
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  state.registry = `127.0.0.1:${(state.server.address() as AddressInfo).port}`;
  state.origin = `https://${state.registry}`;
  fixtures.push(state);
  return state;
}

function addImage(target: Fixture, value = image(), tag = 'latest') {
  target.blobs.set(value.config.digest, value.config);
  target.manifests.set(value.manifest.digest, value.manifest);
  target.manifests.set(tag, value.manifest);
  return value;
}

function access(target: Fixture, extra: Partial<RegistryAccessInput> = {}) {
  return parseRegistryAccess({
    registry: target.registry,
    caCertificate: pki.ca,
    ...(target.auth !== 'none' ? { username: 'test-reader', password: secretSentinel } : {}),
    ...extra,
  });
}

async function proxy(targets: Fixture[]) {
  const requests: { authority: string; authorization: string | undefined }[] = [];
  const sockets = new Set<Socket>();
  const server = createProxyServer((_request, response) => response.writeHead(405).end());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('connect', (request, client, head) => {
    requests.push({ authority: request.url ?? '', authorization: request.headers.authorization });
    const target = targets.find((entry) => entry.registry === request.url);
    if (!target) {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const remote = connect(Number(new URL(target.origin).port), '127.0.0.1');
    sockets.add(remote);
    remote.on('close', () => sockets.delete(remote));
    remote.on('error', () => client.destroy());
    client.on('error', () => remote.destroy());
    client.on('close', () => remote.destroy());
    remote.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote).pipe(client);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxies.push({ server, sockets });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function failure(promise: Promise<unknown>, code: RegistryErrorCode) {
  const error = await promise.then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(RegistryAdapterError);
  expect(error).toMatchObject({ code });
  expect(JSON.stringify(error)).not.toContain(secretSentinel);
  expect(String(error)).not.toContain(secretSentinel);
  return error as RegistryAdapterError;
}

beforeAll(() => {
  const run = (args: string[]) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=ozz-registry-test-ca',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  const issue = (name: string, san: string) => {
    writeFileSync(
      join(directory, `${name}.ext`),
      `basicConstraints=CA:FALSE\nsubjectAltName=${san}\nextendedKeyUsage=serverAuth\n`,
      { mode: 0o600 },
    );
    run([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=ozz-registry-test-${name}`,
    ]);
    run([
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.pem`,
      '-days',
      '1',
      '-extfile',
      `${name}.ext`,
    ]);
  };
  issue('server', 'IP:127.0.0.1,DNS:localhost');
  issue('bad-san', 'DNS:not-this-registry.invalid');
  const read = (name: string) => readFileSync(join(directory, name), 'utf8');
  pki = {
    ca: read('ca.pem'),
    certificate: read('server.pem'),
    key: read('server.key'),
    badSan: read('bad-san.pem'),
    badKey: read('bad-san.key'),
  };
});

afterEach(async () => {
  for (const value of proxies.splice(0)) {
    for (const socket of value.sockets) socket.destroy();
    await new Promise<void>((resolve) => value.server.close(() => resolve()));
  }
  for (const target of fixtures.splice(0)) {
    for (const socket of target.sockets) socket.destroy();
    await new Promise<void>((resolve) => target.server.close(() => resolve()));
  }
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('OCI Registry Adapter with real HTTPS protocol services', () => {
  it('routes an authenticated registry through an explicit CONNECT proxy while keeping auth inside TLS', async () => {
    const target = await fixture('bearer');
    const asset = addImage(target);
    const transport = await proxy([target]);
    const result = await new RegistryAdapter({ httpProxy: transport.origin }).resolve(
      `${target.registry}/demo/app:latest`,
      { platforms: arm64, access: access(target) },
    );
    expect(result.manifestDigest).toBe(asset.manifest.digest);
    expect(transport.requests.length).toBeGreaterThan(0);
    expect(
      transport.requests.every(
        (request) => request.authority === target.registry && request.authorization === undefined,
      ),
    ).toBe(true);
    expect(target.paths.some((request) => request.path === '/token')).toBe(true);
  });

  it('requires an exact explicit blob origin for private redirects through the proxy and never forwards registry auth', async () => {
    const target = await fixture('bearer');
    const cdn = await fixture();
    const asset = image();
    addImage(target, asset);
    addImage(cdn, asset);
    target.override = (request, response, url) => {
      if (!url.pathname.includes('/blobs/')) return false;
      response
        .writeHead(307, { Location: `${cdn.origin}${url.pathname}?signature=synthetic-token` })
        .end();
      return true;
    };
    const transport = await proxy([target, cdn]);
    await failure(
      new RegistryAdapter({ httpProxy: transport.origin }).resolve(
        `${target.registry}/demo/app:latest`,
        { platforms: arm64, access: access(target) },
      ),
      'REGISTRY_REDIRECT_REJECTED',
    );
    expect(cdn.paths).toHaveLength(0);
    const result = await new RegistryAdapter({
      httpProxy: transport.origin,
      proxyBlobOrigins: [cdn.origin],
    }).resolve(`${target.registry}/demo/app:latest`, { platforms: arm64, access: access(target) });
    expect(result.manifestDigest).toBe(asset.manifest.digest);
    expect(transport.requests.some((request) => request.authority === cdn.registry)).toBe(true);
    expect(cdn.paths.length).toBeGreaterThan(0);
    expect(cdn.paths.every((request) => request.authorization === undefined)).toBe(true);
  });

  it('retains certificate validation inside an explicit registry proxy tunnel', async () => {
    const target = await fixture('none', true);
    addImage(target);
    const transport = await proxy([target]);
    await failure(
      new RegistryAdapter({ httpProxy: transport.origin }).resolve(
        `${target.registry}/demo/app:latest`,
        { platforms: arm64, access: access(target) },
      ),
      'REGISTRY_TLS_INVALID',
    );
    expect(transport.requests).toHaveLength(1);
  });

  it('allows public IPv4/IPv6 while excluding private, mapped, multicast and metadata addresses', () => {
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(publicRedirectAddress(address), address).toBe(true);
    }
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '224.0.0.1',
      '::',
      '::1',
      '::ffff:169.254.169.254',
      'fc00::1',
      'fe80::1',
      'ff02::1',
    ]) {
      expect(publicRedirectAddress(address), address).toBe(false);
    }
  });

  it('normalizes Docker Hub and private references while rejecting unsafe or ambiguous input', () => {
    expect(parseImageReference('nginx:1.27')).toMatchObject({
      registry: 'docker.io',
      repository: 'library/nginx',
      reference: '1.27',
      apiOrigin: 'https://registry-1.docker.io',
    });
    expect(parseImageReference('index.docker.io/team/web')).toMatchObject({
      registry: 'docker.io',
      repository: 'team/web',
      reference: 'latest',
    });
    const immutable = `sha256:${'a'.repeat(64)}`;
    expect(parseImageReference(`localhost:5443/demo/app:stable@${immutable}`)).toMatchObject({
      registry: 'localhost:5443',
      tag: 'stable',
      digest: immutable,
      reference: immutable,
    });
    expect(parseImageReference(`[::1]:5443/demo/app@${immutable}`).registry).toBe('[::1]:5443');
    for (const value of [
      'https://registry.example/image',
      'registry.example/../image',
      'image@sha256:abc',
      'image:bad tag',
      'Uppercase',
      'registry.example/image?secret=x',
      'registry.example/image#fragment',
      'image@@bad',
      'registry.example:0/image',
      'registry.example:65536/image',
    ]) {
      expect(() => parseImageReference(value)).toThrow(RegistryAdapterError);
    }
  });

  it('keeps access handles secret-free and exposes pull credentials only through the explicit helper', async () => {
    const target = await fixture('basic');
    const credentials = access(target);
    expect(JSON.stringify(credentials)).not.toContain(secretSentinel);
    expect(Object.keys(credentials).sort()).toEqual([
      'authentication',
      'caFingerprint',
      'registry',
    ]);
    const secret = registryPullSecretData(credentials)!;
    const content = JSON.parse(Buffer.from(secret['.dockerconfigjson'], 'base64').toString('utf8'));
    expect(content.auths[target.registry].password).toBe(secretSentinel);
    expect(
      registryPullSecretData(access(target, { username: undefined, password: undefined })),
    ).toBeNull();
    for (const invalid of [
      { registry: target.registry, username: 'user' },
      { registry: target.registry, skipTLSVerify: true },
      { registry: target.registry, caFile: '/etc/ssl/private.pem' },
      { registry: target.registry, tokenServiceOrigins: ['http://token.invalid'] },
    ]) {
      expect(() => parseRegistryAccess(invalid)).toThrow(RegistryAdapterError);
    }
    const other = await fixture();
    await failure(
      new RegistryAdapter().resolve(`${other.registry}/demo/app`, {
        platforms: arm64,
        access: credentials,
      }),
      'REGISTRY_ACCESS_MISMATCH',
    );
    expect(other.paths).toHaveLength(0);
  });

  it('reads a real TLS manifest and config, returns immutable identity, and omits config environment', async () => {
    const target = await fixture();
    const stored = addImage(target);
    const result = await new RegistryAdapter().resolve(`${target.registry}/demo/app:latest`, {
      platforms: arm64,
      access: access(target),
    });
    expect(result).toMatchObject({
      manifestDigest: stored.manifest.digest,
      manifestMediaType: MANIFEST,
      indexDigest: null,
      deployReference: `${target.registry}/demo/app@${stored.manifest.digest}`,
      platformManifests: [
        {
          architecture: 'arm64',
          manifestDigest: stored.manifest.digest,
          configDigest: stored.config.digest,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(configSentinel);
    expect(target.paths).toHaveLength(2);
    expect(target.paths.every((request) => request.authorization === undefined)).toBe(true);
  });

  it('pins the multi-platform index while checking both actual config architectures', async () => {
    const target = await fixture();
    const images = [addImage(target, image('arm64')), addImage(target, image('amd64'), 'amd64')];
    const index = imageIndex(images);
    target.manifests.set('latest', index);
    target.manifests.set(index.digest, index);
    const result = await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: both,
      access: access(target),
    });
    expect(result.indexDigest).toBe(index.digest);
    expect(result.deployReference).toBe(`${target.registry}/demo/app@${index.digest}`);
    expect(result.platformManifests.map((value) => value.architecture)).toEqual(['amd64', 'arm64']);
    expect(new Set(result.platformManifests.map((value) => value.manifestDigest)).size).toBe(2);
    expect(target.paths.filter((value) => value.path.includes('/blobs/'))).toHaveLength(2);
  });

  it('accepts Docker v2 manifests and manifest lists with Docker image config media types', async () => {
    const target = await fixture();
    const dockerManifest = 'application/vnd.docker.distribution.manifest.v2+json';
    const dockerIndex = 'application/vnd.docker.distribution.manifest.list.v2+json';
    const stored = image();
    const content = JSON.parse(stored.manifest.body.toString());
    content.mediaType = dockerManifest;
    content.config.mediaType = 'application/vnd.docker.container.image.v1+json';
    const manifest = artifact(content, dockerManifest);
    addImage(target, { ...stored, manifest });
    const single = await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
    });
    expect(single.manifestMediaType).toBe(dockerManifest);
    const list = artifact(
      {
        schemaVersion: 2,
        mediaType: dockerIndex,
        manifests: [
          {
            mediaType: dockerManifest,
            digest: manifest.digest,
            size: manifest.body.length,
            platform: { os: 'linux', architecture: 'arm64' },
          },
        ],
      },
      dockerIndex,
    );
    target.manifests.set('latest', list);
    const indexed = await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
    });
    expect(indexed.manifestMediaType).toBe(dockerIndex);
    expect(indexed.platformManifests[0]?.manifestMediaType).toBe(dockerManifest);
  });

  it('rejects a forged platform descriptor whose actual image config is another architecture', async () => {
    const target = await fixture();
    const stored = addImage(target, image('amd64'));
    const wrongIndex = imageIndex([{ ...stored, architecture: 'arm64' }]);
    target.manifests.set('latest', wrongIndex);
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_PLATFORM_MISMATCH',
    );
  });

  it('does not silently select a newer ISA variant for a baseline node', async () => {
    const target = await fixture();
    const newer = addImage(target, image('arm64', 'v9'));
    target.manifests.set('latest', imageIndex([newer]));
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_PLATFORM_UNSUPPORTED',
    );
    const result = await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: [{ os: 'linux', architecture: 'arm64', variant: 'v9' }],
      access: access(target),
    });
    expect(result.platformManifests[0]?.variant).toBe('v9');
  });

  it('supports nested OCI indexes and rejects ambiguous platform candidates', async () => {
    const target = await fixture();
    const stored = addImage(target);
    const nested = imageIndex([stored]);
    target.manifests.set(nested.digest, nested);
    const outer = artifact(
      {
        schemaVersion: 2,
        mediaType: INDEX,
        manifests: [{ mediaType: INDEX, digest: nested.digest, size: nested.body.length }],
      },
      INDEX,
    );
    target.manifests.set('latest', outer);
    const result = await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
    });
    expect(result.indexDigest).toBe(outer.digest);
    const second = image('arm64');
    const secondConfig = artifact(
      { ...JSON.parse(second.config.body.toString()), config: { Env: ['different'] } },
      CONFIG,
    );
    const secondManifest = artifact(
      {
        ...JSON.parse(second.manifest.body.toString()),
        config: { mediaType: CONFIG, digest: secondConfig.digest, size: secondConfig.body.length },
      },
      MANIFEST,
    );
    addImage(target, { ...second, manifest: secondManifest, config: secondConfig }, 'second');
    target.manifests.set(
      'latest',
      imageIndex([stored, { ...second, manifest: secondManifest, config: secondConfig }]),
    );
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_PLATFORM_AMBIGUOUS',
    );
  });

  it('checks response digest headers, requested digest bytes, config bytes and descriptor size', async () => {
    const target = await fixture();
    const stored = addImage(target);
    target.manifests.set('latest', { ...stored.manifest, digest: `sha256:${'f'.repeat(64)}` });
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_DIGEST_MISMATCH',
    );
    target.manifests.set(`sha256:${'e'.repeat(64)}`, stored.manifest);
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app@sha256:${'e'.repeat(64)}`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_DIGEST_MISMATCH',
    );
    target.manifests.set('latest', stored.manifest);
    target.blobs.set(stored.config.digest, { ...stored.config, body: Buffer.from('{}') });
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_DIGEST_MISMATCH',
    );
    target.blobs.set(stored.config.digest, stored.config);
    const content = JSON.parse(stored.manifest.body.toString());
    content.config.size += 1;
    target.manifests.set('latest', artifact(content, MANIFEST));
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_DIGEST_MISMATCH',
    );
  });

  it('rejects legacy manifests, malformed JSON and non-image configs without exposing body content', async () => {
    const target = await fixture();
    const stored = addImage(target);
    target.manifests.set(
      'latest',
      artifact({ secretSentinel }, 'application/vnd.docker.distribution.manifest.v1+json'),
    );
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_MANIFEST_UNSUPPORTED',
    );
    const invalid = Buffer.from(`{${secretSentinel}`);
    target.manifests.set('latest', { body: invalid, digest: digest(invalid), mediaType: MANIFEST });
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_INVALID_RESPONSE',
    );
    const content = JSON.parse(stored.manifest.body.toString());
    content.config.mediaType = 'application/vnd.oci.empty.v1+json';
    target.manifests.set('latest', artifact(content, MANIFEST));
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_MANIFEST_UNSUPPORTED',
    );
  });

  it('uses Basic credentials only after the registry challenge and distinguishes missing or invalid auth', async () => {
    const target = await fixture('basic');
    addImage(target);
    await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
    });
    expect(target.paths[0]?.authorization).toBeUndefined();
    expect(target.paths[1]?.authorization?.startsWith('Basic ')).toBe(true);
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target, { username: undefined, password: undefined }),
      }),
      'REGISTRY_AUTH_REQUIRED',
    );
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target, { password: 'wrong-synthetic-password' }),
      }),
      'REGISTRY_UNAUTHENTICATED',
    );
  });

  it('handles Bearer challenges using only repository pull scope and never returns the token', async () => {
    const target = await fixture('bearer');
    addImage(target);
    const result = await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
    });
    expect(target.paths.find((value) => value.path === '/token')?.scope).toBe(
      'repository:demo/app:pull',
    );
    expect(JSON.stringify(result)).not.toContain(target.token);
    expect(target.paths.at(-1)?.authorization).toBe(`Bearer ${target.token}`);
    target.tokenRequiresBasic = false;
    await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target, { username: undefined, password: undefined }),
    });
  });

  it('rejects untrusted token origins before contacting them and permits explicit token trust', async () => {
    const target = await fixture('bearer');
    const tokenService = await fixture();
    addImage(target);
    tokenService.tokenRequiresBasic = true;
    target.challenge = `Bearer realm="${tokenService.origin}/token",service="registry"`;
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_TOKEN_ORIGIN_REJECTED',
    );
    expect(tokenService.paths).toHaveLength(0);
    await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target, { tokenServiceOrigins: [tokenService.origin] }),
    });
    expect(tokenService.paths).toHaveLength(1);
    expect(tokenService.paths[0]?.authorization?.startsWith('Basic ')).toBe(true);
  });

  it('rejects token and manifest redirects without forwarding any authentication', async () => {
    const target = await fixture('bearer');
    const destination = await fixture();
    addImage(target);
    target.override = (_request, response, url) => {
      if (url.pathname !== '/token') return false;
      response.writeHead(302, { Location: `${destination.origin}/token` }).end();
      return true;
    };
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target, { tokenServiceOrigins: [destination.origin] }),
      }),
      'REGISTRY_REDIRECT_REJECTED',
    );
    expect(destination.paths).toHaveLength(0);
    target.auth = 'none';
    target.override = (_request, response) => {
      response
        .writeHead(307, { Location: `${destination.origin}/v2/demo/app/manifests/latest` })
        .end();
      return true;
    };
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_REDIRECT_REJECTED',
    );
    expect(destination.paths).toHaveLength(0);
  });

  it('allows explicitly trusted config-blob redirects with no credentials and verifies the returned digest', async () => {
    const target = await fixture('basic');
    const destination = await fixture();
    const stored = addImage(target);
    destination.blobs.set(stored.config.digest, stored.config);
    target.override = (_request, response, url) => {
      if (!url.pathname.includes('/blobs/')) return false;
      response
        .writeHead(307, { Location: `${destination.origin}${url.pathname}?signed=synthetic` })
        .end();
      return true;
    };
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_REDIRECT_REJECTED',
    );
    expect(destination.paths).toHaveLength(0);
    target.override = (_request, response, url) => {
      if (!url.pathname.includes('/blobs/')) return false;
      response
        .writeHead(307, {
          Location: `${destination.origin.replace('127.0.0.1', 'localhost')}${url.pathname}`,
        })
        .end();
      return true;
    };
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_REDIRECT_REJECTED',
    );
    expect(destination.paths).toHaveLength(0);
    target.override = (_request, response, url) => {
      if (!url.pathname.includes('/blobs/')) return false;
      response
        .writeHead(307, { Location: `${destination.origin}/objects/config?temporary=synthetic` })
        .end();
      return true;
    };
    destination.override = (_request, response, url) => {
      if (url.pathname !== '/objects/config') return false;
      if (!url.searchParams.has('final')) response.writeHead(307, { Location: '?final=1' }).end();
      else send(response, destination.blobs.get(stored.config.digest)!);
      return true;
    };
    await new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target, { blobServiceOrigins: [destination.origin] }),
    });
    expect(destination.paths).toHaveLength(2);
    expect(destination.paths.every((value) => value.authorization === undefined)).toBe(true);
    const wrong = Buffer.from('{}');
    destination.blobs.set(stored.config.digest, {
      body: wrong,
      mediaType: CONFIG,
      digest: digest(wrong),
    });
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target, { blobServiceOrigins: [destination.origin] }),
      }),
      'REGISTRY_DIGEST_MISMATCH',
    );
  });

  it('validates both CA trust and SAN and refuses credentials on an invalid TLS peer', async () => {
    const target = await fixture('basic');
    addImage(target);
    await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: parseRegistryAccess({
          registry: target.registry,
          username: 'test-reader',
          password: secretSentinel,
        }),
      }),
      'REGISTRY_TLS_INVALID',
    );
    expect(target.paths).toHaveLength(0);
    const wrong = await fixture('basic', true);
    addImage(wrong);
    await failure(
      new RegistryAdapter().resolve(`${wrong.registry}/demo/app`, {
        platforms: arm64,
        access: access(wrong),
      }),
      'REGISTRY_TLS_INVALID',
    );
    expect(wrong.paths).toHaveLength(0);
  });

  it.each([
    [403, 'REGISTRY_FORBIDDEN', false],
    [404, 'REGISTRY_IMAGE_NOT_FOUND', false],
    [429, 'REGISTRY_RATE_LIMITED', true],
    [503, 'REGISTRY_UNAVAILABLE', true],
  ] as const)('maps HTTP %i to a bounded safe error', async (status, code, retryable) => {
    const target = await fixture();
    target.override = (_request, response) => {
      response.writeHead(status, { 'Retry-After': '7200' }).end(secretSentinel);
      return true;
    };
    const error = await failure(
      new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      code,
    );
    expect(error.retryable).toBe(retryable);
    expect(error.httpStatus).toBe(status);
    expect(error.retryAfterMs).toBe(120_000);
  });

  it('owns and closes timed-out or cancelled sockets', async () => {
    const target = await fixture();
    target.override = () => true;
    await failure(
      new RegistryAdapter({ requestTimeoutMs: 80 }).resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_TIMEOUT',
    );
    const controller = new AbortController();
    const pending = new RegistryAdapter().resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
      signal: controller.signal,
    });
    await delay(30);
    controller.abort();
    await failure(pending, 'REGISTRY_CANCELLED');
    await delay(30);
    expect(target.sockets.size).toBe(0);
  });

  it('applies a total resolution deadline across individually timely requests', async () => {
    const target = await fixture();
    const stored = addImage(target);
    target.override = (_request, response, url) => {
      setTimeout(() => {
        if (!response.destroyed)
          send(response, url.pathname.includes('/blobs/') ? stored.config : stored.manifest);
      }, 75);
      return true;
    };
    await failure(
      new RegistryAdapter({ requestTimeoutMs: 300, resolutionTimeoutMs: 120 }).resolve(
        `${target.registry}/demo/app`,
        {
          platforms: arm64,
          access: access(target),
        },
      ),
      'REGISTRY_TIMEOUT',
    );
    expect(target.paths.length).toBe(2);
  });

  it('bounds content length, streamed bodies, aggregate bytes and request counts', async () => {
    const target = await fixture();
    addImage(target);
    target.override = (_request, response) => {
      response
        .writeHead(200, { 'Content-Type': MANIFEST, 'Content-Length': 4096 })
        .end('x'.repeat(4096));
      return true;
    };
    await failure(
      new RegistryAdapter({ maxResponseBytes: 1024 }).resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_RESPONSE_TOO_LARGE',
    );
    target.override = (_request, response) => {
      response.writeHead(200, { 'Content-Type': MANIFEST });
      response.write('x'.repeat(900));
      response.end('x'.repeat(900));
      return true;
    };
    await failure(
      new RegistryAdapter({ maxResponseBytes: 1024 }).resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_RESPONSE_TOO_LARGE',
    );
    target.override = undefined;
    const stored = image();
    const rawConfig = JSON.parse(stored.config.body.toString());
    rawConfig.config.Env.push('x'.repeat(700));
    const largeConfig = artifact(rawConfig, CONFIG);
    const largeManifest = artifact(
      {
        ...JSON.parse(stored.manifest.body.toString()),
        config: { mediaType: CONFIG, digest: largeConfig.digest, size: largeConfig.body.length },
      },
      MANIFEST,
    );
    addImage(target, { ...stored, manifest: largeManifest, config: largeConfig });
    await failure(
      new RegistryAdapter({ maxResolutionBytes: 1024 }).resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_RESPONSE_TOO_LARGE',
    );
    await failure(
      new RegistryAdapter({ maxRequests: 1 }).resolve(`${target.registry}/demo/app`, {
        platforms: arm64,
        access: access(target),
      }),
      'REGISTRY_REQUEST_LIMIT',
    );
  });

  it('re-verifies the stored digest after tag movement and fails if that artifact was deleted', async () => {
    const target = await fixture();
    const stored = addImage(target);
    const adapter = new RegistryAdapter();
    const resolved = await adapter.resolve(`${target.registry}/demo/app:latest`, {
      platforms: arm64,
      access: access(target),
    });
    target.manifests.set('latest', image('amd64').manifest);
    target.paths.length = 0;
    const verified = await adapter.verify(resolved, { platforms: arm64, access: access(target) });
    expect(verified.manifestDigest).toBe(stored.manifest.digest);
    expect(verified.inputReference).toBe(resolved.inputReference);
    expect(verified.verifiedAt).toBeTruthy();
    expect(target.paths.some((value) => value.path.endsWith('/latest'))).toBe(false);
    target.manifests.delete(stored.manifest.digest);
    await failure(
      adapter.verify(resolved, { platforms: arm64, access: access(target) }),
      'REGISTRY_IMAGE_NOT_FOUND',
    );
    expect(target.paths.some((value) => value.path.endsWith('/latest'))).toBe(false);
  });

  it('rejects corrupted stored image metadata before making any request', async () => {
    const target = await fixture();
    addImage(target);
    const adapter = new RegistryAdapter();
    const resolved = await adapter.resolve(`${target.registry}/demo/app`, {
      platforms: arm64,
      access: access(target),
    });
    target.paths.length = 0;
    await failure(
      adapter.verify(
        { ...resolved, deployReference: `${target.registry}/demo/app:latest` } as ResolvedImage,
        { platforms: arm64, access: access(target) },
      ),
      'REGISTRY_SNAPSHOT_INVALID',
    );
    expect(target.paths).toHaveLength(0);
  });
});
