import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  argumentsFor,
  date,
  entrypoint,
  fail,
  newTarget,
  outputDirectory,
  privateJson,
  publishJson,
  requiredPath,
  retainedFailure,
  runManualCli,
  sameIdentity,
  uuid,
} from './manual-data-core.mjs';
import { verifyBundle, verifyCopyReceipt } from './manual-data-artifact.mjs';
import { openManualSession } from './manual-data-runtime.mjs';

export async function recordManual(
  contextFile,
  bundleDirectory,
  copyReceiptFile,
  parent,
  restoreReportFile = null,
) {
  const bundle = await verifyBundle(bundleDirectory),
    manifest = bundle.manifest,
    copy = await verifyCopyReceipt(bundle, copyReceiptFile);
  let restored = null;
  if (restoreReportFile) {
    restored = await privateJson(restoreReportFile);
    if (
      restored?.formatVersion !== 1 ||
      restored.kind !== 'manual-restore' ||
      restored.backupId !== manifest.backupId ||
      !sameIdentity(restored.source, manifest.source) ||
      restored.sourceServiceId !== manifest.sourceServiceId ||
      !['incomplete', 'awaiting-formal-verification', 'complete'].includes(restored.state) ||
      !['incomplete', 'passed'].includes(restored.result) ||
      (restored.result === 'passed') !== (restored.state === 'complete') ||
      !uuid(restored.targetServiceId) ||
      !uuid(restored.operationId) ||
      restored.manifestSha256 !== bundle.manifestSha256 ||
      ['engine', 'engineVersion', 'dataLayout', 'format', 'sizeBytes', 'sha256'].some(
        (key) => restored[key] !== manifest[key],
      ) ||
      !Array.isArray(restored.verificationSteps) ||
      restored.verificationSteps.length > 20
    )
      fail('MANUAL_RECORD_REPORT_INVALID', '恢复记录必须使用同一备份的完整或明确不完整报告。');
    newTarget(manifest.source, restored.target, manifest.sourceServiceId, restored.targetServiceId);
    if (
      restored.result === 'passed' &&
      (!restored.helperRemoved ||
        !restored.maintenanceReleased ||
        !restored.formal?.pod?.uid ||
        restored.formal.controller?.uid !== restored.targetFence?.controller?.uid)
    )
      fail('MANUAL_RECORD_REPORT_INVALID', '缺少 helper 移除及正式 workload 验证证据。');
  }
  const request = {
    type: restored ? 'restore' : 'backup',
    backupId: manifest.backupId,
    source: manifest.source,
    target: restored ? restored.target : null,
    engine: manifest.engine,
    engineVersion: manifest.engineVersion,
    dataLayout: manifest.dataLayout,
    format: manifest.format,
    toolVersion: manifest.toolVersion,
    sizeBytes: manifest.sizeBytes,
    sha256: manifest.sha256,
    startedAt: date(restored?.startedAt ?? manifest.startedAt),
    completedAt: date(
      restored ? (restored.completedAt ?? restored.preparedAt) : manifest.completedAt,
    ),
    dataTime: manifest.dataTime,
    offHostLocationLabel: copy.locationLabel,
    integrity: 'passed',
    verificationSteps: restored ? restored.verificationSteps : manifest.verificationSteps,
    result: restored ? restored.result : 'passed',
    evidenceReferences: [
      `backup:${manifest.backupId}`,
      `manifest-sha256:${bundle.manifestSha256}`,
      `copy:${copy.copyId}`,
      ...(restored ? [`restore:${restored.operationId}`] : []),
    ],
  };
  const directory = await outputDirectory(parent, randomUUID());
  let session;
  try {
    await publishJson(resolve(directory, 'manual-record-intent.json'), {
      request,
      verificationSource: 'operator_reported',
      createdAt: new Date().toISOString(),
    });
    session = await openManualSession(contextFile);
    if (!sameIdentity(session.config.expectedIdentity, manifest.source))
      fail(
        'MANUAL_RECORD_SOURCE',
        '记录上下文必须指向原备份源 Volume；恢复记录路径同样使用源 ID。',
      );
    const response = await session.record(manifest.source.volumeId, request);
    if (
      !uuid(response?.id) ||
      response.verificationSource !== 'operator_reported' ||
      !sameIdentity(response.source, manifest.source) ||
      response.backupId !== manifest.backupId ||
      response.type !== request.type ||
      response.result !== request.result
    )
      fail('MANUAL_RECORD_RESPONSE', '记录响应身份或来源标记不正确；保留请求意图，不自动重试。');
    await publishJson(resolve(directory, 'manual-record-receipt.json'), response);
    return {
      directory,
      recordId: response.id,
      verificationSource: 'operator_reported',
      type: request.type,
      result: request.result,
    };
  } catch (error) {
    await retainedFailure(directory, error, 'manual-data-record');
    throw error;
  } finally {
    session?.close();
  }
}
if (entrypoint(import.meta.url))
  await runManualCli(async () => {
    const args = argumentsFor({
      context: { type: 'string' },
      bundle: { type: 'string' },
      'copy-receipt': { type: 'string' },
      'restore-report': { type: 'string' },
      output: { type: 'string' },
    });
    if (args.help) {
      console.log(
        'pnpm exec node scripts/manual-data-record.mjs --context SOURCE_CONTEXT_JSON --bundle VERIFIED_COPY_DIRECTORY --copy-receipt PRIVATE_RECEIPT_JSON [--restore-report PRIVATE_RESTORE_REPORT_JSON] --output PRIVATE_RECORD_PARENT',
      );
      return;
    }
    console.log(
      JSON.stringify(
        await recordManual(
          requiredPath(args.context),
          requiredPath(args.bundle),
          requiredPath(args['copy-receipt']),
          requiredPath(args.output),
          args['restore-report'] ? requiredPath(args['restore-report']) : null,
        ),
      ),
    );
  });
