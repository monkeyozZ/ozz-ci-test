import { argumentsFor, requiredPath, runManualCli } from './manual-data-core.mjs';
import { restoreManual } from './manual-data-operations.mjs';

await runManualCli(async () => {
  const args = argumentsFor({
    context: { type: 'string' },
    bundle: { type: 'string' },
    'copy-receipt': { type: 'string' },
    output: { type: 'string' },
  });
  if (args.help) {
    console.log(
      'pnpm exec node scripts/manual-data-restore.mjs --context NEW_TARGET_CONTEXT_JSON --bundle VERIFIED_COPY_DIRECTORY --copy-receipt PRIVATE_RECEIPT_JSON --output PRIVATE_RESTORE_PARENT',
    );
    return;
  }
  const result = await restoreManual(
    requiredPath(args.context),
    requiredPath(args.bundle),
    requiredPath(args['copy-receipt']),
    requiredPath(args.output),
    { progress: (value) => console.log(JSON.stringify(value)) },
  );
  console.log(
    JSON.stringify({
      state: 'awaiting-formal-verification',
      report: result.report,
      directory: result.directory,
      helperRemoved: true,
      maintenanceReleased: false,
    }),
  );
});
