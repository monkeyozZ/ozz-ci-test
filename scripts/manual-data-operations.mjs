import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  MANUAL_DATA_VERSION,
  MAX_ARTIFACT_BYTES,
  date,
  digestJson,
  fail,
  newTarget,
  outputDirectory,
  privateJson,
  publishJson,
  publishNew,
  retainedFailure,
  sameIdentity,
} from './manual-data-core.mjs';
import {
  engine,
  inspectArtifact,
  sealBundle,
  verifyBundle,
  verifyCopyReceipt,
} from './manual-data-artifact.mjs';
import { fixedCommand, probes } from './manual-data-commands.mjs';
import { executeChannel } from './manual-data-exec.mjs';
import {
  createHelper,
  deleteHelper,
  openManualSession,
  verifyHelper,
} from './manual-data-runtime.mjs';
import { inspectTar } from './manual-data-tar.mjs';
import {
  comparePostgres,
  compareRedis,
  expectedProof,
  outputJson,
  postgresEmpty,
  postgresProof,
  redisProof,
  redisStatus,
} from './manual-data-verification.mjs';

export async function runFixed(session, mode, helper, operation, values = {}, options = {}) {
  if (session.cleanupOnly && !['pg-stop-if-running', 'redis-stop-if-running'].includes(operation))
    fail('MANUAL_CLEANUP_ONLY', '清理会话不能运行备份或导入命令。');
  const before = await session.checkpoint(mode, { helper });
  const selection = helper
    ? { namespace: helper.namespace, name: helper.name }
    : { namespace: before.fence.namespace, name: before.pod?.metadata.name };
  if (!selection.name) fail('MANUAL_EXEC_POD_REQUIRED', '缺少已验证的执行 Pod。');
  if (helper)
    verifyHelper(
      await session.kube(`/api/v1/namespaces/${helper.namespace}/pods/${helper.name}`),
      helper,
    );
  const result = await executeChannel(
    session.connection,
    selection,
    fixedCommand(operation, values),
    options,
  );
  const after = await session.checkpoint(mode, { helper });
  if (helper)
    verifyHelper(
      await session.kube(`/api/v1/namespaces/${helper.namespace}/pods/${helper.name}`),
      helper,
    );
  else if (
    before.pod.metadata.uid !== after.pod?.metadata.uid ||
    before.pod.status?.containerStatuses?.[0]?.containerID !==
      after.pod.status?.containerStatuses?.[0]?.containerID
  )
    fail('MANUAL_EXEC_POD_CHANGED', '执行期间 Pod 或容器身份变化；不接受成功结果。');
  return result;
}
function progressWriter(directory, operationId, progress) {
  let index = 0;
  return async (stage, details = {}) => {
    index++;
    await publishJson(resolve(directory, `stage-${String(index).padStart(2, '0')}.json`), {
      operationId,
      stage,
      observedAt: new Date().toISOString(),
      ...details,
    });
    progress?.({ operationId, stage });
  };
}
export async function backupManual(
  contextFile,
  parent,
  { operationId = randomUUID(), progress } = {},
) {
  const startedAt = new Date().toISOString(),
    directory = await outputDirectory(parent, operationId),
    stage = progressWriter(directory, operationId, progress);
  let session,
    activeStage = 'preflight';
  try {
    session = await openManualSession(contextFile);
    const kind = session.config.engine,
      fixed = engine(kind),
      definition = probes(kind, session.config.probes),
      mode = kind === 'files' ? 'backup' : 'online';
    const source = await session.checkpoint(mode),
      pending = resolve(directory, `${fixed.file}.pending`);
    await publishJson(resolve(directory, 'operation-intent.json'), {
      formatVersion: 1,
      type: 'backup',
      operationId,
      toolVersion: MANUAL_DATA_VERSION,
      source: session.config.expectedIdentity,
      sourceServiceId: session.config.serviceId,
      sourceFence: source.fence,
      engine: kind,
      probes: definition,
      startedAt,
    });
    let validation, dataTime, steps;
    if (kind === 'postgresql') {
      activeStage = 'postgresql-exported-snapshot';
      await stage(activeStage);
      await runFixed(
        session,
        mode,
        null,
        'pg-backup',
        { operationId, probes: definition },
        { outputFile: pending, maximum: MAX_ARTIFACT_BYTES },
      );
      const metadata = outputJson(
        await runFixed(session, mode, null, 'pg-backup-metadata', { operationId }),
      );
      if (typeof metadata.snapshot !== 'string' || !/^[a-fA-F0-9-]{3,100}$/.test(metadata.snapshot))
        fail('MANUAL_POSTGRES_SNAPSHOT', '缺少可确认的导出快照标识。');
      validation = postgresProof(metadata.observation, definition, source.database);
      dataTime = {
        from: date(metadata.observation.transactionStartedAt),
        to: date(metadata.observation.observedAt),
        description:
          'pg_dump 与选定表/约束检查使用同一个导出的 REPEATABLE READ 快照；时间为快照获取范围，非文件 mtime。',
      };
      await publishJson(resolve(directory, 'snapshot-evidence.json'), {
        snapshot: metadata.snapshot,
        dataTime,
        validation,
      });
      steps = [
        '核对产品与 Kubernetes 的集群、PVC/PV、Node、已发布 StatefulSet 和 Pod UID',
        '错误密码被拒绝；使用运行期凭证认证',
        'pg_export_snapshot 保持事务，pg_dump custom 与内容/结构检查共享快照',
        '固定 pg_restore --list 通过；产物 SHA256 与大小完成校验',
      ];
    } else if (kind === 'redis') {
      if (definition.database !== source.database.connection.redisDatabase)
        fail('MANUAL_REDIS_DATABASE', '验证的 Redis DB 必须与固定数据库身份相同。');
      activeStage = 'redis-authenticated-rdb';
      await stage(activeStage);
      const status = redisStatus(await runFixed(session, mode, null, 'redis-status'));
      const before = redisProof(
        outputJson(await runFixed(session, mode, null, 'redis-probe', { probes: definition })),
        definition,
      );
      await runFixed(
        session,
        mode,
        null,
        'redis-backup',
        { operationId },
        { outputFile: pending, maximum: MAX_ARTIFACT_BYTES },
      );
      const after = redisProof(
        outputJson(await runFixed(session, mode, null, 'redis-probe', { probes: definition })),
        definition,
      );
      const comparison = compareRedis(before, after);
      redisStatus(await runFixed(session, mode, null, 'redis-status'));
      validation = before;
      dataTime = {
        from: null,
        to: new Date(after.observedAtMs).toISOString(),
        description:
          '认证复制导出一致性 RDB；服务器可能复用正在生成的快照，精确时点未证实。采集前后固定键及绝对过期时间已比较；不是文件 mtime。',
      };
      await publishJson(resolve(directory, 'snapshot-evidence.json'), {
        status,
        before,
        after,
        comparison,
        exportStartedAfter: new Date(before.observedAtMs).toISOString(),
        exportCompletedBefore: new Date(after.observedAtMs).toISOString(),
      });
      steps = [
        '核对产品与 Kubernetes 的集群、PVC/PV、Node、StatefulSet 与 Pod UID',
        '错误密码被拒绝；源 Redis 仍为 AOF everysec',
        '认证 redis-cli --rdb 导出；固定 redis-check-rdb 语义和校验和验证通过',
        '比较采集前后指定字符串键的类型、GET 字节 SHA256 与绝对 TTL；已过期键按实际时间处理',
        '产物 SHA256 与大小完成校验',
      ];
    } else {
      activeStage = 'stopped-volume-read-only-archive';
      await stage(activeStage);
      const helper = await createHelper(session, source, 'files', operationId, directory, true);
      const version = (await runFixed(session, mode, helper, 'files-version')).stdout
        .toString('utf8')
        .trim();
      if (version !== 'tar (GNU tar) 1.34')
        fail('MANUAL_TOOL_VERSION', 'GNU tar 实际版本与固定工具镜像不匹配。');
      await runFixed(
        session,
        mode,
        helper,
        'files-backup',
        {},
        { outputFile: pending, maximum: MAX_ARTIFACT_BYTES },
      );
      validation = await inspectTar(pending);
      if (!validation.root) fail('MANUAL_TAR_ROOT', '文件备份必须记录卷根目录的 UID/GID 和权限。');
      await deleteHelper(session, helper, mode);
      dataTime = {
        from: startedAt,
        to: new Date().toISOString(),
        description:
          'Service 停止、零其他实际挂载、backup 维护保护下，以只读 PVC helper 采集。停写期间内容和权限清单一致。',
      };
      steps = [
        'Service 已停止，全部实际 PVC 挂载列表完整，backup 维护身份持续有效',
        '只读 PVC helper；未设置源卷 fsGroup；GNU tar 1.34 USTAR 归档',
        '拒绝 traversal、绝对路径、全部链接、设备、FIFO、扩展/稀疏记录及重复路径',
        '逐条验证内容 SHA256、UID/GID、权限与展开总大小',
        'helper 已按 nonce/UID/版本删除并确认消失；维护仍保留',
      ];
    }
    activeStage = 'artifact-publication';
    await stage(activeStage);
    await inspectArtifact(pending, kind);
    await session.checkpoint(mode);
    await publishNew(pending, resolve(directory, fixed.file));
    const result = await sealBundle(directory, {
      backupId: operationId,
      source: session.config.expectedIdentity,
      sourceServiceId: session.config.serviceId,
      sourceFence: source.fence,
      engine: kind,
      startedAt,
      completedAt: new Date().toISOString(),
      dataTime,
      writersStopped: kind === 'files',
      validation,
      verificationSteps: steps,
    });
    await stage('complete', {
      sha256: result.manifest.sha256,
      sizeBytes: result.manifest.sizeBytes,
      maintenanceReleased: false,
    });
    return result;
  } catch (error) {
    await retainedFailure(directory, error, activeStage);
    throw error;
  } finally {
    session?.close();
  }
}
function backupFields(manifest) {
  return {
    backupId: manifest.backupId,
    source: manifest.source,
    sourceServiceId: manifest.sourceServiceId,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    dataLayout: manifest.dataLayout,
    format: manifest.format,
    toolVersion: MANUAL_DATA_VERSION,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    dataTime: manifest.dataTime,
  };
}
export async function restoreManual(
  contextFile,
  bundleDirectory,
  copyReceiptFile,
  parent,
  { operationId = randomUUID(), progress } = {},
) {
  const startedAt = new Date().toISOString(),
    directory = await outputDirectory(parent, operationId),
    stage = progressWriter(directory, operationId, progress);
  let session,
    activeStage = 'preflight',
    base = null;
  try {
    const bundle = await verifyBundle(bundleDirectory),
      manifest = bundle.manifest,
      copy = await verifyCopyReceipt(bundle, copyReceiptFile);
    expectedProof(manifest.engine, manifest.validation);
    session = await openManualSession(contextFile);
    if (session.config.engine !== manifest.engine)
      fail('MANUAL_ENGINE_MISMATCH', '恢复目标的引擎与备份不同。');
    const definition =
      manifest.engine === 'files' ? {} : probes(manifest.engine, manifest.validation.definition);
    if (digestJson(probes(manifest.engine, session.config.probes)) !== digestJson(definition))
      fail('MANUAL_PROBES_MISMATCH', '目标上下文必须使用备份的同一组验证表或键。');
    newTarget(
      manifest.source,
      session.config.expectedIdentity,
      manifest.sourceServiceId,
      session.config.serviceId,
    );
    const target = await session.checkpoint('restore');
    if (
      !Number.isFinite(Date.parse(target.service.createdAt)) ||
      !Number.isFinite(Date.parse(target.volume.createdAt)) ||
      Date.parse(target.service.createdAt) < Date.parse(manifest.completedAt) ||
      Date.parse(target.volume.createdAt) < Date.parse(manifest.completedAt)
    )
      fail(
        'MANUAL_TARGET_NOT_NEW',
        '目标 Service 和 Volume 必须在备份完成后新建；失败目标不重复导入。',
      );
    if (target.database?.consumers?.length)
      fail('MANUAL_TARGET_HAS_CONSUMERS', '新数据库尚不能绑定消费者；先完成恢复与正式验证。');
    if (
      manifest.engine === 'redis' &&
      definition.database !== target.database.connection.redisDatabase
    )
      fail('MANUAL_REDIS_DATABASE', '目标 Redis DB 编号必须与备份相同。');
    base = {
      formatVersion: 1,
      kind: 'manual-restore',
      operationId,
      ...backupFields(manifest),
      target: session.config.expectedIdentity,
      targetServiceId: session.config.serviceId,
      targetFence: target.fence,
      manifestSha256: bundle.manifestSha256,
      offHostLocationLabel: copy.locationLabel,
      startedAt,
      integrity: 'passed',
    };
    await publishJson(resolve(directory, 'operation-intent.json'), {
      ...base,
      state: 'incomplete',
      result: 'incomplete',
      maintenanceReleased: false,
    });
    activeStage = 'helper-and-artifact-validation';
    await stage(activeStage);
    const helper = await createHelper(session, target, manifest.engine, operationId, directory);
    await runFixed(
      session,
      'restore',
      helper,
      'upload',
      { operationId },
      { inputFile: bundle.artifact },
    );
    outputJson(
      await runFixed(session, 'restore', helper, 'validate-upload', {
        operationId,
        engine: manifest.engine,
        sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes,
      }),
    );
    const steps = [
      '重新验证离机副本的清单、产物 SHA256 和字节数（物理位置由操作者陈述）',
      '新 Service、Volume、PVC UID 与源不同；创建时间晚于备份；源数据保留',
      'restore 维护持续有效；全量实际 Pod/VolumeAttachment 检查无其他挂载',
      'helper 复用固定镜像和已验证 Secret 引用，数据库只监听 127.0.0.1',
      'helper 内再次比对产物 SHA256/大小并运行引擎格式验证',
    ];
    let comparison = null;
    if (manifest.engine === 'postgresql') {
      activeStage = 'postgresql-empty-target-import';
      await stage(activeStage);
      postgresEmpty(
        outputJson(await runFixed(session, 'restore', helper, 'pg-start')),
        target.database,
      );
      await runFixed(session, 'restore', helper, 'pg-import', { operationId });
      const actual = postgresProof(
        outputJson(await runFixed(session, 'restore', helper, 'pg-probe', { probes: definition })),
        definition,
        target.database,
      );
      comparePostgres(manifest.validation, actual);
      await publishJson(resolve(directory, 'import-comparison.json'), {
        expected: manifest.validation,
        actual,
        matched: true,
      });
      await runFixed(session, 'restore', helper, 'pg-stop');
      steps.push(
        '新目标认证、实际 PostgreSQL 17.11 和空库检查通过',
        'pg_restore --single-transaction --exit-on-error --no-owner --no-acl 完成',
        '用户表结构及选定表的全部行/关键值/列/约束摘要匹配',
        'pg_ctl 正常停止临时数据库，等待落盘完成',
      );
    } else if (manifest.engine === 'redis') {
      activeStage = 'redis-empty-target-check';
      await stage(activeStage);
      if (
        outputJson(await runFixed(session, 'restore', helper, 'redis-start-empty', { operationId }))
          .allDatabasesEmpty !== true
      )
        fail('MANUAL_REDIS_NOT_EMPTY', '目标并非所有 Redis DB 为空。');
      redisStatus(await runFixed(session, 'restore', helper, 'redis-status'));
      await runFixed(session, 'restore', helper, 'redis-stop');
      await runFixed(session, 'restore', helper, 'redis-preserve-empty', { operationId });
      activeStage = 'redis-rdb-load-aof-disabled';
      await stage(activeStage);
      await runFixed(session, 'restore', helper, 'redis-load-rdb', { operationId });
      redisStatus(await runFixed(session, 'restore', helper, 'redis-status'), {
        appendonly: false,
      });
      let actual = redisProof(
        outputJson(
          await runFixed(session, 'restore', helper, 'redis-probe', { probes: definition }),
        ),
        definition,
      );
      comparison = compareRedis(manifest.validation, actual);
      activeStage = 'redis-aof-conversion';
      await stage(activeStage);
      const conversion = outputJson(await runFixed(session, 'restore', helper, 'redis-enable-aof'));
      redisStatus(await runFixed(session, 'restore', helper, 'redis-status'));
      actual = redisProof(
        outputJson(
          await runFixed(session, 'restore', helper, 'redis-probe', { probes: definition }),
        ),
        definition,
      );
      comparison = compareRedis(manifest.validation, actual);
      await publishJson(resolve(directory, 'import-comparison.json'), {
        expected: manifest.validation,
        actual,
        comparison,
        conversion,
      });
      await runFixed(session, 'restore', helper, 'redis-stop');
      steps.push(
        '先认证启动初始空 AOF，INFO keyspace 确认所有 DB 均为空',
        '正常停止后把初始空 AOF/RDB 完整保留在新卷的独立目录',
        '以 appendonly no 加载已校验 RDB，再比较固定键/值/绝对 TTL',
        '开启 appendonly yes，等待首次 rewrite 完成且写入/rewrite 状态为 ok',
        '再次比较数据并正常 SHUTDOWN NOSAVE，AOF 落盘后才移除 helper',
      );
    } else {
      activeStage = 'files-empty-target-import';
      await stage(activeStage);
      if (
        (await runFixed(session, 'restore', helper, 'files-version')).stdout
          .toString('utf8')
          .trim() !== 'tar (GNU tar) 1.34'
      )
        fail('MANUAL_TOOL_VERSION', '文件工具实际版本不匹配。');
      await runFixed(session, 'restore', helper, 'files-import', { operationId });
      const proof = resolve(directory, 'restored-data.tar.pending');
      await runFixed(
        session,
        'restore',
        helper,
        'files-probe',
        {},
        { outputFile: proof, maximum: MAX_ARTIFACT_BYTES },
      );
      const actual = await inspectTar(proof);
      if (digestJson(actual) !== digestJson(manifest.validation))
        fail('MANUAL_FILES_DATA_MISMATCH', '新卷文件的内容、UID/GID 或权限与源归档不一致。');
      await publishNew(proof, resolve(directory, 'restored-data.tar'));
      await publishJson(resolve(directory, 'import-comparison.json'), {
        expectedDigest: digestJson(manifest.validation),
        actualDigest: digestJson(actual),
        matched: true,
      });
      steps.push(
        '新卷根目录为空；验证过的 USTAR 使用 keep-old-files 解压',
        '在正式应用启动前重新归档，逐条匹配内容 SHA256、UID/GID 和权限',
      );
    }
    activeStage = 'helper-graceful-removal';
    await stage(activeStage);
    await deleteHelper(session, helper, 'restore');
    steps.push('helper 按 nonce、UID 与 resourceVersion 删除，并确认远端消失；维护保持');
    const prepared = {
      ...base,
      state: 'awaiting-formal-verification',
      result: 'incomplete',
      preparedAt: new Date().toISOString(),
      helper,
      helperRemoved: true,
      maintenanceReleased: false,
      verificationSteps: steps,
      comparison,
    };
    const report = resolve(directory, 'restore-prepared.json');
    await publishJson(report, prepared);
    await stage('awaiting-formal-verification', {
      report: 'restore-prepared.json',
      maintenanceReleased: false,
    });
    return { directory, report, prepared };
  } catch (error) {
    await retainedFailure(directory, error, activeStage);
    if (base)
      await publishJson(resolve(directory, 'restore-incomplete.json'), {
        ...base,
        state: 'incomplete',
        result: 'incomplete',
        completedAt: new Date().toISOString(),
        stage: activeStage,
        maintenanceReleased: false,
        verificationSteps: [],
      });
    throw error;
  } finally {
    session?.close();
  }
}
export async function verifyRestored(
  contextFile,
  bundleDirectory,
  preparedFile,
  copyReceiptFile,
  { progress } = {},
) {
  const bundle = await verifyBundle(bundleDirectory),
    manifest = bundle.manifest;
  await verifyCopyReceipt(bundle, copyReceiptFile);
  expectedProof(manifest.engine, manifest.validation);
  const prepared = await privateJson(preparedFile);
  let session;
  if (
    prepared?.formatVersion !== 1 ||
    prepared.kind !== 'manual-restore' ||
    prepared.state !== 'awaiting-formal-verification' ||
    prepared.result !== 'incomplete' ||
    prepared.helperRemoved !== true ||
    prepared.backupId !== manifest.backupId ||
    prepared.sha256 !== manifest.sha256 ||
    prepared.sizeBytes !== manifest.sizeBytes ||
    prepared.manifestSha256 !== bundle.manifestSha256 ||
    !sameIdentity(prepared.source, manifest.source) ||
    prepared.sourceServiceId !== manifest.sourceServiceId
  )
    fail('MANUAL_RESTORE_REPORT_INVALID', '正式验证必须引用这份备份的已完成导入、待正式验证报告。');
  try {
    session = await openManualSession(contextFile);
    if (
      !sameIdentity(session.config.expectedIdentity, prepared.target) ||
      session.config.serviceId !== prepared.targetServiceId ||
      session.config.engine !== manifest.engine
    )
      fail('MANUAL_RESTORE_TARGET', '上下文并非报告中的新目标。');
    newTarget(manifest.source, prepared.target, manifest.sourceServiceId, prepared.targetServiceId);
    const helperPath = `/api/v1/namespaces/${prepared.helper.namespace}/pods/${prepared.helper.name}`;
    if (await session.kube(helperPath, { allowMissing: true }))
      fail('MANUAL_HELPER_STILL_PRESENT', '原 helper 名称仍存在；不得宣告正式恢复完成。');
    const target = await session.checkpoint('formal', {
      expectedFence: { ...prepared.targetFence, maintenance: null },
    });
    progress?.({ operationId: prepared.operationId, stage: 'formal-workload-verification' });
    let formalData = null;
    if (manifest.engine === 'postgresql') {
      const definition = probes('postgresql', manifest.validation.definition);
      formalData = postgresProof(
        outputJson(await runFixed(session, 'formal', null, 'pg-probe', { probes: definition })),
        definition,
        target.database,
      );
      comparePostgres(manifest.validation, formalData);
    } else if (manifest.engine === 'redis') {
      const definition = probes('redis', manifest.validation.definition);
      const status = redisStatus(await runFixed(session, 'formal', null, 'redis-status'));
      const data = redisProof(
        outputJson(await runFixed(session, 'formal', null, 'redis-probe', { probes: definition })),
        definition,
      );
      formalData = { status, data, comparison: compareRedis(manifest.validation, data) };
    }
    await session.checkpoint('formal');
    const completedAt = new Date().toISOString(),
      result = {
        ...prepared,
        state: 'complete',
        result: 'passed',
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(prepared.startedAt),
        maintenanceReleased: true,
        formal: {
          controller: target.fence.controller,
          pod: { name: target.pod.metadata.name, uid: target.pod.metadata.uid },
          observedAt: completedAt,
          data: formalData,
        },
        verificationSteps: [
          ...prepared.verificationSteps,
          manifest.engine === 'files'
            ? '已显式退出维护并恢复正式 Service；按导入时原快照就绪，文件内容/权限在启动前验证'
            : '已显式退出维护并恢复固定 StatefulSet；再次认证、检查实际版本并比较业务数据',
          ...(manifest.engine === 'redis'
            ? ['正式 StatefulSet 的 AOF everysec、rewrite 和写入状态均为 ok']
            : []),
        ],
      };
    const directory = resolve(preparedFile, '..'),
      report = resolve(directory, 'restore-complete.json');
    await publishJson(report, result);
    return { directory, report, result };
  } catch (error) {
    await retainedFailure(resolve(preparedFile, '..'), error, 'formal-verification');
    throw error;
  } finally {
    session?.close();
  }
}
