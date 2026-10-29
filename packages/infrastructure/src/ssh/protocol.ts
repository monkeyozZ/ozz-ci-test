import { StringDecoder } from 'node:string_decoder';
import {
  SshAdapterError,
  isSshErrorCode,
  type SshPreflight,
  type SshPreflightBlocker,
  type SshPreflightWarning,
} from './contracts.js';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 255): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return value;
}

function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T))
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return value as T;
}

function choices<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value) || value.length > allowed.length)
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const values = value.map((item) => choice(item, allowed));
  if (new Set(values).size !== values.length) throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return values;
}

/** At most 32 protocol frames; arbitrary text never becomes a log or an exception cause. */
export class Frames {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  readonly values: Record<string, unknown>[] = [];

  constructor(private readonly onFrame?: (value: Record<string, unknown>) => void) {}

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let newline;
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      if (line.trim()) this.accept(line);
    }
  }

  finish(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.accept(this.pending);
    this.pending = '';
  }

  private accept(line: string): void {
    if (this.values.length >= 32) throw new SshAdapterError('SSH_OUTPUT_LIMIT');
    let value: Record<string, unknown>;
    try {
      value = record(JSON.parse(line));
    } catch {
      throw new SshAdapterError('SSH_INVALID_RESPONSE');
    }
    choice(value.type, ['preflight', 'progress', 'credential', 'initialized', 'error']);
    this.values.push(value);
    this.onFrame?.(value);
  }
}

export function requireSuccessfulOutput(frames: Frames, exitCode: number | null): void {
  const failures = frames.values.filter((frame) => frame.type === 'error');
  if (failures.length > 0) {
    const code = failures[0]?.code;
    throw new SshAdapterError(isSshErrorCode(code) ? code : 'SSH_REMOTE_FAILED');
  }
  if (exitCode !== 0) throw new SshAdapterError('SSH_REMOTE_FAILED');
}

const blockers: readonly SshPreflightBlocker[] = [
  'unsupported_os',
  'unsupported_architecture',
  'systemd_required',
  'privilege_required',
  'memory_cgroup_required',
  'insufficient_cpu',
  'insufficient_memory',
  'insufficient_disk',
  'ports_in_use',
];
const warnings: readonly SshPreflightWarning[] = [
  'low_memory_headroom',
  'low_disk_headroom',
  'firewall_requires_review',
  'cloud_firewall_unknown',
  'existing_k3s',
];

export function preflightObservation(value: unknown): SshPreflight {
  const data = record(value);
  const k3s = record(data.k3s);
  const machineId = string(data.machineId, 32);
  if (!/^[0-9a-f]{32}$/.test(machineId)) throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const installationId = k3s.installationId === null ? null : string(k3s.installationId, 36);
  if (
    installationId !== null &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      installationId,
    )
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const version = k3s.version === null ? null : string(k3s.version, 64);
  if (version !== null && !/^v[0-9]+\.[0-9]+\.[0-9]+\+k3s[0-9]+$/.test(version))
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const expectedPorts = ['tcp:22', 'tcp:80', 'tcp:443', 'tcp:6443', 'tcp:10250', 'udp:8472'];
  if (!Array.isArray(data.ports) || data.ports.length !== expectedPorts.length)
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const ports = data.ports.map((value) => {
    const port = record(value);
    return {
      protocol: choice(port.protocol, ['tcp', 'udp']),
      port: number(port.port, 65535),
      listening: boolean(port.listening),
    };
  });
  if (
    new Set(ports.map(({ protocol, port }) => `${protocol}:${port}`)).size !==
      expectedPorts.length ||
    ports.some(({ protocol, port }) => !expectedPorts.includes(`${protocol}:${port}`))
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const observation: SshPreflight = {
    observedAt: new Date().toISOString(),
    machineId,
    hostname: string(data.hostname),
    os: string(data.os, 64),
    osVersion: string(data.osVersion, 64),
    architecture: choice(data.architecture, ['arm64', 'amd64', 'unsupported']),
    kernel: string(data.kernel),
    init: string(data.init, 128),
    cpuCount: number(data.cpuCount, 4096),
    memoryBytes: number(data.memoryBytes),
    memoryAvailableBytes: number(data.memoryAvailableBytes),
    rootDiskBytes: number(data.rootDiskBytes),
    rootDiskAvailableBytes: number(data.rootDiskAvailableBytes),
    dataDiskBytes: number(data.dataDiskBytes),
    dataDiskAvailableBytes: number(data.dataDiskAvailableBytes),
    privileged: boolean(data.privileged),
    memoryCgroupAvailable: boolean(data.memoryCgroupAvailable),
    systemdAvailable: boolean(data.systemdAvailable),
    ports,
    firewall: choice(data.firewall, ['active', 'inactive', 'unknown']),
    k3s: {
      installed: boolean(k3s.installed),
      version,
      installationId,
      installationPhase:
        k3s.installationPhase === null
          ? null
          : choice(k3s.installationPhase, ['prepared', 'installed', 'ready'] as const),
      secretsEncryption: choice(k3s.secretsEncryption, ['enabled', 'disabled', 'unknown']),
    },
    blockers: choices(data.blockers, blockers),
    warnings: choices(data.warnings, warnings),
  };
  if (
    observation.memoryAvailableBytes > observation.memoryBytes ||
    observation.rootDiskAvailableBytes > observation.rootDiskBytes ||
    observation.dataDiskAvailableBytes > observation.dataDiskBytes ||
    (observation.k3s.installationPhase === null) !== (installationId === null)
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return observation;
}

/** Rebuild only the embedded bootstrap credential fields; reject implicit authentication paths. */
export function bootstrapCredential(value: unknown, apiEndpoint: string): string {
  const config = record(value);
  if (
    config.apiVersion !== 'v1' ||
    config.kind !== 'Config' ||
    !Array.isArray(config.clusters) ||
    config.clusters.length !== 1 ||
    !Array.isArray(config.users) ||
    config.users.length !== 1 ||
    !Array.isArray(config.contexts) ||
    config.contexts.length !== 1
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const clusterEntry = record(config.clusters[0]);
  const userEntry = record(config.users[0]);
  const contextEntry = record(config.contexts[0]);
  const cluster = record(clusterEntry.cluster);
  const user = record(userEntry.user);
  const context = record(contextEntry.context);
  if (
    cluster.server !== apiEndpoint ||
    context.cluster !== clusterEntry.name ||
    context.user !== userEntry.name ||
    config['current-context'] !== contextEntry.name ||
    Object.keys(cluster).some((key) => !['server', 'certificate-authority-data'].includes(key)) ||
    Object.keys(user).some((key) => !['client-certificate-data', 'client-key-data'].includes(key))
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const embedded = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      value.length < 64 ||
      value.length > 128 * 1024 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    )
      throw new SshAdapterError('SSH_INVALID_RESPONSE');
    return value;
  };
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'ozz-bootstrap',
    clusters: [
      {
        name: 'ozz-bootstrap',
        cluster: {
          server: apiEndpoint,
          'certificate-authority-data': embedded(cluster['certificate-authority-data']),
        },
      },
    ],
    users: [
      {
        name: 'ozz-bootstrap',
        user: {
          'client-certificate-data': embedded(user['client-certificate-data']),
          'client-key-data': embedded(user['client-key-data']),
        },
      },
    ],
    contexts: [
      { name: 'ozz-bootstrap', context: { cluster: 'ozz-bootstrap', user: 'ozz-bootstrap' } },
    ],
  });
}
