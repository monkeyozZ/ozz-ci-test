import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';

export const realOrigin = 'https://127.0.0.1:51448';
export const realStatePath = fileURLToPath(
  new URL('../../../../.local/local-lab/s6-product/state.json', import.meta.url),
);
export const realCaPath = fileURLToPath(
  new URL('../../../../.local/local-lab/s6-github/product/ca.crt', import.meta.url),
);
export const realPasswordPath = fileURLToPath(
  new URL('../../../../.secrets/admin-password', import.meta.url),
);
export const realRunId = process.env.S6_REAL_UI_RUN_ID ?? 'latest';
if (!/^[a-zA-Z0-9_-]+$/.test(realRunId))
  throw new Error('S6_REAL_UI_RUN_ID must be a simple run name.');
export const realArtifactDirectory = fileURLToPath(
  new URL(`../artifacts/s6-real-product/${realRunId}/`, import.meta.url),
);

// This is the local coordinator's state file, not a substitute for a public API DTO.
const resourceNames = [
  'github',
  'registry',
  'builder',
  'repository',
  'project',
  'environment',
  'cluster',
  'service',
  'domain',
] as const;
export type RealProductState = {
  version: 1;
  id: string;
  resources: Record<(typeof resourceNames)[number], string>;
  commands: Record<string, { id?: string }>;
  checks: Array<{ name: string; status: string }>;
  initialSha: string;
  firstDeploymentId: string;
  firstImage: string;
  hostname: string;
};
export async function readRealState(): Promise<RealProductState> {
  const state = JSON.parse(await readFile(realStatePath, 'utf8')) as RealProductState;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    state.version !== 1 ||
    !uuid.test(state.id ?? '') ||
    resourceNames.some((name) => !uuid.test(state.resources?.[name] ?? '')) ||
    !uuid.test(state.firstDeploymentId ?? '') ||
    !uuid.test(state.commands?.['verify-registry']?.id ?? '') ||
    !/^[0-9a-f]{40}$/.test(state.initialSha ?? '') ||
    !/@sha256:[0-9a-f]{64}$/.test(state.firstImage ?? '') ||
    !state.hostname?.endsWith('.apps.ozz.test') ||
    ![
      'real-build-produced-digest-and-ready-pod',
      'https-content-matches-fixed-source-commit',
    ].every((name) =>
      state.checks?.some((check) => check.name === name && check.status === 'passed'),
    )
  )
    throw new Error('S6_REAL_PRODUCT_STATE_NOT_READY');
  return state;
}

/** Runs before Playwright starts a browser. Node verifies chain and IP SAN with only the supplied CA. */
export async function verifyRealEntryCertificate() {
  const ca = await readFile(realCaPath);
  return new Promise<{
    origin: string;
    chainAndHostnameVerified: true;
    caSha256: string;
    leafFingerprint256: string;
    validFrom: string;
    validTo: string;
    htmlSha256: string;
    bytes: number;
  }>((resolve, reject) => {
    const request = httpsRequest(
      realOrigin + '/',
      { ca, rejectUnauthorized: true, method: 'GET', agent: false },
      (response) => {
        const socket = response.socket as TLSSocket;
        const certificate = socket.getPeerCertificate();
        if (
          !socket.authorized ||
          !certificate.fingerprint256 ||
          response.statusCode !== 200 ||
          !String(response.headers['content-type']).startsWith('text/html')
        ) {
          response.resume();
          reject(new Error('S6_REAL_ENTRY_CERTIFICATE_OR_RESPONSE_INVALID'));
          return;
        }
        let bytes = 0;
        const hash = createHash('sha256');
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1_048_576) {
            request.destroy(new Error('S6_REAL_ENTRY_RESPONSE_TOO_LARGE'));
            return;
          }
          hash.update(chunk);
        });
        response.once('error', reject);
        response.once('end', () =>
          resolve({
            origin: realOrigin,
            chainAndHostnameVerified: true,
            caSha256: createHash('sha256').update(ca).digest('hex'),
            leafFingerprint256: certificate.fingerprint256,
            validFrom: certificate.valid_from,
            validTo: certificate.valid_to,
            htmlSha256: hash.digest('hex'),
            bytes,
          }),
        );
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error('S6_REAL_ENTRY_TLS_TIMEOUT')));
    request.once('error', reject);
    request.end();
  });
}

export default async function setup() {
  await mkdir(realArtifactDirectory, { recursive: true });
  const certificate = await verifyRealEntryCertificate();
  const state = await readRealState();
  await writeFile(
    realArtifactDirectory + '/preflight.json',
    JSON.stringify(
      {
        scope:
          'Local real product UI; development cookie flow; GitHub transport is the isolated HTTPS fixture',
        checkedAt: new Date().toISOString(),
        certificate,
        resourceIds: state.resources,
        expectedDeploymentId: state.firstDeploymentId,
        expectedCommit: state.initialSha,
        expectedImage: state.firstImage,
        browserTrust:
          'ignoreHTTPSErrors only in this test context, after explicit Node CA verification',
        productionSecureCookieVerified: false,
      },
      null,
      2,
    ) + '\n',
  );
}
