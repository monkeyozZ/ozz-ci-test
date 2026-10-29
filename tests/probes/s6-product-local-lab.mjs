import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

// Real product API/Worker -> dedicated native Builder -> Distribution -> B K3s.
// GitHub's HTTPS API is a local protocol fixture; Git/BuildKit/OCI/TLS are real.
// Never fabricates a BuildRun, artifact, task result, readiness or registry check.
const root = resolve(import.meta.dirname, '../..');
const lab = resolve(root, '.local/local-lab');
const directory = resolve(lab, 's6-product');
const stateFile = resolve(directory, 'state.json');
const mode = process.argv[2];
if (!['prepare', 'publish', 'https'].includes(mode)) throw new Error('S6_PRODUCT_MODE_INVALID');
const retryTask = process.argv.find((value) => value.startsWith('--retry-task='))?.slice(13);
if (retryTask && !/^[0-9a-f-]{36}$/u.test(retryTask))
  throw new Error('S6_PRODUCT_RETRY_ID_INVALID');
const newPublishAfter = process.argv
  .find((value) => value.startsWith('--new-publish-after='))
  ?.slice(20);
if (
  newPublishAfter &&
  (mode !== 'publish' || retryTask || !/^[0-9a-f-]{36}$/u.test(newPublishAfter))
)
  throw new Error('S6_PRODUCT_NEW_PUBLISH_ID_INVALID');
const api = 'http://127.0.0.1:3000/api';
let origin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
const attempt = `${mode}-${new Date().toISOString().replaceAll(/[^0-9TZ]/gu, '')}-${randomUUID().slice(0, 8)}`;
const abort = new globalThis.AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const requireValue = (value, code) => {
  if (!value) throw new Error(code);
};
let cookie,
  csrf,
  state,
  lock,
  stage = 'preflight';
const report = {
  version: 1,
  attempt,
  mode,
  intent: newPublishAfter ? 'new-fixed-commit-publication' : retryTask ? 'retry' : mode,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope:
    'Actual local ARM64 product path with GitHub HTTPS fixture, dedicated Builder, real private Distribution and K3s. Public GitHub delivery, public DNS/ACME and VPS are not certified.',
  checks: [],
};

async function save() {
  await writeFile(`${stateFile}.next`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(`${stateFile}.next`, stateFile);
}
async function check(name, passed, evidence = {}) {
  requireValue(passed, 'S6_PRODUCT_ASSERTION_FAILED');
  const record = { name, status: 'passed', at: new Date().toISOString(), ...evidence };
  report.checks.push(record);
  state.checks.push(record);
  await save();
  console.log(JSON.stringify({ check: name, status: 'passed' }));
}
async function request(path, method = 'GET', body, key, expected) {
  const response = await fetch(api + path, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: globalThis.AbortSignal.any([abort.signal, globalThis.AbortSignal.timeout(20_000)]),
  });
  const value = response.status === 204 ? null : await response.json();
  if (expected ? response.status !== expected : !response.ok)
    throw Object.assign(new Error('S6_PRODUCT_API_FAILED'), {
      code: value?.code,
      status: response.status,
    });
  return { value, response };
}
const data = async (path) => (await request(path)).value.data;
async function command(label, path, body, expected = 202) {
  state.commands[label] ??= { path, body, key: randomUUID() };
  const intent = state.commands[label];
  requireValue(intent.path === path, 'S6_PRODUCT_COMMAND_TARGET_CHANGED');
  await save();
  const result = (await request(intent.path, 'POST', intent.body, intent.key, expected)).value.data;
  requireValue(!intent.id || intent.id === result.id, 'S6_PRODUCT_IDEMPOTENCY_CHANGED');
  intent.id = result.id;
  await save();
  return result;
}
async function resource(name, path, body) {
  if (state.resources[name]) return data(`${path}/${state.resources[name]}`);
  const created = (await request(path, 'POST', body, undefined, 201)).value.data;
  state.resources[name] = created.id;
  await save();
  return created;
}
async function waitFor(read, accept, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await delay(1000, undefined, { signal: abort.signal });
  }
  throw new Error('S6_PRODUCT_OBSERVATION_TIMEOUT');
}
async function waitTask(type, id) {
  let last;
  return waitFor(
    async () => {
      const task = await data(`/${type}/${id}`);
      const status = `${task.status}:${task.phase}:${task.errorCode}`;
      if (status !== last) {
        console.log(
          JSON.stringify({
            task: id,
            status: task.status,
            phase: task.phase,
            code: task.errorCode,
          }),
        );
        last = status;
      }
      if (['failed', 'cancelled'].includes(task.status)) {
        await writeFile(
          resolve(directory, `${attempt}-task-${id}.json`),
          `${JSON.stringify(task, null, 2)}\n`,
          { mode: 0o600 },
        );
        throw Object.assign(new Error('S6_PRODUCT_TASK_FAILED'), {
          code: task.errorCode,
          taskId: id,
        });
      }
      return task;
    },
    (task) => task.status === 'succeeded',
    1_260_000,
  );
}
async function phase(name, action) {
  stage = name;
  console.log(JSON.stringify({ stage }));
  return action();
}

