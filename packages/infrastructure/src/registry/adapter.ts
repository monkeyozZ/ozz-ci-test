import { createHash } from 'node:crypto';
import { accessMaterial } from './access.js';
import {
  registryIndexMediaTypes,
  registryManifestMediaTypes,
  RegistryAdapterError,
  type ImagePlatform,
  type ParsedImageReference,
  type RegistryAdapterOptions,
  type RegistryImageResolver,
  type RegistryManifestMediaType,
  type RegistryMediaType,
  type RegistryResolveOptions,
  type ResolvedImage,
  type ResolvedImagePlatform,
} from './contracts.js';
import {
  baselineVariant,
  parseImageReference,
  platforms,
  samePlatform,
  SHA256,
} from './reference.js';
import {
  contentType,
  registryLimits,
  RegistrySession,
  responseJson,
  type RegistryHttpResponse,
  type RegistryLimits,
} from './transport.js';

const acceptedMedia = [...registryManifestMediaTypes, ...registryIndexMediaTypes];
const acceptedConfigs = [
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json',
];

interface Descriptor {
  digest: string;
  size: number;
  mediaType: string;
  platform?: Record<string, unknown>;
}

interface ManifestDocument {
  digest: string;
  mediaType: RegistryMediaType;
  size: number;
  content: Record<string, unknown>;
}

interface ImageConfiguration {
  os: string;
  architecture: string;
  variant?: string;
  layers: number;
  size: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function descriptor(value: unknown): Descriptor {
  const raw = record(value);
  if (
    typeof raw.digest !== 'string' ||
    !SHA256.test(raw.digest) ||
    typeof raw.size !== 'number' ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 0 ||
    typeof raw.mediaType !== 'string' ||
    raw.mediaType.length > 200
  )
    throw new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
  return {
    digest: raw.digest,
    size: raw.size,
    mediaType: raw.mediaType,
    ...(raw.platform !== undefined ? { platform: record(raw.platform) } : {}),
  };
}

function index(document: ManifestDocument): boolean {
  return (registryIndexMediaTypes as readonly string[]).includes(document.mediaType);
}

function verifyBytes(response: RegistryHttpResponse, expected?: Descriptor | string): string {
  const digest = `sha256:${createHash('sha256').update(response.body).digest('hex')}`;
  const asserted = response.headers['docker-content-digest'];
  if (
    (asserted !== undefined && asserted !== digest) ||
    (typeof expected === 'string' && expected !== digest) ||
    (typeof expected === 'object' &&
      (expected.digest !== digest || expected.size !== response.body.length))
  )
    throw new RegistryAdapterError('REGISTRY_DIGEST_MISMATCH');
  return digest;
}

function platformKey(value: ImagePlatform): string {
  return `${value.os}/${value.architecture}/${baselineVariant(value)}`;
}

class Resolution {
  private readonly documents = new Map<string, ManifestDocument>();
  private readonly configurations = new Map<string, ImageConfiguration>();
  private descriptors = 0;

  constructor(private readonly session: RegistrySession) {}

  private async manifest(reference: string, expected?: Descriptor): Promise<ManifestDocument> {
    const cached = this.documents.get(reference);
    if (cached) {
      if (expected && (cached.mediaType !== expected.mediaType || cached.size !== expected.size))
        throw new RegistryAdapterError('REGISTRY_DIGEST_MISMATCH');
      return cached;
    }
    if (expected && expected.size > this.session.limits.maxResponseBytes)
      throw new RegistryAdapterError('REGISTRY_RESPONSE_TOO_LARGE');
    const response = await this.session.manifest(reference, acceptedMedia.join(', '));
    const digest = verifyBytes(
      response,
      expected ?? (SHA256.test(reference) ? reference : undefined),
    );
    const mediaType = contentType(response);
    if (!(acceptedMedia as readonly string[]).includes(mediaType))
      throw new RegistryAdapterError('REGISTRY_MANIFEST_UNSUPPORTED');
    const content = responseJson(response);
    if (
      content.schemaVersion !== 2 ||
      (content.mediaType !== undefined && content.mediaType !== mediaType) ||
      (expected && expected.mediaType !== mediaType)
    )
      throw new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
    const document: ManifestDocument = {
      digest,
      mediaType: mediaType as RegistryMediaType,
      size: response.body.length,
      content,
    };
    if (index(document)) {
      if (!Array.isArray(content.manifests) || !content.manifests.length)
        throw new RegistryAdapterError('REGISTRY_MANIFEST_UNSUPPORTED');
      this.descriptors += content.manifests.length;
      if (this.descriptors > this.session.limits.maxDescriptors)
        throw new RegistryAdapterError('REGISTRY_REQUEST_LIMIT');
    }
    this.documents.set(digest, document);
    return document;
  }

