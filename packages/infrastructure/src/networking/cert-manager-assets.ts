import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { NetworkingAdapterError } from './contracts.js';

export const CERT_MANAGER_VERSION = 'v1.21.3';

/** cert-manager 1.21 is supported and tested on Kubernetes 1.33 through 1.36. */
export const CERT_MANAGER_SUPPORTED_KUBERNETES_MINORS = Object.freeze([33, 34, 35, 36] as const);

export const CERT_MANAGER_IMAGES = Object.freeze({
  controller:
    'quay.io/jetstack/cert-manager-controller:v1.21.3@sha256:9f4f96a33c7774cef24466fcd85031997531a03a8d117f151126baa8d1290dcc',
  cainjector:
    'quay.io/jetstack/cert-manager-cainjector:v1.21.3@sha256:083d0e906f8eb44e255fe4ff817ae54e49f9ed82e22f1011bb4e9e4f4b8a641f',
  webhook:
    'quay.io/jetstack/cert-manager-webhook:v1.21.3@sha256:055ac8e9de6a0ba6763794838fe38944acc650f68ebe1b01dd8be079e580f458',
  acmesolver:
    'quay.io/jetstack/cert-manager-acmesolver:v1.21.3@sha256:c8c1225bb2fe8ab37a330b77f0d8c2ee6a41210fcb54fc07ca606ab9a022b8b7',
} as const);

export const CERT_MANAGER_MANIFEST = Object.freeze({
  filename: 'cert-manager-v1.21.3.yaml',
  sha256: 'c04a51295adda2b1a775146751f973e787190778c7f35180861d9678876e5c74',
  bytes: 1_034_826,
  documents: 47,
} as const);

export const CERT_MANAGER_MAX_OBJECT_BYTES = 1024 * 1024;

function invalidAsset(): never {
  throw new NetworkingAdapterError(
    'CERT_MANAGER_ASSET_INVALID',
    '固定版本 cert-manager 安装清单校验失败，请检查随部署提供的资产。',
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate bytes before parsing. The caller receives fresh, unmodified upstream objects. */
export function parseCertManagerManifests(contents: Uint8Array): Record<string, unknown>[] {
  if (
    !(contents instanceof Uint8Array) ||
    contents.byteLength !== CERT_MANAGER_MANIFEST.bytes ||
    createHash('sha256').update(contents).digest('hex') !== CERT_MANAGER_MANIFEST.sha256
  )
    invalidAsset();
  try {
    const documents = parseAllDocuments(Buffer.from(contents).toString('utf8'), {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (documents.length !== CERT_MANAGER_MANIFEST.documents) invalidAsset();
    return documents.map((document) => {
      if (document.errors.length) invalidAsset();
      const value: unknown = document.toJS({ maxAliasCount: 0 });
      if (
        !record(value) ||
        typeof value.apiVersion !== 'string' ||
        typeof value.kind !== 'string' ||
        !record(value.metadata) ||
        typeof value.metadata.name !== 'string' ||
        Buffer.byteLength(JSON.stringify(value)) > CERT_MANAGER_MAX_OBJECT_BYTES
      )
        invalidAsset();
      return value;
    });
  } catch {
    invalidAsset();
  }
}

/** Package-relative assets survive pnpm deploy; no repository root or download is needed. */
export async function loadCertManagerManifests(): Promise<Record<string, unknown>[]> {
  const path = resolve(__dirname, '../../assets', CERT_MANAGER_MANIFEST.filename);
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      received += chunk.length;
      if (received > CERT_MANAGER_MANIFEST.bytes) invalidAsset();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof NetworkingAdapterError) throw error;
    throw new NetworkingAdapterError(
      'CERT_MANAGER_ASSET_UNAVAILABLE',
      '无法读取随部署提供的 cert-manager 安装清单。',
    );
  }
  return parseCertManagerManifests(Buffer.concat(chunks, received));
}
