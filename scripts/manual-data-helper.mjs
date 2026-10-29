import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  argumentsFor,
  digestJson,
  entrypoint,
  fail,
  privateDirectory,
  privateJson,
  publishJson,
  requiredPath,
  retainedFailure,
  runManualCli,
  sameIdentity,
} from './manual-data-core.mjs';
import {
  deleteHelper,
  helperName,
  openManualSession,
  verifyHelper,
} from './manual-data-runtime.mjs';
import { runFixed } from './manual-data-operations.mjs';

export async function removeRetainedHelper(contextFile, runDirectory) {
  const directory = await privateDirectory(runDirectory),
    intent = await privateJson(resolve(directory, 'helper-intent.json'));
  let receipt = intent,
    session;
  try {
    try {
      await lstat(resolve(directory, 'helper-receipt.json'));
      receipt = await privateJson(resolve(directory, 'helper-receipt.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (
      intent.formatVersion !== 1 ||
      intent.name !== helperName(intent.operationId) ||
      !['backup', 'restore'].includes(intent.mode) ||
      intent.targetDigest !== digestJson(intent.fence) ||
      receipt.nonce !== intent.nonce ||
      receipt.targetDigest !== intent.targetDigest ||
      receipt.name !== intent.name ||
      receipt.namespace !== intent.namespace ||
      digestJson(receipt.expectedSpec) !== digestJson(intent.expectedSpec)
    )
      fail('MANUAL_HELPER_RECEIPT', 'helper 意图与 UID 回执不匹配。');
    session = await openManualSession(contextFile, { cleanupOnly: true });
    if (
      !sameIdentity(session.config.expectedIdentity, intent.fence.identity) ||
      session.config.serviceId !== intent.fence.serviceId ||
      session.config.engine !== intent.engine ||
      intent.namespace !==
        `ozz-e-${session.config.expectedIdentity.environmentId.replaceAll('-', '')}`
    )
      fail('MANUAL_HELPER_TARGET', '清理上下文不是原 helper 的固定数据目标。');
    await session.authorized();
    const path = `/api/v1/namespaces/${intent.namespace}/pods/${intent.name}`;
    let pod = await session.kube(path, { allowMissing: true });
    if (pod) {
      const deleting = Boolean(pod.metadata?.deletionTimestamp);
      verifyHelper(
        deleting ? { ...pod, metadata: { ...pod.metadata, deletionTimestamp: undefined } } : pod,
        receipt,
      );
      receipt = { ...receipt, uid: pod.metadata.uid };
      await session.checkpoint(intent.mode, { helper: receipt, expectedFence: intent.fence });
      await publishJson(resolve(directory, `helper-cleanup-intent-${randomUUID()}.json`), {
        ...receipt,
        requestedAt: new Date().toISOString(),
        maintenanceReleased: false,
      });
      if (deleting) {
        for (let i = 0; i < 90; i++) {
          pod = await session.kube(path, { allowMissing: true });
          if (!pod) break;
          if (pod.metadata?.uid !== receipt.uid)
            fail('MANUAL_HELPER_IDENTITY', 'helper 在等待删除期间被替换。');
          await delay(1000);
        }
        if (pod)
          fail('MANUAL_HELPER_STILL_PRESENT', 'helper 仍处于删除中；不使用 force，不解除维护。');
      } else {
        if (pod.status?.phase === 'Running' && intent.engine !== 'files')
          await runFixed(
            session,
            intent.mode,
            receipt,
            intent.engine === 'postgresql' ? 'pg-stop-if-running' : 'redis-stop-if-running',
          );
        else if (pod.status?.phase === 'Unknown')
          fail('MANUAL_HELPER_UNKNOWN', 'helper 状态未知；不直接终止数据库。');
        await deleteHelper(session, receipt, intent.mode);
      }
    }
    await session.checkpoint(intent.mode, { expectedFence: intent.fence });
    const result = {
      formatVersion: 1,
      operationId: intent.operationId,
      helper: { name: intent.name, uid: receipt.uid ?? null },
      state: 'helper-absent',
      observedAt: new Date().toISOString(),
      maintenanceReleased: false,
      restoreCompleted: false,
    };
    const report = resolve(directory, `helper-cleanup-receipt-${randomUUID()}.json`);
    await publishJson(report, result);
    return { report, ...result };
  } catch (error) {
    await retainedFailure(directory, error, 'retained-helper-removal');
    throw error;
  } finally {
    session?.close();
  }
}
if (entrypoint(import.meta.url))
  await runManualCli(async () => {
    const args = argumentsFor({ context: { type: 'string' }, 'run-directory': { type: 'string' } });
    if (args.help) {
      console.log(
        'pnpm exec node scripts/manual-data-helper.mjs --context ORIGINAL_TARGET_CONTEXT_JSON --run-directory PRIVATE_FAILED_RUN_DIRECTORY',
      );
      return;
    }
    console.log(
      JSON.stringify(
        await removeRetainedHelper(requiredPath(args.context), requiredPath(args['run-directory'])),
      ),
    );
  });