  private async configuration(document: ManifestDocument): Promise<{
    descriptor: Descriptor;
    value: ImageConfiguration;
  }> {
    const config = descriptor(document.content.config);
    if (!acceptedConfigs.includes(config.mediaType) || document.content.artifactType !== undefined)
      throw new RegistryAdapterError('REGISTRY_MANIFEST_UNSUPPORTED');
    const layers = document.content.layers;
    if (!Array.isArray(layers) || layers.length > 2048)
      throw new RegistryAdapterError('REGISTRY_MANIFEST_UNSUPPORTED');
    for (const layer of layers) descriptor(layer);
    const cached = this.configurations.get(config.digest);
    if (cached) {
      if (cached.size !== config.size) throw new RegistryAdapterError('REGISTRY_DIGEST_MISMATCH');
      if (cached.layers !== layers.length)
        throw new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
      return { descriptor: config, value: cached };
    }
    if (config.size > this.session.limits.maxResponseBytes)
      throw new RegistryAdapterError('REGISTRY_RESPONSE_TOO_LARGE');
    const response = await this.session.blob(config.digest);
    verifyBytes(response, config);
    const value = responseJson(response);
    const rootfs = record(value.rootfs);
    if (
      typeof value.os !== 'string' ||
      typeof value.architecture !== 'string' ||
      value.os.length > 64 ||
      value.architecture.length > 64 ||
      (value.variant !== undefined &&
        (typeof value.variant !== 'string' || !/^v[1-9][0-9]?$/u.test(value.variant))) ||
      rootfs.type !== 'layers' ||
      !Array.isArray(rootfs.diff_ids) ||
      rootfs.diff_ids.length !== layers.length ||
      rootfs.diff_ids.some((digest) => typeof digest !== 'string' || !SHA256.test(digest))
    )
      throw new RegistryAdapterError('REGISTRY_MANIFEST_UNSUPPORTED');
    const result: ImageConfiguration = {
      os: value.os,
      architecture: value.architecture,
      layers: layers.length,
      size: response.body.length,
      ...(typeof value.variant === 'string' ? { variant: value.variant } : {}),
    };
    this.configurations.set(config.digest, result);
    return { descriptor: config, value: result };
  }

  private async select(
    document: ManifestDocument,
    target: ImagePlatform,
    depth = 0,
    platformAsserted = false,
  ): Promise<ResolvedImagePlatform | null> {
    if (depth > 4) throw new RegistryAdapterError('REGISTRY_REQUEST_LIMIT');
    if (!index(document)) {
      const configuration = await this.configuration(document);
      if (!samePlatform(configuration.value, target)) {
        if (platformAsserted) throw new RegistryAdapterError('REGISTRY_PLATFORM_MISMATCH');
        return null;
      }
      return {
        os: 'linux',
        architecture: target.architecture,
        ...(configuration.value.variant ? { variant: configuration.value.variant } : {}),
        manifestDigest: document.digest,
        manifestMediaType: document.mediaType as RegistryManifestMediaType,
        configDigest: configuration.descriptor.digest,
      };
    }
    const matches = new Map<string, ResolvedImagePlatform>();
    for (const raw of document.content.manifests as unknown[]) {
      const child = descriptor(raw);
      if (child.platform && !samePlatform(child.platform, target)) continue;
      if (!(acceptedMedia as readonly string[]).includes(child.mediaType)) {
        if (child.platform) throw new RegistryAdapterError('REGISTRY_MANIFEST_UNSUPPORTED');
        continue;
      }
      if (
        child.platform &&
        ((Array.isArray(child.platform['os.features']) &&
          child.platform['os.features'].length > 0) ||
          child.platform['os.version'] !== undefined)
      )
        throw new RegistryAdapterError('REGISTRY_PLATFORM_UNSUPPORTED');
      const candidate = await this.manifest(child.digest, child);
      let selected: ResolvedImagePlatform | null;
      try {
        selected = await this.select(candidate, target, depth + 1, Boolean(child.platform));
      } catch (error) {
        // OCI indexes may include platform-less attestations next to images.
        // They cannot satisfy a platform, but an asserted image must validate.
        if (
          !child.platform &&
          error instanceof RegistryAdapterError &&
          error.code === 'REGISTRY_MANIFEST_UNSUPPORTED'
        )
          continue;
        throw error;
      }
      if (selected) matches.set(selected.manifestDigest, selected);
      if (matches.size > 1) throw new RegistryAdapterError('REGISTRY_PLATFORM_AMBIGUOUS');
    }
    return matches.values().next().value ?? null;
  }

