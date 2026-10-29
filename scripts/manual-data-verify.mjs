import { argumentsFor, requiredPath, runManualCli } from './manual-data-core.mjs';
import { verifyRestored } from './manual-data-operations.mjs';

await runManualCli(async () => {
  const args = argumentsFor({
    context: { type: 'string' },
    bundle: { type: 'string' },
    prepared: { type: 'string' },
    'copy-receipt': { type: 'string' },
  });
  if (args.help) {
    console.log(
      'pnpm exec node scripts/manual-data-verify.mjs --context NEW_TARGET_CONTEXT_JSON --bundle VERIFIED_COPY_DIRECTORY --copy-receipt PRIVATE_RECEIPT_JSON --prepared PRIVATE_RESTORE_PREPARED_JSON',
    );
    return;
  }
  const result = await verifyRestored(
    requiredPath(args.context),
    requiredPath(args.bundle),
    requiredPath(args.prepared),
    requiredPath(args['copy-receipt']),
    { progress: (value) => console.log(JSON.stringify(value)) },
  );
  console.log(
    JSON.stringify({
      state: 'complete',
      report: result.report,
      durationMs: result.result.durationMs,
      target: result.result.target,
    }),
  );
});
