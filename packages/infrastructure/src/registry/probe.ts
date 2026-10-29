import { createHash } from 'node:crypto';
import {
  RegistryAdapterError,
  type RegistryAccess,
  type RegistryAdapterOptions,
} from './contracts.js';
import { RegistryAdapter } from './adapter.js';
import { accessMaterial } from './access.js';
import { parseImageReference } from './reference.js';
import { RegistrySession, registryLimits, statusError } from './transport.js';

export interface RegistryProbeResult {
  push: true;
  pull: true;
  pullCannotPush: true;
  probeReference: string;
  checkedAt: string;
  probeRetained: boolean;
}
export interface RegistryProbeCheck {
  kind: 'push' | 'pull' | 'pull_cannot_push';
  probeReference: string;
  checkedAt: string;
}
export interface RegistryProbeInput {
  authority: string;
  repository: string;
  push: RegistryAccess;
  pull: RegistryAccess;
  signal?: AbortSignal;
  onChecked?: (check: RegistryProbeCheck) => Promise<void>;
}
export interface RegistryPermissionProbe {
  verify(input: RegistryProbeInput): Promise<RegistryProbeResult>;
}

/** An explicit, tiny OCI probe in an operation-owned repository tests real ACLs. */
export class RegistryProbe implements RegistryPermissionProbe {
  constructor(private readonly options: RegistryAdapterOptions = {}) {}
  async verify(input: RegistryProbeInput): Promise<RegistryProbeResult> {
    const image = parseImageReference(`${input.authority}/${input.repository}:permissions`);
    if (
      image.registry !== input.authority ||
      image.repository !== input.repository ||
      !/\/ozz-probe-[0-9a-f-]{36}$/.test(image.repository)
    )
      throw new RegistryAdapterError('REGISTRY_REFERENCE_INVALID');
    const limits = registryLimits({
      ...this.options,
      maxRequests: 32,
      maxResolutionBytes: 2 * 1024 * 1024,
    });
    const push = new RegistrySession(
      image,
      limits,
      accessMaterial(input.authority, input.push),
      input.signal,
      'pull,push',
    );
    const negative = new RegistrySession(
      image,
      limits,
      accessMaterial(input.authority, input.pull),
      input.signal,
      'pull,push',
    );
    const hash = (body: Buffer) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
    try {
      const config = Buffer.from(
        JSON.stringify({
          architecture: 'amd64',
          os: 'linux',
          config: {},
          rootfs: { type: 'layers', diff_ids: [] },
          history: [],
        }),
      );
      const configDigest = hash(config);
      const created = await push.write('POST', `/v2/${image.repository}/blobs/uploads/`);
      if (created.status !== 202 || typeof created.headers.location !== 'string')
        throw statusError(created);
      const upload = new URL(created.headers.location, image.apiOrigin);
      upload.searchParams.set('digest', configDigest);
      const uploaded = await push.write('PUT', upload.href, config, 'application/octet-stream');
      if (uploaded.status !== 201) throw statusError(uploaded);
      const manifest = Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          config: {
            mediaType: 'application/vnd.oci.image.config.v1+json',
            digest: configDigest,
            size: config.length,
          },
          layers: [],
        }),
      );
      const digest = hash(manifest);
      const published = await push.write(
        'PUT',
        `/v2/${image.repository}/manifests/permissions`,
        manifest,
        'application/vnd.oci.image.manifest.v1+json',
      );
      if (published.status !== 201) throw statusError(published);
      if (
        published.headers['docker-content-digest'] &&
        published.headers['docker-content-digest'] !== digest
      )
        throw new RegistryAdapterError('REGISTRY_DIGEST_MISMATCH');
      const reference = `${input.authority}/${image.repository}@${digest}`;
      await input.onChecked?.({
        kind: 'push',
        probeReference: reference,
        checkedAt: new Date().toISOString(),
      });
      await new RegistryAdapter(this.options).resolve(reference, {
        platforms: [{ os: 'linux', architecture: 'amd64' }],
        access: input.pull,
        signal: input.signal,
      });
      await input.onChecked?.({
        kind: 'pull',
        probeReference: reference,
        checkedAt: new Date().toISOString(),
      });
      let denied = false;
      try {
        const attempt = await negative.write('POST', `/v2/${image.repository}/blobs/uploads/`);
        denied = attempt.status === 401 || attempt.status === 403;
        if (!denied) {
          if (attempt.status === 202 && typeof attempt.headers.location === 'string')
            await negative.write('DELETE', attempt.headers.location);
          if (attempt.status < 200 || attempt.status >= 300) throw statusError(attempt);
        }
      } catch (error) {
        if (
          error instanceof RegistryAdapterError &&
          ['REGISTRY_FORBIDDEN', 'REGISTRY_UNAUTHENTICATED'].includes(error.code)
        )
          denied = true;
        else throw error;
      }
      if (!denied) throw new RegistryAdapterError('REGISTRY_PULL_CREDENTIAL_CAN_PUSH');
      await input.onChecked?.({
        kind: 'pull_cannot_push',
        probeReference: reference,
        checkedAt: new Date().toISOString(),
      });
      let probeRetained = true;
      try {
        probeRetained =
          (await push.write('DELETE', `/v2/${image.repository}/manifests/${digest}`)).status !==
          202;
      } catch {
        /* A disabled Registry delete endpoint does not change the observed ACL facts. */
      }
      return {
        push: true,
        pull: true,
        pullCannotPush: true,
        probeReference: reference,
        checkedAt: new Date().toISOString(),
        probeRetained,
      };
    } finally {
      push.close();
      negative.close();
    }
  }
}
