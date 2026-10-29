const storageUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const;

/** Storage APIs use decimal strings so a reported byte count never passes through Number. */
export function formatStorageBytes(value: string | null | undefined): string {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return '未知';
  const bytes = BigInt(value);
  let index = 0;
  let scale = 1n;
  while (index < storageUnits.length - 1 && bytes >= scale * 1024n) {
    index++;
    scale *= 1024n;
  }
  if (index === 0) return `${bytes.toLocaleString('zh-CN')} B`;
  const tenths = (bytes * 10n) / scale;
  const fraction = tenths % 10n;
  return `${(tenths / 10n).toLocaleString('zh-CN')}${fraction ? `.${fraction}` : ''} ${storageUnits[index]}`;
}

export function gibToBytes(value: string): string {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('申请容量请填写大于 0 的整数 GiB。');
  return (BigInt(value) * 1024n ** 3n).toString();
}
