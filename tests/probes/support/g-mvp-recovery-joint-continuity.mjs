import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Callable only. Importing this module performs no I/O, process, or runtime work.
// The caller supplies a read-only Prisma SQL adapter and its bounded command runner.
const sha = (value) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const hex = /^[0-9a-f]{64}$/u;
const selections = [
  {
    key: 'a-image',
    guest: 'a',
    sourceKind: 'image',
    serviceId: 'f806a17e-2edf-4933-af89-07d1dddd9c17',
  },
  {
    key: 'b-git',
    guest: 'b',
    sourceKind: 'github',
    serviceId: 'e5968684-0d49-49fa-8dfd-ce0b035d73ad',
  },
];

function requireValue(value, code) {
  if (!value) throw new Error('GMVP_JOINT_APPLICATION_' + code);
}

// No entire config, snapshot, target, log, credential or SecretReference is selected.
// platformManifests is the registry adapter's serializable public image identity.
const metadataSql = `
SELECT s.id AS "serviceId", s."sourceKind", s."desiredState"::text AS "desiredState",
 s."configurationState"::text AS "configurationState", s."environmentId", e."projectId",
 p."clusterId", c."kubeSystemUid", n.uid AS "nodeUid", n.name AS "nodeName",
 cp."installationId", s."publishedDeploymentId" AS "deploymentId",
 s."lastSuccessfulDeploymentId", d.status::text AS "deploymentStatus",
 d."serviceId" AS "deploymentServiceId", d."sourceRevisionId", d."artifactId",
 d."targetJson"->>'installationId' AS "targetInstallationId",
 d."targetJson"->>'clusterId' AS "targetClusterId",
 d."targetJson"->>'projectId' AS "targetProjectId",
 d."targetJson"->>'environmentId' AS "targetEnvironmentId",
 d."targetJson"->>'serviceId' AS "targetServiceId",
 d."targetJson"->>'kubeSystemUid' AS "targetKubeSystemUid",
 d."snapshotJson"->'source'->>'commitSha' AS "commitSha",
 d."resolvedImageJson"->>'deployReference' AS "deployReference",
 d."resolvedImageJson"->>'manifestDigest' AS "rootDigest",
 d."resolvedImageJson"->'platformManifests' AS "platformManifests",
 a."rootDigest" AS "artifactRootDigest", a."commitSha" AS "artifactCommitSha",
 a."sourceRevisionId" AS "artifactSourceRevisionId", a."availability" AS "artifactAvailability",
 dom.id AS "domainId", dom.hostname, dom."certificateEnvironment",
 dom."desiredState" AS "domainDesiredState"
FROM "Service" s
JOIN "Environment" e ON e.id=s."environmentId"
JOIN "Project" p ON p.id=e."projectId"
JOIN "Cluster" c ON c.id=p."clusterId"
JOIN "Node" n ON n."clusterId"=c.id AND n.present=true
JOIN "ControlPlaneState" cp ON cp.id='control-plane'
JOIN "Deployment" d ON d.id=s."publishedDeploymentId"
JOIN "Domain" dom ON dom."serviceId"=s.id
LEFT JOIN "BuildArtifact" a ON a.id=d."artifactId"
WHERE s.id IN ($1::uuid, $2::uuid)
ORDER BY s.id, n.uid`;

async function boundedSource(root, relative) {
  const path = resolve(root, relative);
  const info = await lstat(path);
  requireValue(
    info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 1024 * 1024,
    'SOURCE_INVALID',
  );
  const raw = await readFile(path);
  requireValue(raw.length === info.size, 'SOURCE_CHANGED');
  return { raw, evidence: { path: relative, sha256: sha(raw), bytes: raw.length } };
}

