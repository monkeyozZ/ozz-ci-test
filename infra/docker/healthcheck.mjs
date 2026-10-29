const target = process.argv[2];
if (!target) process.exit(1);
try {
  const response = await fetch(target, { signal: globalThis.AbortSignal.timeout(2500) });
  process.exitCode = response.ok ? 0 : 1;
} catch {
  process.exitCode = 1;
}
