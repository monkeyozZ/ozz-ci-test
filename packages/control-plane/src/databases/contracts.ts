import type { ServiceConfiguration, ServiceListQuery } from '../services/contracts.js';

export type DatabaseEngine = 'postgresql' | 'redis';
export type TemplateId = 'docker' | 'node-example' | 'static-example' | 'postgresql' | 'redis';
export type DataIssue = {
  code: string;
  message: string;
  field: string | null;
  blocks: 'save' | 'deploy' | 'both' | 'none';
};

export interface TemplateParameters {
  image?: string;
  port?: number;
  requestedBytes?: string;
  username?: string;
  databaseName?: string;
  redisDatabase?: number;
}
export interface TemplateSelection {
  id: TemplateId;
  version: string;
  parameters: TemplateParameters;
}
export interface TemplateParameter {
  name: keyof TemplateParameters;
  label: string;
  description: string;
  type: 'string' | 'integer' | 'bytes';
  required: boolean;
  defaultValue: string | number | null;
  minimum: number | null;
  maximum: number | null;
}
export interface TemplateView {
  id: TemplateId;
  version: string;
  name: string;
  description: string;
  category: 'application' | 'database';
  sourceUrl: string;
  license: string;
  image: {
    reference: string;
    digest: string;
    version: string;
    platforms: ('arm64' | 'amd64')[];
    verifiedAt: string;
  } | null;
  parameters: TemplateParameter[];
  resources: ServiceConfiguration['resources'];
  controller: { kind: 'Deployment' | 'StatefulSet'; strategy: 'RollingUpdate' | 'Recreate' };
  persistent: boolean;
  notes: string[];
}
export interface TemplatePreviewInput {
  environmentId: string;
  projectId?: string;
  version: string;
  parameters: TemplateParameters;
}
export interface TemplatePreview {
  template: { id: TemplateId; version: string };
  environmentId: string;
  projectId: string;
  clusterId: string;
  configuration: ServiceConfiguration;
  controller: TemplateView['controller'];
  plannedVolumes: {
    purpose: 'database_data';
    requestedBytes: string;
    storageClassName: 'local-path';
    mountPath: string;
    hardQuotaSupport: 'unsupported';
  }[];
  plannedCredentials: { kind: 'database'; generated: true }[];
  issues: DataIssue[];
  previewDigest: string;
}

/** Stable, non-secret data identity fixed when a publication is accepted. */
export interface DatabaseSnapshot {
  version: 1;
  databaseInstanceId: string;
  dataVolumeId: string;
  engine: DatabaseEngine;
  majorVersion: number;
  exactVersion: string;
  image: string;
  templateId: TemplateId;
  templateVersion: string;
  dataLayout: string;
  credentialRefId: string;
  credentialContentRevision: number;
  username: string;
  databaseName: string | null;
  redisDatabase: number | null;
  protectionRevision: number;
}
export type DatabaseOutputKey = 'host' | 'port' | 'database' | 'user' | 'password' | 'db' | 'url';
export type DatabaseOutputMapping = Partial<Record<DatabaseOutputKey, string>>;
export interface DatabaseBindingInput {
  revision: number;
  databaseInstanceId: string;
  profile: 'fields' | 'url';
  mapping: DatabaseOutputMapping;
}
export interface DatabaseBindingSnapshot {
  version: 1;
  bindingId: string;
  databaseInstanceId: string;
  providerServiceId: string;
  providerDeploymentId: string;
  providerServiceUid: string;
  clusterId: string;
  environmentId: string;
  namespace: string;
  host: string;
  port: number;
  engine: DatabaseEngine;
  databaseName: string | null;
  redisDatabase: number | null;
  username: string;
  credentialRefId: string;
  credentialContentRevision: number;
  profile: 'fields' | 'url';
  mapping: DatabaseOutputMapping;
}
export interface DatabaseBindingView {
  id: string;
  databaseInstanceId: string;
  revision: number;
  profile: 'fields' | 'url';
  mapping: DatabaseOutputMapping;
  desired: boolean;
  provider: { serviceId: string | null; name: string; engine: DatabaseEngine; ready: boolean };
  published: boolean;
  issues: DataIssue[];
}
export interface DatabaseBindingCollection {
  data: DatabaseBindingView[];
  serviceRevision: number;
  configRevision: number;
}
export interface DatabaseBindingPreview {
  databaseInstanceId: string;
  profile: 'fields' | 'url';
  mapping: DatabaseOutputMapping;
  variables: {
    name: string;
    output: DatabaseOutputKey;
    secret: boolean;
    change: 'add' | 'replace';
  }[];
  issues: DataIssue[];
  serviceRevision: number;
}
export interface DatabaseAuthenticationObservation {
  state: 'ready' | 'failed' | 'unknown';
  authenticated: boolean;
  engineVersion: string | null;
  persistence: 'postgres_wal' | 'redis_aof_everysec' | 'unknown';
  podUid: string | null;
  pvcUid: string | null;
  observedAt: string;
  code: string | null;
  message: string | null;
}
export interface DatabaseView {
  id: string;
  revision: number;
  engine: DatabaseEngine;
  majorVersion: number;
  exactVersion: string;
  template: { id: string; version: string };
  service: { id: string; name: string; slug: string } | null;
  originalService: { id: string; name: string; slug: string };
  projectId: string;
  environmentId: string;
  clusterId: string;
  dataVolume: {
    id: string;
    name: string;
    namespace: string;
    pvcName: string;
    pvcUid: string | null;
    requestedBytes: string;
    destroyedAt: string | null;
  };
  protection: {
    active: boolean;
    revision: number;
    fencedAt: string | null;
    lockedFields: string[];
    reason: string;
  };
  initialization: { state: string; initializedAt: string | null; pvcUid: string | null };
  credential: { refId: string; contentRevision: number };
  connection: {
    host: string | null;
    port: number;
    username: string;
    database: string | null;
    redisDatabase: number | null;
    visibility: 'cluster_private';
  };
  databaseReady: boolean;
  observation: DatabaseAuthenticationObservation | null;
  observationStale: boolean;
  consumers: {
    serviceId: string;
    name: string;
    desired: boolean;
    published: boolean;
    inFlight: boolean;
  }[];
  consumersTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface DatabaseListQuery extends ServiceListQuery {
  serviceId?: string;
}
export interface ServiceDeletionPreview {
  serviceId: string;
  revision: number;
  retainedVolumes: {
    id: string;
    name: string;
    pvcUid: string | null;
    databaseInstanceId: string | null;
  }[];
  databaseConsumers: {
    serviceId: string;
    name: string;
    desired: boolean;
    published: boolean;
    inFlight: boolean;
  }[];
  blockers: DataIssue[];
  dataRetentionMessage: string;
}

export const DATABASE_OBSERVATION_STALE_MS = 90_000;
export const DATABASE_BINDING_LIMIT = 8;
