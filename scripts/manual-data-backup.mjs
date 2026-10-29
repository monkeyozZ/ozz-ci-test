import { argumentsFor, requiredPath, runManualCli } from './manual-data-core.mjs';
import { backupManual } from './manual-data-operations.mjs';

await runManualCli(async () => {
  const args = argumentsFor({ context: { type: 'string' }, output: { type: 'string' } });
  if (args.help) {
    console.log(
      'pnpm exec node scripts/manual-data-backup.mjs --context PRIVATE_CONTEXT_JSON --output PRIVATE_BACKUP_PARENT',
    );
    return;
  }
  const result = await backupManual(requiredPath(args.context), requiredPath(args.output), {
    progress: (value) => console.log(JSON.stringify(value)),
  });
  console.log(
    JSON.stringify({
      state: 'complete',
      backupId: result.manifest.backupId,
      directory: result.directory,
      sha256: result.manifest.sha256,
      sizeBytes: result.manifest.sizeBytes,
      maintenanceReleased: false,
    }),
  );
});