function projectMetadata(row, selection, installationId, published) {
  for (const key of [
    'serviceId',
    'environmentId',
    'projectId',
    'clusterId',
    'kubeSystemUid',
    'nodeUid',
    'installationId',
    'deploymentId',
    'domainId',
  ])
    requireValue(uuid.test(row[key]), 'IDENTITY_INVALID');
  requireValue(
    row.serviceId === selection.serviceId &&
      row.sourceKind === selection.sourceKind &&
      row.installationId === installationId &&
      row.deploymentServiceId === row.serviceId &&
      row.deploymentId === row.lastSuccessfulDeploymentId &&
      row.deploymentStatus === 'succeeded' &&
      row.desiredState === 'running' &&
      row.configurationState === 'consistent' &&
      row.domainDesiredState === 'active',
    'METADATA_NOT_PUBLISHED',
  );
  for (const key of [
    'InstallationId',
    'ClusterId',
    'ProjectId',
    'EnvironmentId',
    'ServiceId',
    'KubeSystemUid',
  ]) {
    const actual = key[0].toLowerCase() + key.slice(1);
    requireValue(row['target' + key] === row[actual], 'FIXED_TARGET_CHANGED');
  }
  requireValue(
    typeof row.nodeName === 'string' &&
      /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(row.nodeName) &&
      typeof row.hostname === 'string' &&
      /^[a-z0-9.-]+$/u.test(row.hostname) &&
      row.hostname.length <= 253 &&
      row.hostname.endsWith(`.${selection.guest}.apps.ozz.test`) &&
      ['staging', 'production'].includes(row.certificateEnvironment),
    'NETWORK_TARGET_INVALID',
  );
  requireValue(
    digest.test(row.rootDigest) &&
      typeof row.deployReference === 'string' &&
      row.deployReference.length <= 1024 &&
      /^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$/u.test(row.deployReference) &&
      row.deployReference.endsWith('@' + row.rootDigest) &&
      Array.isArray(row.platformManifests),
    'IMAGE_IDENTITY_INVALID',
  );
  const platforms = row.platformManifests.filter(
    (item) => item.os === 'linux' && item.architecture === 'arm64',
  );
  requireValue(
    platforms.length === 1 &&
      digest.test(platforms[0].manifestDigest) &&
      digest.test(platforms[0].configDigest),
    'ARM64_IMAGE_IDENTITY_INVALID',
  );
  if (selection.guest === 'a') {
    requireValue(
      row.domainId === published.s4.prepared.domains.a &&
        row.environmentId === published.s4.prepared.environments.a &&
        row.projectId === published.s4.prepared.projects.a,
      'A_BASELINE_CHANGED',
    );
  } else {
    const latest = published.webhook.runningDelivery;
    requireValue(
      row.serviceId === published.product.identity.id &&
        row.clusterId === published.product.identity.clusterId &&
        row.environmentId === published.product.identity.environmentId &&
        row.projectId === published.product.identity.projectId &&
        row.domainId === published.product.https[0].domainId &&
        row.deploymentId === latest.deploymentId &&
        row.commitSha === latest.commitSha &&
        row.artifactId === latest.artifactId &&
        row.rootDigest === latest.imageDigest &&
        row.artifactCommitSha === row.commitSha &&
        row.artifactRootDigest === row.rootDigest &&
        row.artifactSourceRevisionId === row.sourceRevisionId &&
        row.artifactAvailability === 'available',
      'B_GIT_BASELINE_CHANGED',
    );
  }
  return {
    ...selection,
    kind: 'application',
    installationId,
    clusterId: row.clusterId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    kubeSystemUid: row.kubeSystemUid,
    nodeUid: row.nodeUid,
    nodeName: row.nodeName,
    namespace: `ozz-e-${row.environmentId.replaceAll('-', '')}`,
    serviceName: `ozz-s-${row.serviceId.replaceAll('-', '')}`,
    domainId: row.domainId,
    domainName: `ozz-d-${row.domainId.replaceAll('-', '')}`,
    hostname: row.hostname,
    certificateEnvironment: row.certificateEnvironment,
    ingressIp: '192.168.5.15',
    deploymentId: row.deploymentId,
    sourceRevisionId: row.sourceRevisionId,
    artifactId: row.artifactId,
    commitSha: row.commitSha,
    deployReference: row.deployReference,
    rootDigest: row.rootDigest,
    arm64ManifestDigest: platforms[0].manifestDigest,
    arm64ConfigDigest: platforms[0].configDigest,
    contentKind: selection.guest === 'a' ? 'json-message' : 'body-sha256',
    messageSha256: selection.guest === 'a' ? sha('Ozz S4 A') : null,
    bodySha256: selection.guest === 'b' ? published.webhook.runningDelivery.httpsBodySha256 : null,
  };
}

