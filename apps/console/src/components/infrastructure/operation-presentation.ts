import type { Operation } from '@/lib/types';
import type { components } from '@ozz/api-client';
type Schema = components['schemas'];

const labels: Record<string, string> = {
  diagnostic: '控制面诊断',
  github_webhook_register: 'GitHub Webhook 注册',
  registry_validate: 'Registry 推送与拉取检查',
  ssh_discover: 'SSH 指纹读取',
  server_preflight: '服务器只读预检',
  server_initialize: 'K3s 初始化',
  cluster_connect: '集群连接验证',
  cluster_sync: '集群观察同步',
  service_restart: '重启服务',
  service_stop: '停止服务',
  service_resume: '恢复服务运行',
  service_delete: '删除服务',
  domain_bind: '分配默认域名',
  domain_sync: '域名网络检查',
  domain_reconcile: '重新应用绑定',
  domain_unbind: '解绑域名',
  domain_production: '申请正式证书',
  cluster_network_check: '集群网络能力检查',
  cluster_cert_manager_install: '安装 cert-manager',
  volume_create: '创建数据卷',
  volume_sync: '同步数据卷观察',
  volume_destroy: '销毁数据卷',
  volume_maintenance_enter: '进入数据维护',
  volume_maintenance_exit: '退出数据维护',
};

export function operationLabel(kind?: string | null): string {
  return kind ? (labels[kind] ?? '后台任务') : '任务详情';
}

export function serviceOperationInput(
  operation?: Operation,
): Schema['ServiceOperationInputDto'] | null {
  return operation?.scope === 'service' &&
    ['service_restart', 'service_stop', 'service_resume', 'service_delete'].includes(
      operation.kind,
    ) &&
    'target' in operation.input &&
    'serviceId' in operation.input
    ? (operation.input as Schema['ServiceOperationInputDto'])
    : null;
}

export function volumeOperationInput(
  operation?: Operation,
): Schema['VolumeOperationInputDto'] | null {
  return operation?.scope === 'volume' &&
    [
      'volume_create',
      'volume_sync',
      'volume_destroy',
      'volume_maintenance_enter',
      'volume_maintenance_exit',
    ].includes(operation.kind) &&
    'target' in operation.input &&
    'volumeId' in operation.input &&
    'volumeRevision' in operation.input
    ? (operation.input as Schema['VolumeOperationInputDto'])
    : null;
}

export function domainOperationInput(
  operation?: Operation,
): Schema['DomainOperationInputDto'] | null {
  return operation &&
    [
      'domain_bind',
      'domain_sync',
      'domain_reconcile',
      'domain_unbind',
      'domain_production',
    ].includes(operation.kind) &&
    'domainId' in operation.input &&
    'hostname' in operation.input &&
    'target' in operation.input
    ? (operation.input as Schema['DomainOperationInputDto'])
    : null;
}

export function clusterNetworkingOperationInput(
  operation?: Operation,
): Schema['ClusterNetworkingOperationInputDto'] | null {
  return operation &&
    ['cluster_network_check', 'cluster_cert_manager_install'].includes(operation.kind) &&
    'clusterId' in operation.input &&
    'networkRevision' in operation.input
    ? (operation.input as Schema['ClusterNetworkingOperationInputDto'])
    : null;
}
