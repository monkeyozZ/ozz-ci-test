import type { Database, Template, TemplateParameters, Volume, VolumeMaintenance } from './types';
import { gibToBytes } from './format';

type Badge = { label: string; tone: 'neutral' | 'primary' | 'good' | 'warning' | 'danger' };

export function databaseState(database: Database): Badge {
  if (!database.service) return { label: '数据已保留', tone: 'neutral' };
  if (database.observationStale) return { label: '观察已过期', tone: 'warning' };
  if (
    database.databaseReady &&
    database.observation?.state === 'ready' &&
    database.observation.authenticated
  )
    return { label: '认证检查通过', tone: 'good' };
  if (database.observation?.state === 'failed') return { label: '认证检查失败', tone: 'danger' };
  return { label: '尚未确认可连接', tone: 'warning' };
}

export function volumeState(volume: Volume): Badge {
  if (volume.desiredState === 'destroyed') return { label: '卷已销毁', tone: 'neutral' };
  if (volume.desiredState === 'destroying') return { label: '正在销毁', tone: 'primary' };
  if (volume.observation.stale) return { label: '观察已过期', tone: 'warning' };
  const states: Record<Volume['observation']['state'], Badge> = {
    pending: { label: '等待绑定', tone: 'primary' },
    ready: { label: '存储检查通过', tone: 'good' },
    missing: { label: 'PVC 缺失', tone: 'danger' },
    drifted: { label: '存储身份变化', tone: 'danger' },
    unknown: { label: '状态待确认', tone: 'warning' },
    destroyed: { label: '卷已销毁', tone: 'neutral' },
  };
  return states[volume.observation.state];
}

export function maintenanceState(maintenance: VolumeMaintenance): Badge {
  if (maintenance.overdue && maintenance.state !== 'closed')
    return { label: '维护超时 · 仍锁定', tone: 'danger' };
  const states: Record<VolumeMaintenance['state'], Badge> = {
    entering: { label: '正在进入维护', tone: 'primary' },
    active: { label: '维护中', tone: 'warning' },
    exiting: { label: '正在退出维护', tone: 'primary' },
    failed: { label: '维护核验失败 · 仍锁定', tone: 'danger' },
    closed: { label: '维护已结束', tone: 'neutral' },
  };
  return states[maintenance.state];
}

export function storageContext(volume: Volume) {
  return volume.project && volume.environment && volume.cluster
    ? { project: volume.project, environment: volume.environment, cluster: volume.cluster }
    : null;
}

export function databaseServiceLocation(database: Database) {
  return database.service
    ? `/projects/${database.projectId}/services/${database.service.id}`
    : null;
}

export function templateDraft(template: Template): Record<string, string> {
  return Object.fromEntries(
    template.parameters.map((parameter) => [
      parameter.name,
      parameter.type === 'bytes' && parameter.defaultValue !== null
        ? (BigInt(String(parameter.defaultValue)) / 1024n ** 3n).toString()
        : String(parameter.defaultValue ?? ''),
    ]),
  );
}

export function templateParameters(
  template: Template,
  draft: Record<string, string>,
): TemplateParameters {
  const values: Record<string, string | number> = {};
  for (const parameter of template.parameters) {
    const value = (draft[parameter.name] ?? '').trim();
    if (!value) {
      if (parameter.required) throw new Error(`请填写${parameter.label}。`);
      continue;
    }
    if (parameter.type === 'bytes') values[parameter.name] = gibToBytes(value);
    else if (parameter.type === 'integer') {
      const integer = Number(value);
      if (
        !Number.isSafeInteger(integer) ||
        (parameter.minimum !== null && integer < parameter.minimum) ||
        (parameter.maximum !== null && integer > parameter.maximum)
      )
        throw new Error(`${parameter.label}超出允许的整数范围。`);
      values[parameter.name] = integer;
    } else values[parameter.name] = value;
  }
  return values as TemplateParameters;
}

export const engineLabel = (engine: string) =>
  engine === 'postgresql' ? 'PostgreSQL' : engine === 'redis' ? 'Redis' : '文件卷';