// Execute the retained Python helper with __name__ != '__main__'. Only its
// application snapshot/get functions are called; database markers/Pod exec are unused.
// The extension adds explicit runtime image identities and the Git HTML body hash.
const applicationObservationPython = String.raw`
import hashlib, http.client, json, re, socket, ssl, time
from pathlib import Path
from datetime import datetime, timezone
require = helper['require']
snapshot = helper['snapshot']
get = helper['get']
digest = helper['digest']
target = parameters['target']
result = {'version': 1, 'key': target['key'], 'status': 'in-progress',
          'startedAt': datetime.now(timezone.utc).isoformat()}

def image_snapshot():
    current = snapshot(target)
    require(current['identity']['certificateEnvironment'] == target['certificateEnvironment'],
            'CERTIFICATE_ENVIRONMENT_CHANGED')
    controller = get(current['identity']['controller']['kind'], target['serviceName'], target['namespace'])
    pod = get('pod', current['identity']['pod']['name'], target['namespace'])
    require(controller['metadata']['uid'] == current['identity']['controller']['uid'] and
            pod['metadata']['uid'] == current['identity']['pod']['uid'], 'IMAGE_RESOURCE_CHANGED')
    template = controller['spec']['template']
    require(template['metadata'].get('annotations', {}).get('ozz.dev/rollout-id') == target['deploymentId'] and
            pod['metadata'].get('annotations', {}).get('ozz.dev/rollout-id') == target['deploymentId'],
            'ROLLOUT_ID_CHANGED')
    for containers in (template['spec']['containers'], pod['spec']['containers']):
        require(len(containers) == 1 and containers[0]['name'] == 'app' and
                containers[0]['image'] == target['deployReference'], 'DECLARED_IMAGE_CHANGED')
    statuses = pod.get('status', {}).get('containerStatuses', [])
    require(len(statuses) == 1 and statuses[0]['name'] == 'app' and statuses[0].get('ready') is True
            and 'running' in statuses[0].get('state', {}), 'APP_CONTAINER_NOT_READY')
    container = statuses[0]
    image_id = container.get('imageID', '')
    runtime_digest = re.search(r'(sha256:[0-9a-f]{64})$', image_id)
    require(runtime_digest is not None and runtime_digest[1] in
            (target['rootDigest'], target['arm64ManifestDigest']), 'RUNTIME_IMAGE_DIGEST_CHANGED')
    current['identity']['containers'] = [{'name': container['name'], 'declaredImage': target['deployReference'],
       'observedImage': container.get('image'), 'imageId': image_id, 'runtimeDigest': runtime_digest[1],
       'rootDigest': target['rootDigest'], 'arm64ManifestDigest': target['arm64ManifestDigest'],
       'arm64ConfigDigest': target['arm64ConfigDigest'], 'rolloutId': target['deploymentId']}]
    return current

def https(before):
    if target['contentKind'] == 'json-message':
        return helper['request'](target, before, True)
    ca = Path('/var/lib/ozz-local-lab') / target['guest'] / 'networking-v1' / (target['certificateEnvironment'] + '-signing-root.pem')
    context = ssl.create_default_context(cafile=str(ca))
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    with socket.create_connection((target['ingressIp'], 443), timeout=5) as raw:
        with context.wrap_socket(raw, server_hostname=target['hostname']) as stream:
            certificate = stream.getpeercert()
            leaf = digest(stream.getpeercert(binary_form=True))
            stream.sendall(('GET / HTTP/1.1\r\nHost: ' + target['hostname'] + '\r\nConnection: close\r\n\r\n').encode())
            reply = http.client.HTTPResponse(stream)
            reply.begin()
            body = reply.read(65537)
            facts = {'status': reply.status, 'bodyBytes': len(body), 'bodySha256': digest(body),
                     'tlsVerified': True, 'hostnameVerified': context.check_hostname,
                     'certificateRequired': context.verify_mode == ssl.CERT_REQUIRED,
                     'caSha256': digest(ca.read_bytes()), 'leafSha256': leaf,
                     'notBefore': certificate['notBefore'], 'notAfter': certificate['notAfter'],
                     'stableField': 'bodySha256', 'contentMatches': digest(body) == target['bodySha256']}
            result['https'] = facts
            require(reply.status == 200 and len(body) <= 65536 and facts['contentMatches'], 'GIT_HTTPS_CONTENT_CHANGED')
            require(facts['caSha256'] == before['identity']['caSha256'], 'HTTPS_CA_CHANGED')
            return facts

try:
    require(target['kind'] == 'application' and target['guest'] in ('a', 'b'), 'APPLICATION_TARGET_INVALID')
    result['before'] = image_snapshot()
    result['http'] = helper['request'](target, result['before'], False)
    require(result['http'].get('redirectMatches') is True, 'HTTP_REDIRECT_REQUIRED')
    result['https'] = https(result['before'])
    result['after'] = image_snapshot()
    require(result['before']['identity'] == result['after']['identity'], 'APPLICATION_IDENTITY_CHANGED_DURING_READ')
    result['status'] = 'passed'
except Exception as error:
    code = str(error)
    result['status'] = 'failed'
    result['failureCode'] = code if re.fullmatch(r'GMVP_CONTINUITY_[A-Z_]+', code) else (
        'GMVP_CONTINUITY_TLS_VERIFICATION_FAILED' if isinstance(error, ssl.SSLCertVerificationError)
        else 'GMVP_CONTINUITY_APPLICATION_READ_FAILED')
    if isinstance(error, ssl.SSLCertVerificationError):
        result['tlsVerifyCode'] = error.verify_code
    if hasattr(error, 'observation'):
        result['partialObservation'] = error.observation
result['finishedAt'] = datetime.now(timezone.utc).isoformat()
print(json.dumps(result))
`;

