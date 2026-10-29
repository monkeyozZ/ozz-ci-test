/** A missing observation must remain unknown; zero is a valid measured value. */
function observedNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

export function bytesLabel(value: number | null | undefined): string {
  if (!observedNumber(value)) return '未知';
  if (value === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const index = Math.max(
    0,
    Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1),
  );
  return `${numberFormat.format(value / 1024 ** index)} ${units[index]}`;
}

export function cpuLabel(value: number | null | undefined): string {
  if (!observedNumber(value)) return '未知';
  if (value > 0 && value < 1)
    return value < 0.00001 ? '< 0.01 mCPU' : `${numberFormat.format(value * 1000)} mCPU`;
  return `${numberFormat.format(value)} 核`;
}

export function usagePercent(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (!observedNumber(used) || !observedNumber(total) || total <= 0) return null;
  const percent = Math.round((used / total) * 1000) / 10;
  return Number.isFinite(percent) ? percent : null;
}

export function sampleFreshness(
  observedAt: string | null | undefined,
  now: number,
  maxAgeMs = 90_000,
): 'fresh' | 'stale' | 'unknown' {
  if (!observedAt) return 'unknown';
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time) || time > now + 30_000) return 'unknown';
  return now - time > maxAgeMs ? 'stale' : 'fresh';
}

export function credentialExpiryLabel(value: string | null | undefined): string {
  if (!value) return '未知 / 未提供到期时间';
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : '到期时间未知';
}