  async resolve(targets: readonly ImagePlatform[]): Promise<ResolvedImage> {
    const root = await this.manifest(this.session.image.reference);
    const selected: ResolvedImagePlatform[] = [];
    for (const target of targets) {
      const value = await this.select(root, target);
      if (!value) throw new RegistryAdapterError('REGISTRY_PLATFORM_UNSUPPORTED');
      selected.push(value);
    }
    const input = this.session.image;
    return {
      version: 1,
      inputReference: input.input,
      registry: input.registry,
      repository: input.repository,
      tag: input.tag,
      requestedDigest: input.digest,
      manifestDigest: root.digest,
      manifestMediaType: root.mediaType,
      indexDigest: index(root) ? root.digest : null,
      deployReference: `${input.registry}/${input.repository}@${root.digest}`,
      platformManifests: selected,
      resolvedAt: new Date().toISOString(),
    };
  }
}

function validateSnapshot(value: ResolvedImage): {
  source: ParsedImageReference;
  pinned: ParsedImageReference;
  targets: ImagePlatform[];
} {
  try {
    const raw = record(value);
    if (
      Object.keys(raw).some(
        (key) =>
          ![
            'version',
            'inputReference',
            'registry',
            'repository',
            'tag',
            'requestedDigest',
            'manifestDigest',
            'manifestMediaType',
            'indexDigest',
            'deployReference',
            'platformManifests',
            'resolvedAt',
            'verifiedAt',
          ].includes(key),
      ) ||
      value.version !== 1 ||
      typeof value.manifestDigest !== 'string' ||
      !SHA256.test(value.manifestDigest) ||
      !(acceptedMedia as readonly string[]).includes(value.manifestMediaType) ||
      !Array.isArray(value.platformManifests) ||
      value.platformManifests.length === 0 ||
      value.platformManifests.length > 16 ||
      typeof value.resolvedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.resolvedAt))
    )
      throw new Error();
    const source = parseImageReference(value.inputReference);
    const pinned = parseImageReference(value.deployReference);
    const isIndex = (registryIndexMediaTypes as readonly string[]).includes(
      value.manifestMediaType,
    );
    if (
      source.registry !== value.registry ||
      source.repository !== value.repository ||
      source.tag !== value.tag ||
      source.digest !== value.requestedDigest ||
      (source.digest !== null && source.digest !== value.manifestDigest) ||
      pinned.registry !== value.registry ||
      pinned.repository !== value.repository ||
      pinned.digest !== value.manifestDigest ||
      pinned.tag !== null ||
      value.deployReference !== `${value.registry}/${value.repository}@${value.manifestDigest}` ||
      value.indexDigest !== (isIndex ? value.manifestDigest : null)
    )
      throw new Error();
    const targets = value.platformManifests.map((item) => {
      const entry = record(item);
      if (
        Object.keys(entry).some(
          (key) =>
            ![
              'os',
              'architecture',
              'variant',
              'manifestDigest',
              'manifestMediaType',
              'configDigest',
            ].includes(key),
        ) ||
        typeof item.manifestDigest !== 'string' ||
        !SHA256.test(item.manifestDigest) ||
        typeof item.configDigest !== 'string' ||
        !SHA256.test(item.configDigest) ||
        !(registryManifestMediaTypes as readonly string[]).includes(item.manifestMediaType) ||
        (!isIndex && item.manifestDigest !== value.manifestDigest)
      )
        throw new Error();
      return {
        os: item.os,
        architecture: item.architecture,
        ...(item.variant !== undefined ? { variant: item.variant } : {}),
      };
    });
    const normalized = platforms(targets);
    if (normalized.length !== targets.length) throw new Error();
    return { source, pinned, targets: normalized };
  } catch {
    throw new RegistryAdapterError('REGISTRY_SNAPSHOT_INVALID');
  }
}

export class RegistryAdapter implements RegistryImageResolver {
  private readonly limits: RegistryLimits;

  constructor(options: RegistryAdapterOptions = {}) {
    this.limits = registryLimits(options);
  }

  async resolve(image: string, options: RegistryResolveOptions): Promise<ResolvedImage> {
    const reference = parseImageReference(image);
    const targets = platforms(options.platforms);
    const session = new RegistrySession(
      reference,
      this.limits,
      accessMaterial(reference.registry, options.access),
      options.signal,
    );
    try {
      return await new Resolution(session).resolve(targets);
    } catch (error) {
      if (error instanceof RegistryAdapterError) throw error;
      throw new RegistryAdapterError('REGISTRY_INVALID_RESPONSE');
    } finally {
      session.close();
    }
  }

  async verify(image: ResolvedImage, options: RegistryResolveOptions): Promise<ResolvedImage> {
    const snapshot = validateSnapshot(image);
    // A new node platform may be validated against the same immutable index.
    // Previously recorded platform digests must still match exactly.
    const targets = platforms([...snapshot.targets, ...platforms(options.platforms)]);
    const actual = await this.resolve(snapshot.pinned.input, { ...options, platforms: targets });
    if (
      actual.manifestDigest !== image.manifestDigest ||
      actual.manifestMediaType !== image.manifestMediaType ||
      image.platformManifests.some((old) => {
        const found = actual.platformManifests.find(
          (item) => platformKey(item) === platformKey(old),
        );
        return (
          !found ||
          found.manifestDigest !== old.manifestDigest ||
          found.manifestMediaType !== old.manifestMediaType ||
          found.configDigest !== old.configDigest
        );
      })
    )
      throw new RegistryAdapterError('REGISTRY_SNAPSHOT_INVALID');
    return {
      ...actual,
      inputReference: snapshot.source.input,
      tag: snapshot.source.tag,
      requestedDigest: snapshot.source.digest,
      resolvedAt: image.resolvedAt,
      verifiedAt: new Date().toISOString(),
    };
  }
}