async function prepare(metadata) {
  const runtime = JSON.parse(await readFile(resolve(root, '.local/s3-runtime.json'), 'utf8'));
  let workerAlive = false;
  if (Number.isInteger(runtime.worker) && runtime.worker > 1) {
    try {
      process.kill(runtime.worker, 0);
      workerAlive = true;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  requireValue(!workerAlive, 'S6_PRODUCT_PREPARE_REQUIRES_API_ONLY');
  const suffix = state.id.slice(0, 8);
  const github = await phase('github-authorization', async () => {
    const payload = JSON.parse(await readFile(resolve(lab, 's6-github/product/pat.json'), 'utf8'));
    const secret = await resource('gitSecret', '/secrets', {
      name: `S6 Git PAT ${suffix}`,
      kind: 'git',
      payload,
    });
    let connection = await resource('github', '/integrations/github', {
      name: `本地 GitHub ${suffix}`,
      credentialRefId: secret.id,
    });
    if (connection.verification.state !== 'verified')
      connection = (
        await request(
          `/integrations/github/${connection.id}/verify`,
          'POST',
          { revision: connection.revision },
          undefined,
          200,
        )
      ).value.data;
    requireValue(connection.verification.state === 'verified', 'S6_PRODUCT_GITHUB_NOT_VERIFIED');
    const repositories = await data(`/integrations/github/${connection.id}/repositories`);
    const repository = repositories.find(
      (item) => item.githubRepositoryId === metadata.repositoryId,
    );
    requireValue(repository?.fullName === metadata.fullName, 'S6_PRODUCT_REPOSITORY_MISMATCH');
    state.resources.repository = repository.id;
    const branches = await data(
      `/integrations/github/${connection.id}/repositories/${repository.id}/branches`,
    );
    requireValue(
      branches.some(
        (item) => item.name === metadata.branch && item.commitSha === metadata.initialSha,
      ),
      'S6_PRODUCT_INITIAL_COMMIT_MISMATCH',
    );
    await check('authorized-repository-and-real-git-head', true, {
      githubConnectionId: connection.id,
      repositoryId: repository.id,
      commitSha: metadata.initialSha,
    });
    return connection;
  });
  await phase('registry-credentials-and-queued-probe', async () => {
    const registryDirectory = resolve(lab, 's6-registry');
    const credentialsFile = resolve(registryDirectory, 'users.json');
    const users = JSON.parse(await readFile(credentialsFile, 'utf8'));
    requireValue(
      users.owner === 'ozz-s6-registry-token-fixture-v1',
      'S6_PRODUCT_REGISTRY_OWNER_INVALID',
    );
    const caCertificate = await readFile(resolve(registryDirectory, 'ca.crt'), 'utf8');
    const references = {};
    for (const role of ['push', 'pull']) {
      const user = users.users.find((item) => item.username === `ozz-s6-${role}`);
      requireValue(user, 'S6_PRODUCT_REGISTRY_USER_MISSING');
      const secret = await resource(`${role}Secret`, '/secrets', {
        name: `S6 Registry ${role} ${suffix}`,
        kind: 'registry',
        payload: {
          registry: 'host.lima.internal:50444',
          username: user.username,
          password: user.password,
          caCertificate,
          tokenServiceOrigins: ['https://host.lima.internal:51445'],
        },
      });
      references[`${role}CredentialRefId`] = secret.id;
    }
    const registry = await resource('registry', '/integrations/registries', {
      name: `本地私有镜像仓库 ${suffix}`,
      authority: 'host.lima.internal:50444',
      namespace: 'ozz-s6',
      ...references,
    });
    const operation = await command(
      'verify-registry',
      `/integrations/registries/${registry.id}/verify`,
      { revision: registry.revision },
    );
    requireValue(operation.status === 'queued', 'S6_PRODUCT_REGISTRY_PROBE_STARTED_EARLY');
    const repository = `ozz-s6/ozz-probe-${operation.id}`;
    requireValue(
      operation.input?.probeRepository === repository,
      'S6_PRODUCT_PROBE_TARGET_INVALID',
    );
    await copyFile(credentialsFile, resolve(registryDirectory, `${attempt}-acl-before.json`), 1);
    for (const user of users.users) {
      if (user.repositories.some((item) => item.name === repository)) continue;
      const template = user.repositories.find((item) => item.name === 'ozz-s6/probe');
      requireValue(template && user.repositories.length < 16, 'S6_PRODUCT_REGISTRY_ACL_LIMIT');
      user.repositories.push({ name: repository, actions: [...template.actions] });
    }
    const next = resolve(registryDirectory, `${attempt}-acl.next`);
    await writeFile(next, `${JSON.stringify(users, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(next, credentialsFile);
    await check('exact-operation-probe-authorized-before-worker-start', true, {
      operationId: operation.id,
      repository,
      separatePushPullReferences: references.pushCredentialRefId !== references.pullCredentialRefId,
    });
  });
  await phase('builder-registration-and-live-verification', async () => {
    const base = resolve(lab, 'builder');
    const config = JSON.parse(await readFile(resolve(base, 'operator-config.json'), 'utf8'));
    const lock = JSON.parse(
      await readFile(resolve(root, 'infra/builder/assets.lock.json'), 'utf8'),
    );
    const secret = await resource('builderSecret', '/secrets', {
      name: `S6 Builder mTLS ${suffix}`,
      kind: 'builder',
      payload: {
        caCertificate: await readFile(resolve(base, 'pki/ca.crt'), 'utf8'),
        clientCertificate: await readFile(resolve(base, 'pki/client.crt'), 'utf8'),
        clientPrivateKey: await readFile(resolve(base, 'pki/client.key'), 'utf8'),
      },
    });
    let builder = await resource('builder', '/integrations/builders', {
      name: `独立 Linux 构建器 ${suffix}`,
      instanceId: config.instanceId,
      identityPublicKey: await readFile(resolve(base, 'identity-public-key.pem'), 'utf8'),
      endpoint: 'https://127.0.0.1:49443',
      credentialRefId: secret.id,
      profile: { buildkitVersion: 'v0.25.1', frontendDigest: lock.frontend.digest },
    });
    builder = (
      await request(
        `/integrations/builders/${builder.id}/verify`,
        'POST',
        { revision: builder.revision },
        undefined,
        200,
      )
    ).value.data;
    await check(
      'registered-builder-has-live-signed-capabilities',
      builder.verification.state === 'verified' &&
        builder.capabilities?.highGeneration === config.generation,
      {
        builderId: builder.id,
        instanceId: builder.instanceId,
        platform: builder.capabilities?.platform,
      },
    );
  });
  await phase('project-inherits-application-cluster-b', async () => {
    const registered = JSON.parse(await readFile(resolve(lab, 'product-state.json'), 'utf8'));
    const project = await resource('project', '/projects', {
      name: `源码构建验证 ${suffix}`,
      slug: `s6-git-${suffix}`,
      clusterId: registered.clusters.b,
      description: 'S6 本地 GitHub 协议、独立 BuildKit、私有 Registry 与 HTTPS 发布验证。',
    });
    const environments = await data(`/environments?projectId=${project.id}&limit=100`);
    const environment = environments.find((item) => item.slug === 'production');
    requireValue(
      environment && project.clusterId === registered.clusters.b,
      'S6_PRODUCT_PROJECT_TARGET_MISMATCH',
    );
    state.resources.environment = environment.id;
    state.resources.cluster = registered.clusters.b;
    state.githubConnectionId = github.id;
    await save();
  });
  report.status = 'prepared';
}

async function publish(metadata) {
  await phase('real-registry-permission-operation', async () => {
    const task = await waitTask('operations', state.commands['verify-registry'].id);
    const registry = await data(`/integrations/registries/${state.resources.registry}`);
    await check(
      'product-registry-push-pull-and-denial-verified',
      registry.pushVerification.state === 'verified' &&
        registry.pullVerification.state === 'verified' &&
        task.result?.pullCannotPush === true,
      { operationId: task.id, registryConnectionId: registry.id, result: task.result },
    );
  });
  await phase('create-git-service-without-placeholder-image', async () => {
    const slug = `source-app-${state.id.slice(0, 8)}`;
    if (!state.resources.service) {
      const matches = (
        await data(`/services?environmentId=${state.resources.environment}&limit=100`)
      ).filter((item) => item.slug === slug);
      requireValue(matches.length <= 1, 'S6_PRODUCT_SERVICE_RECOVERY_AMBIGUOUS');
      if (matches.length === 1) {
        const previous = matches[0];
        requireValue(
          previous.projectId === state.resources.project &&
            previous.clusterId === state.resources.cluster &&
            previous.source.kind === 'github' &&
            previous.source.currentRevision.repository.repositoryId ===
              state.resources.repository &&
            previous.source.currentRevision.builder.builderId === state.resources.builder &&
            previous.source.currentRevision.destination.registryConnectionId ===
              state.resources.registry,
          'S6_PRODUCT_SERVICE_RECOVERY_IDENTITY_MISMATCH',
        );
        state.resources.service = previous.id;
        await save();
      }
    }
    if (!state.resources.service) {
      const created = await command(
        'create-git-service',
        '/services',
        {
          projectId: state.resources.project,
          environmentId: state.resources.environment,
          name: 'GitHub 示例应用',
          slug,
          configuration: {
            replicas: 1,
            command: [],
            args: [],
            ports: [{ name: 'http', protocol: 'http', containerPort: 80, servicePort: 80 }],
            resources: {
              requests: { cpuMillis: 50, memoryMiB: 64 },
              limits: { cpuMillis: 250, memoryMiB: 256 },
            },
            readiness: {
              type: 'http',
              port: 'http',
              path: '/',
              initialDelaySeconds: 0,
              periodSeconds: 3,
              timeoutSeconds: 2,
              failureThreshold: 5,
            },
            startup: null,
            healthTimeoutSeconds: 180,
            environment: [],
          },
          source: {
            kind: 'github',
            repositoryId: state.resources.repository,
            branchRef: `refs/heads/${metadata.branch}`,
            dockerfilePath: 'Dockerfile',
            contextPath: '.',
            buildArgs: {},
            buildSecrets: [],
            platforms: [{ os: 'linux', architecture: 'arm64' }],
            builderId: state.resources.builder,
            registryConnectionId: state.resources.registry,
            imageRepository: 'application',
            autoDeploy: true,
          },
        },
        201,
      );
      state.resources.service = created.id;
      await save();
    }
    const service = await data(`/services/${state.resources.service}`);
    await check(
      'git-service-has-fixed-inherited-target-and-no-image-field',
      service.source.kind === 'github' &&
        !Object.hasOwn(service.configuration, 'image') &&
        service.clusterId === state.resources.cluster,
      {
        serviceId: service.id,
        projectId: service.projectId,
        environmentId: service.environmentId,
        clusterId: service.clusterId,
      },
    );
  });
  await phase('fixed-commit-preview-and-managed-build', async () => {
    const current = await data(`/services/${state.resources.service}`);
    if (!state.firstDeploymentId) {
      const preview = (
        await request(
          `/services/${current.id}/git-source/preview`,
          'POST',
          {
            revision: current.revision,
            selection: { kind: 'commit', commitSha: metadata.initialSha },
          },
          undefined,
          200,
        )
      ).value.data;
      requireValue(
        preview.source.commitSha === metadata.initialSha && preview.issues.length === 0,
        'S6_PRODUCT_PREVIEW_NOT_READY',
      );
      state.firstPreviewId = preview.id;
      await save();
      const deployment = await command('first-deploy', `/services/${current.id}/deployments`, {
        revision: preview.serviceRevision,
        previewId: preview.id,
      });
      state.firstDeploymentId = deployment.id;
      await save();
    }
    if (retryTask) {
      requireValue(retryTask === state.firstDeploymentId, 'S6_PRODUCT_RETRY_NOT_CURRENT_TASK');
      const failed = await data(`/deployments/${retryTask}`);
      requireValue(failed.status === 'failed', 'S6_PRODUCT_RETRY_REQUIRES_FAILURE');
      const service = await data(`/services/${state.resources.service}`);
      const retried = await command(`retry:${retryTask}`, `/deployments/${retryTask}/retry`, {
        revision: service.revision,
      });
      state.firstDeploymentId = retried.id;
      await save();
    }
    if (newPublishAfter) {
      requireValue(
        newPublishAfter === state.firstDeploymentId,
        'S6_PRODUCT_NEW_PUBLISH_NOT_CURRENT_TASK',
      );
      const failed = await data(`/deployments/${newPublishAfter}`);
      requireValue(failed.status === 'failed', 'S6_PRODUCT_NEW_PUBLISH_REQUIRES_FAILURE');
      const service = await data(`/services/${state.resources.service}`);
      const preview = (
        await request(
          `/services/${service.id}/git-source/preview`,
          'POST',
          {
            revision: service.revision,
            selection: { kind: 'commit', commitSha: metadata.initialSha },
          },
          undefined,
          200,
        )
      ).value.data;
      requireValue(
        preview.source.commitSha === metadata.initialSha && preview.issues.length === 0,
        'S6_PRODUCT_NEW_PREVIEW_NOT_READY',
      );
      // An explicit new publication after a Builder fix is distinct from retry:
      // retry must continue to use the old immutable artifact, even if it was bad.
      const published = await command(
        `new-fixed-publication:${newPublishAfter}`,
        `/services/${service.id}/deployments`,
        { revision: preview.serviceRevision, previewId: preview.id },
      );
      state.firstPreviewId = preview.id;
      state.firstDeploymentId = published.id;
      await save();
    }
    const task = await waitTask('deployments', state.firstDeploymentId);
    const service = await waitFor(
      () => data(`/services/${state.resources.service}`),
      (value) => value.runtimeState === 'running' && value.published?.deploymentId === task.id,
    );
    const build = task.build;
    await writeFile(
      resolve(directory, `${attempt}-published.json`),
      `${JSON.stringify({ task, service, build }, null, 2)}\n`,
      { mode: 0o600 },
    );
    requireValue(
      task.snapshot?.version === 3 &&
        task.snapshot.source.commitSha === metadata.initialSha &&
        service.published.source.commitSha === metadata.initialSha,
      'S6_PRODUCT_PUBLISHED_SOURCE_MISMATCH',
    );
    requireValue(
      service.published.image?.deployReference?.startsWith(
        'host.lima.internal:50444/ozz-s6/application@sha256:',
      ),
      'S6_PRODUCT_PUBLISHED_IMAGE_MISMATCH',
    );
    requireValue(
      build?.runs.length > 0 &&
        build.runs.every(
          (run) => run.executionState === 'ended' && run.executionClosedAt && run.proofVerifiedAt,
        ) &&
        build.artifact.state === 'registry' &&
        build.artifact.commitSha === metadata.initialSha &&
        service.published.image.deployReference.endsWith(`@${build.artifact.rootDigest}`),
      'S6_PRODUCT_BUILD_PROOF_OR_ARTIFACT_MISMATCH',
    );
    state.firstImage = service.published.image.deployReference;
    state.initialSha = metadata.initialSha;
    await check(
      'real-build-produced-digest-and-ready-pod',
      service.observation?.pods.some((pod) => pod.ready && !pod.deletionTimestamp),
      {
        deploymentId: task.id,
        commitSha: metadata.initialSha,
        image: state.firstImage,
        serviceId: service.id,
      },
    );
  });
  report.status = 'passed';
}

async function https(metadata) {
  await phase('bind-default-domain-through-product-task', async () => {
    const networking = await data(`/services/${state.resources.service}/networking`);
    if (!state.resources.domain) {
      const port = networking.eligiblePorts.find((item) => item.name === 'http');
      requireValue(port, 'S6_PRODUCT_HTTP_PORT_NOT_ELIGIBLE');
      const task = await command(
        'bind-default-domain',
        `/services/${state.resources.service}/domains`,
        { revision: networking.serviceRevision, portId: port.id },
      );
      requireValue(task.input?.domainId, 'S6_PRODUCT_DOMAIN_ID_MISSING');
      state.resources.domain = task.input.domainId;
      await save();
    }
    await waitTask('operations', state.commands['bind-default-domain'].id);
    const domain = await waitFor(
      () => data(`/domains/${state.resources.domain}`),
      (item) =>
        item.dns?.state === 'matched' &&
        item.route?.state === 'ready' &&
        ['staging_ready', 'ready'].includes(item.certificate?.state) &&
        !item.observationStale,
    );
    const fixture = JSON.parse(await readFile(resolve(lab, 'networking-lab/state.json'), 'utf8'));
    requireValue(
      fixture.owner === 'ozz-local-networking-lab-v1' && fixture.ip === '192.168.5.15',
      'S6_PRODUCT_NETWORK_FIXTURE_CHANGED',
    );
    const program = `import hashlib,http.client,json,socket,ssl,sys\nfrom pathlib import Path\nv=json.load(sys.stdin)\nassert Path('/etc/ozz-local-lab-instance').read_text().strip()=='ozz-lab-b'\nhost=v['hostname']\nassert host.endswith('.apps.ozz.test') and all(c.isalnum() or c in '.-' for c in host)\nassert v['environment'] in ('staging','production')\ncontext=ssl.create_default_context(cafile='/var/lib/ozz-local-lab/b/networking-v1/'+v['environment']+'-signing-root.pem')\nwith socket.create_connection((v['ip'],443),timeout=8) as raw:\n with context.wrap_socket(raw,server_hostname=host) as stream:\n  fingerprint=hashlib.sha256(stream.getpeercert(binary_form=True)).hexdigest()\n  stream.sendall(('GET / HTTP/1.1\\r\\nHost: '+host+'\\r\\nConnection: close\\r\\n\\r\\n').encode())\n  reply=http.client.HTTPResponse(stream);reply.begin();body=reply.read(65537)\n  assert len(body)<=65536\n  result={'httpsStatus':reply.status,'hostnameVerified':True,'localChainVerified':True,'certificateSha256':fingerprint,'bodySha256':hashlib.sha256(body).hexdigest(),'markerMatched':v['marker'].encode() in body}\nprint(json.dumps(result))\n`;
    const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    const job = promisify(execFile)(
      'ssh',
      [
        '-F',
        resolve(lab, 'credentials/ssh_config'),
        'ozz-lab-b',
        `sudo python3 -c ${shellQuote(program)}`,
      ],
      { cwd: root, timeout: 20_000, maxBuffer: 16_384 },
    );
    job.child.stdin.end(
      JSON.stringify({
        hostname: domain.hostname,
        environment: domain.certificateEnvironment,
        ip: fixture.ip,
        marker: metadata.marker,
      }),
    );
    const actual = JSON.parse((await job).stdout);
    await check(
      'https-content-matches-fixed-source-commit',
      actual.httpsStatus === 200 &&
        actual.markerMatched &&
        actual.localChainVerified &&
        actual.hostnameVerified,
      {
        ...actual,
        hostname: domain.hostname,
        domainId: domain.id,
        commitSha: metadata.initialSha,
        image: state.firstImage,
        certificateAuthority: domain.certificate.authority,
      },
    );
    state.hostname = domain.hostname;
    await save();
  });
  report.status = 'passed';
}

try {
  process.umask(0o077);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  lock = await open(`${stateFile}.lock`, 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, attempt }));
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  state ??= { version: 1, id: randomUUID(), resources: {}, commands: {}, checks: [] };
  requireValue(state.version === 1, 'S6_PRODUCT_STATE_INVALID');
  await save();
  const metadata = JSON.parse(
    await readFile(resolve(lab, 's6-github/product/metadata.json'), 'utf8'),
  );
  requireValue(
    metadata.repositoryId === '100001' &&
      /^[a-f0-9]{40}$/u.test(metadata.initialSha) &&
      metadata.cloneOrigin === 'https://host.lima.internal:51446',
    'S6_PRODUCT_GIT_FIXTURE_INVALID',
  );
  requireValue(
    metadata.publicAppOrigin === 'https://127.0.0.1:51448',
    'S6_PRODUCT_HTTPS_ORIGIN_REQUIRED',
  );
  origin = metadata.publicAppOrigin;
  const password = (await readFile(resolve(root, '.secrets/admin-password'), 'utf8')).trim();
  const login = await request('/auth/login', 'POST', { username: 'admin', password });
  cookie = login.response.headers
    .getSetCookie()
    .find((value) => value.startsWith('ozz_session='))
    ?.split(';')[0];
  csrf = login.value.data.csrfToken;
  requireValue(cookie && csrf, 'S6_PRODUCT_LOGIN_FAILED');
  if (mode === 'prepare') await prepare(metadata);
  if (mode === 'publish') await publish(metadata);
  if (mode === 'https') await https(metadata);
} catch (error) {
  report.status = 'failed';
  const code = error.code ?? error.message;
  report.failure = {
    stage,
    code: /^[A-Z][A-Z0-9_]+$/u.test(code ?? '') ? code : 'S6_PRODUCT_UNEXPECTED_FAILURE',
    taskId: error.taskId ?? null,
    httpStatus: error.status ?? null,
  };
  console.error(JSON.stringify(report.failure));
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.resources = state?.resources;
  if (lock) {
    await save();
    await lock.close();
    await unlink(`${stateFile}.lock`);
  }
  const output = resolve(directory, `${attempt}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(
    JSON.stringify({ status: report.status, checks: report.checks.length, report: output }),
  );
}
