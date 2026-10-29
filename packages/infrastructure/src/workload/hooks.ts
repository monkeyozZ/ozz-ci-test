import { WorkloadAdapterError } from './contracts.js';

export async function invokeHook(work: () => Promise<void>, signal: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(10_000);
  const combined = AbortSignal.any([signal, timeout]);
  if (combined.aborted)
    throw new WorkloadAdapterError(
      signal.aborted ? 'KUBERNETES_CANCELLED' : 'WORKLOAD_CALLBACK_FAILED',
    );
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (succeeded: boolean) => {
      if (settled) return;
      settled = true;
      combined.removeEventListener('abort', onAbort);
      if (!succeeded)
        reject(
          new WorkloadAdapterError(
            signal.aborted ? 'KUBERNETES_CANCELLED' : 'WORKLOAD_CALLBACK_FAILED',
          ),
        );
      else resolve();
    };
    const onAbort = () => finish(false);
    combined.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(work)
      .then(
        () => finish(true),
        () => finish(false),
      );
  });
  if (signal.aborted) throw new WorkloadAdapterError('KUBERNETES_CANCELLED');
}