/** Stable only: excludes observation time, restarts, dynamic A body bytes, and rotating leaf certs. */
export function jointApplicationIdentity(report) {
  requireValue(report?.status === 'passed' && report.targets?.length === 2, 'REPORT_NOT_PASSED');
  return report.targets.map(({ target, observation }) => ({
    target,
    kubernetes: observation.before.identity,
    https: {
      status: observation.https.status,
      certificateAuthority: 'local_test',
      caSha256: observation.https.caSha256,
      contentKind: target.contentKind,
      contentSha256:
        target.contentKind === 'json-message'
          ? observation.https.stableValueSha256
          : observation.https.bodySha256,
    },
  }));
}

export function assertJointApplicationIdentity(before, after) {
  requireValue(
    isDeepStrictEqual(jointApplicationIdentity(before), jointApplicationIdentity(after)),
    'IDENTITY_CHANGED_BETWEEN_OBSERVATIONS',
  );
  return { status: 'passed', unchangedTargets: 2, sourceAndKubernetesAndContentPreserved: true };
}

/** readDb(sql, params) -> rows; command(label, binary, args, options) -> stdout. */
export async function observeJointApplications({ root, command, readDb, signal, installationId }) {
  requireValue(
    typeof root === 'string' &&
      uuid.test(installationId) &&
      typeof command === 'function' &&
      typeof readDb === 'function',
    'CALL_CONTRACT_INVALID',
  );
  signal?.throwIfAborted();
  const files = [
    'tests/probes/support/g-mvp-continuity-k3s.py',
    'docs/acceptance/s4-product-local-results.json',
    'docs/acceptance/s6-product-results.json',
    'docs/acceptance/s6-webhook-local-results.json',
  ];
  const [python, s4, product, webhook] = await Promise.all(
    files.map((path) => boundedSource(root, path)),
  );
  const published = {
    s4: JSON.parse(s4.raw),
    product: JSON.parse(product.raw),
    webhook: JSON.parse(webhook.raw),
  };
  requireValue(
    published.s4.status === 'passed' &&
      published.product.status === 'passed' &&
      published.webhook.status === 'passed' &&
      hex.test(published.webhook.runningDelivery.httpsBodySha256),
    'PUBLIC_BASELINE_INVALID',
  );
  const metadata = async () => {
    signal?.throwIfAborted();
    let rows;
    try {
      rows = await readDb(
        metadataSql,
        selections.map((item) => item.serviceId),
      );
    } catch {
      throw new Error('GMVP_JOINT_APPLICATION_METADATA_READ_FAILED');
    }
    requireValue(Array.isArray(rows) && rows.length === 2, 'METADATA_NOT_UNIQUE');
    const projected = selections.map((selection) => {
      const matches = rows.filter((row) => row.serviceId === selection.serviceId);
      requireValue(matches.length === 1, 'SERVICE_NOT_UNIQUE');
      return projectMetadata(matches[0], selection, installationId, published);
    });
    requireValue(
      projected[0].clusterId !== projected[1].clusterId &&
        projected[0].kubeSystemUid !== projected[1].kubeSystemUid &&
        projected[0].nodeUid !== projected[1].nodeUid,
      'CLUSTERS_NOT_DISTINCT',
    );
    return projected;
  };
  const targets = await metadata();
  const result = {
    version: 1,
    status: 'in-progress',
    startedAt: new Date().toISOString(),
    scope:
      'One bounded read-only A image / B Git K3s and strict local-CA application HTTPS observation. No deployment, Pod exec or resource mutation.',
    sources: [python, s4, product, webhook].map((item) => item.evidence),
    targets: [],
    limits: [
      'A/B share one physical Mac; this does not establish an external failure domain.',
      'The explicit local test CA is used; no public DNS or publicly trusted CA is inferred.',
      'Readiness and content apply only to these bounded observations, not every intervening instant.',
      'Image identity comes from the declared manifest and live Pod imageID; configDigest is retained registry metadata, not independently read from the node image store.',
    ],
  };
  const observed = await Promise.allSettled(
    targets.map(async (target) => {
      signal?.throwIfAborted();
      const input =
        `import json\nparameters = json.loads(${JSON.stringify(JSON.stringify({ target }))})\n` +
        `helper = {'__name__': 'g_mvp_continuity_helpers'}\n` +
        `exec(compile(${JSON.stringify(python.raw.toString('utf8'))}, '<retained-continuity-helper>', 'exec'), helper)\n` +
        applicationObservationPython;
      const stdout = await command(
        'joint-' + target.key + '-read',
        'ssh',
        [
          '-F',
          resolve(root, '.local/local-lab/credentials/ssh_config'),
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `UserKnownHostsFile=${resolve(root, '.local/local-lab/credentials/known_hosts')}`,
          '-o',
          'GlobalKnownHostsFile=/dev/null',
          '-o',
          'IdentitiesOnly=yes',
          '-o',
          'ClearAllForwardings=yes',
          '-o',
          'PermitLocalCommand=no',
          '-o',
          'RequestTTY=no',
          '-o',
          'ControlMaster=no',
          '-o',
          'ControlPath=none',
          '-o',
          'ConnectTimeout=4',
          '-o',
          'ConnectionAttempts=1',
          '-o',
          'ServerAliveInterval=2',
          '-o',
          'ServerAliveCountMax=2',
          'ozz-lab-' + target.guest,
          'sudo -n /usr/bin/python3 -I -B -',
        ],
        { input, timeoutMs: 60000, maximumBytes: 256 * 1024 },
      );
      let observation;
      try {
        observation = JSON.parse(stdout);
      } catch {
        throw new Error('GMVP_JOINT_APPLICATION_REMOTE_RESULT_INVALID');
      }
      requireValue(
        observation.version === 1 &&
          observation.key === target.key &&
          ['passed', 'failed'].includes(observation.status),
        'REMOTE_RESULT_INVALID',
      );
      return { target, observation };
    }),
  );
  result.targets = observed.map((row, index) =>
    row.status === 'fulfilled'
      ? row.value
      : {
          target: targets[index],
          observation: { status: 'failed', failureCode: 'GMVP_JOINT_APPLICATION_READ_FAILED' },
        },
  );
  try {
    requireValue(
      result.targets.every((row) => row.observation.status === 'passed'),
      'OBSERVATION_FAILED',
    );
    requireValue(
      isDeepStrictEqual(targets, await metadata()),
      'METADATA_CHANGED_DURING_OBSERVATION',
    );
    result.status = 'passed';
    result.stableIdentity = jointApplicationIdentity(result);
    return result;
  } catch (error) {
    result.status = 'failed';
    error.jointObservation = result;
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
  }
}
