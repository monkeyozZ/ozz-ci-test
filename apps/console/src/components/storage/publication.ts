import type { Deployment } from '@/components/services/types';

export function storageSnapshotComplete(snapshot: Deployment['snapshot']): boolean {
  if (snapshot.version === 1) return true;
  return (
    !!snapshot.controller &&
    Array.isArray(snapshot.volumes) &&
    snapshot.database !== undefined &&
    Array.isArray(snapshot.databaseBindings) &&
    snapshot.template !== undefined
  );
}

export const databaseOutputLabel: Record<string, string> = {
  host: '私有主机',
  port: '端口',
  database: '数据库',
  user: '用户名',
  password: '密码秘密引用',
  db: '逻辑库编号',
  url: '连接 URI 秘密引用',
};
