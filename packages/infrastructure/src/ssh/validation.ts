import { isIP } from 'node:net';
import {
  SshAdapterError,
  type SshCredential,
  type SshEndpoint,
  type SshInitializeOptions,
  type SshTarget,
} from './contracts.js';

export function validHost(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253) return false;
  if (isIP(value)) return true;
  return value
    .split('.')
    .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

export function validateEndpoint(endpoint: SshEndpoint): void {
  if (
    !endpoint ||
    !validHost(endpoint.host) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  ) {
    throw new SshAdapterError('SSH_INVALID_TARGET');
  }
}

export function validateTarget(target: SshTarget): void {
  validateEndpoint(target);
  if (
    typeof target.username !== 'string' ||
    !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}\$?$/.test(target.username) ||
    typeof target.hostKeyFingerprint !== 'string' ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(target.hostKeyFingerprint)
  )
    throw new SshAdapterError('SSH_INVALID_TARGET');
}

export function parseSshCredential(value: unknown): SshCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SshAdapterError('SSH_INVALID_CREDENTIAL');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['privateKey', 'passphrase', 'password'].includes(key)))
    throw new SshAdapterError('SSH_INVALID_CREDENTIAL');
  if (
    typeof input.password === 'string' &&
    input.password.length > 0 &&
    Buffer.byteLength(input.password) <= 16_384 &&
    input.privateKey === undefined &&
    input.passphrase === undefined &&
    !input.password.includes('\0')
  ) {
    return { password: input.password };
  }
  if (
    typeof input.privateKey === 'string' &&
    Buffer.byteLength(input.privateKey) >= 64 &&
    Buffer.byteLength(input.privateKey) <= 128 * 1024 &&
    input.password === undefined &&
    (input.passphrase === undefined ||
      (typeof input.passphrase === 'string' &&
        Buffer.byteLength(input.passphrase) <= 16_384 &&
        !input.passphrase.includes('\0')))
  )
    return {
      privateKey: input.privateKey,
      ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase as string }),
    };
  throw new SshAdapterError('SSH_INVALID_CREDENTIAL');
}

export function validateInitialization(options: SshInitializeOptions): {
  apiEndpoint: string;
  apiHostname: string;
} {
  if (
    !options ||
    typeof options.installationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      options.installationId,
    ) ||
    typeof options.expectedMachineId !== 'string' ||
    !/^[0-9a-f]{32}$/.test(options.expectedMachineId) ||
    typeof options.nodeName !== 'string' ||
    options.nodeName.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(options.nodeName) ||
    typeof options.onCredential !== 'function'
  )
    throw new SshAdapterError('SSH_INVALID_INSTALLATION');
  try {
    if (
      typeof options.apiEndpoint !== 'string' ||
      options.apiEndpoint.length > 512 ||
      /[\s\\]/.test(options.apiEndpoint)
    )
      throw new Error();
    const endpoint = new URL(options.apiEndpoint);
    const apiHostname = endpoint.hostname.replace(/^\[|\]$/g, '');
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      endpoint.hash ||
      !validHost(apiHostname) ||
      (endpoint.port && Number(endpoint.port) < 1)
    )
      throw new Error();
    return { apiEndpoint: endpoint.origin, apiHostname };
  } catch {
    throw new SshAdapterError('SSH_INVALID_INSTALLATION');
  }
}
