import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { SshPreflight } from '@ozz/infrastructure/ssh';
import type {
  CertificateSummary,
  KubernetesCapabilities,
  KubernetesCapabilityState,
  KubernetesClusterIdentity,
  KubernetesConditionState,
  KubernetesCredentialSummary,
  KubernetesErrorCode,
  KubernetesInspection,
  KubernetesMetricsCapability,
  KubernetesNodeMetrics,
  KubernetesNodeSnapshot,
  KubernetesPermissionCheck,
  KubernetesResourceValues,
  KubernetesWorkloadKind,
  KubernetesWorkloadObservation,
  KubernetesWorkloadSnapshot,
} from '@ozz/infrastructure/kubernetes';
import { PageInfoDto } from '../projects/metadata.dto.js';

const conditionStates = ['true', 'false', 'unknown'] as const;
const capabilityStates = ['available', 'unavailable', 'forbidden', 'unknown'] as const;
const workloadKinds = ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod'] as const;
const workloadStates = [
  'ready',
  'not_ready',
  'scaled_to_zero',
  'pending',
  'running',
  'succeeded',
  'failed',
  'scheduled',
  'suspended',
  'terminating',
  'unknown',
] as const;

export class SshHostKeyDto {
  @ApiProperty({ type: String, nullable: true }) trustedFingerprint!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) trustedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) trustSource!: string | null;
  @ApiProperty({ type: String, nullable: true }) observedFingerprint!: string | null;
  @ApiProperty({ type: String, nullable: true }) observedAlgorithm!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) observedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) discoveryOperationId!:
    string | null;
}

export class SshPortObservationDto {
  @ApiProperty({ enum: ['tcp', 'udp'] }) protocol!: 'tcp' | 'udp';
  @ApiProperty({ minimum: 1, maximum: 65535 }) port!: number;
  @ApiProperty({ description: '本机监听状态，不代表公网可达或防火墙已放行' }) listening!: boolean;
}

export class SshK3sObservationDto {
  @ApiProperty() installed!: boolean;
  @ApiProperty({ type: String, nullable: true }) version!: string | null;
  @ApiProperty({ type: String, nullable: true }) installationId!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['prepared', 'installed', 'ready'] })
  installationPhase!: 'prepared' | 'installed' | 'ready' | null;
  @ApiProperty({ enum: ['enabled', 'disabled', 'unknown'] }) secretsEncryption!:
    'enabled' | 'disabled' | 'unknown';
}

export class SshPreflightDto implements SshPreflight {
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty() machineId!: string;
  @ApiProperty() hostname!: string;
  @ApiProperty() os!: string;
  @ApiProperty() osVersion!: string;
  @ApiProperty({ enum: ['arm64', 'amd64', 'unsupported'] })
  architecture!: SshPreflight['architecture'];
  @ApiProperty() kernel!: string;
  @ApiProperty() init!: string;
  @ApiProperty({ minimum: 0 }) cpuCount!: number;
  @ApiProperty({ minimum: 0 }) memoryBytes!: number;
  @ApiProperty({ minimum: 0, description: '本次预检快照中的可用内存，不是持续更新指标' })
  memoryAvailableBytes!: number;
  @ApiProperty({ minimum: 0 }) rootDiskBytes!: number;
  @ApiProperty({ minimum: 0 }) rootDiskAvailableBytes!: number;
  @ApiProperty({ minimum: 0 }) dataDiskBytes!: number;
  @ApiProperty({ minimum: 0 }) dataDiskAvailableBytes!: number;
  @ApiProperty() privileged!: boolean;
  @ApiProperty() memoryCgroupAvailable!: boolean;
  @ApiProperty() systemdAvailable!: boolean;
  @ApiProperty({ type: [SshPortObservationDto] }) ports!: SshPortObservationDto[];
  @ApiProperty({ enum: ['active', 'inactive', 'unknown'] }) firewall!: SshPreflight['firewall'];
  @ApiProperty({ type: SshK3sObservationDto }) k3s!: SshK3sObservationDto;
  @ApiProperty({
    isArray: true,
    enum: [
      'unsupported_os',
      'unsupported_architecture',
      'systemd_required',
      'privilege_required',
      'memory_cgroup_required',
      'insufficient_cpu',
      'insufficient_memory',
      'insufficient_disk',
      'ports_in_use',
    ],
  })
  blockers!: SshPreflight['blockers'];
  @ApiProperty({
    isArray: true,
    enum: [
      'low_memory_headroom',
      'low_disk_headroom',
      'firewall_requires_review',
      'cloud_firewall_unknown',
      'existing_k3s',
    ],
  })
  warnings!: SshPreflight['warnings'];
}

export class KubernetesCertificateSummaryDto implements CertificateSummary {
  @ApiProperty() fingerprint!: string;
  @ApiProperty({ format: 'date-time' }) notBefore!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class KubernetesCredentialSummaryDto implements KubernetesCredentialSummary {
  @ApiProperty({ enum: ['client_certificate', 'token'] }) authentication!:
    'client_certificate' | 'token';
  @ApiProperty({ type: KubernetesCertificateSummaryDto, nullable: true })
  clientCertificate!: KubernetesCertificateSummaryDto | null;
  @ApiProperty({ type: [KubernetesCertificateSummaryDto] })
  caCertificates!: readonly KubernetesCertificateSummaryDto[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({
    enum: ['client_certificate', 'token_claim', 'unknown'],
    description: 'token_claim 是尚待远端认证的令牌声明，不能当作已验证凭证',
  })
  expirationSource!: 'client_certificate' | 'token_claim' | 'unknown';
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) notBefore!: string | null;
}

export class KubernetesIdentityDto implements KubernetesClusterIdentity {
  @ApiProperty() kubeSystemUid!: string;
  @ApiProperty() caFingerprint!: string;
}

export class KubernetesResourceValuesDto implements KubernetesResourceValues {
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) cpuCores!: number | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) memoryBytes!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    description: '节点报告的临时存储容量，不是磁盘已用空间',
  })
  ephemeralStorageBytes!: number | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) pods!: number | null;
}

export class KubernetesNodeMetricsDto implements KubernetesNodeMetrics {
  @ApiProperty({ enum: ['available', 'unknown'] }) state!: 'available' | 'unknown';
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) cpuCores!: number | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) memoryBytes!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Metrics API 返回的采样时间',
  })
  observedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) windowSeconds!: number | null;
}

export class KubernetesNodeAddressDto {
  @ApiProperty({ enum: ['InternalIP', 'ExternalIP', 'Hostname'] }) type!:
    'InternalIP' | 'ExternalIP' | 'Hostname';
  @ApiProperty() address!: string;
}

export class KubernetesNodeConditionsDto {
  @ApiProperty({ enum: conditionStates }) ready!: KubernetesConditionState;
  @ApiProperty({ enum: conditionStates }) diskPressure!: KubernetesConditionState;
  @ApiProperty({ enum: conditionStates }) memoryPressure!: KubernetesConditionState;
  @ApiProperty({ enum: conditionStates }) pidPressure!: KubernetesConditionState;
  @ApiProperty({ enum: conditionStates }) networkUnavailable!: KubernetesConditionState;
}

export class KubernetesNodeSnapshotDto implements KubernetesNodeSnapshot {
  @ApiProperty() uid!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) resourceVersion!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) architecture!: string | null;
  @ApiProperty({ type: String, nullable: true }) operatingSystem!: string | null;
  @ApiProperty({ type: String, nullable: true }) osImage!: string | null;
  @ApiProperty({ type: String, nullable: true }) kubeletVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) containerRuntimeVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) machineId!: string | null;
  @ApiProperty({ type: String, nullable: true }) systemUuid!: string | null;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [KubernetesNodeAddressDto] }) addresses!: KubernetesNodeAddressDto[];
  @ApiProperty() unschedulable!: boolean;
  @ApiProperty({ type: KubernetesNodeConditionsDto }) conditions!: KubernetesNodeConditionsDto;
  @ApiProperty({ type: KubernetesResourceValuesDto }) capacity!: KubernetesResourceValuesDto;
  @ApiProperty({ type: KubernetesResourceValuesDto }) allocatable!: KubernetesResourceValuesDto;
  @ApiProperty({ type: KubernetesNodeMetricsDto }) metrics!: KubernetesNodeMetricsDto;
}

export class KubernetesPermissionCheckDto implements KubernetesPermissionCheck {
  @ApiProperty() apiGroup!: string;
  @ApiProperty() resource!: string;
  @ApiProperty() verb!: string;
  @ApiProperty({ type: String, nullable: true }) resourceName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null 表示集群范围或所有 namespace，不能解释为单个项目权限',
  })
  namespace!: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) allowed!: boolean | null;
  @ApiProperty({ enum: ['successful_request', 'self_subject_access_review', 'unknown'] })
  evidence!: 'successful_request' | 'self_subject_access_review' | 'unknown';
  @ApiProperty({ type: String, nullable: true }) errorCode!: KubernetesErrorCode | null;
}

export class KubernetesPermissionsDto {
  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'wildcard SSAR 结果；true 表示广泛集群权限，不表示最小权限',
  })
  clusterWideAdmin!: boolean | null;
  @ApiProperty({ type: [KubernetesPermissionCheckDto] }) checks!: KubernetesPermissionCheckDto[];
}

export class KubernetesMetricsCapabilityDto implements KubernetesMetricsCapability {
  @ApiProperty({ enum: capabilityStates }) state!: KubernetesCapabilityState;
  @ApiProperty({ type: String, nullable: true }) errorCode!: KubernetesErrorCode | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) observedAt!: string | null;
}

export class KubernetesIngressClassDto {
  @ApiProperty() name!: string;
  @ApiProperty() controller!: string;
  @ApiProperty() isDefault!: boolean;
}

export class KubernetesIngressCapabilityDto {
  @ApiProperty({ enum: capabilityStates }) state!: KubernetesCapabilityState;
  @ApiProperty({ type: [KubernetesIngressClassDto] }) classes!: KubernetesIngressClassDto[];
  @ApiProperty({ type: String, nullable: true }) errorCode!: KubernetesErrorCode | null;
}

export class KubernetesTraefikCapabilityDto {
  @ApiProperty({ enum: capabilityStates }) state!: KubernetesCapabilityState;
  @ApiProperty({ enum: ['kube-system'] }) namespace!: 'kube-system';
  @ApiProperty({ enum: ['traefik'] }) deployment!: 'traefik';
  @ApiProperty({ type: Boolean, nullable: true }) ready!: boolean | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) desiredReplicas!: number | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) readyReplicas!: number | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) availableReplicas!: number | null;
  @ApiProperty({ type: String, nullable: true }) errorCode!: KubernetesErrorCode | null;
}

export class KubernetesStorageClassDto {
  @ApiProperty() name!: string;
  @ApiProperty() provisioner!: string;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty({ type: String, nullable: true, enum: ['Immediate', 'WaitForFirstConsumer'] })
  volumeBindingMode!: 'Immediate' | 'WaitForFirstConsumer' | null;
  @ApiProperty({ type: String, nullable: true, enum: ['Delete', 'Retain'] }) reclaimPolicy!:
    'Delete' | 'Retain' | null;
  @ApiProperty({ type: Boolean, nullable: true }) allowVolumeExpansion!: boolean | null;
}

export class KubernetesStorageCapabilityDto {
  @ApiProperty({ enum: capabilityStates }) state!: KubernetesCapabilityState;
  @ApiProperty({ type: [KubernetesStorageClassDto] }) classes!: KubernetesStorageClassDto[];
  @ApiProperty({ type: String, nullable: true }) errorCode!: KubernetesErrorCode | null;
}

export class KubernetesCapabilitiesDto implements KubernetesCapabilities {
  @ApiProperty({ type: KubernetesIngressCapabilityDto }) ingress!: KubernetesIngressCapabilityDto;
  @ApiProperty({ type: KubernetesTraefikCapabilityDto }) traefik!: KubernetesTraefikCapabilityDto;
  @ApiProperty({ type: KubernetesStorageCapabilityDto }) storage!: KubernetesStorageCapabilityDto;
  @ApiProperty({ type: KubernetesMetricsCapabilityDto }) metrics!: KubernetesMetricsCapabilityDto;
}

export class KubernetesWorkloadSnapshotDto implements KubernetesWorkloadSnapshot {
  @ApiProperty({ enum: workloadKinds }) kind!: KubernetesWorkloadKind;
  @ApiProperty() namespace!: string;
  @ApiProperty() name!: string;
  @ApiProperty() uid!: string;
  @ApiProperty({ enum: workloadStates }) status!: KubernetesWorkloadSnapshot['status'];
  @ApiProperty({ type: Boolean, nullable: true }) ready!: boolean | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) desiredReplicas!: number | null;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) readyReplicas!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '实际标签值，本身不能证明 Ozz 对该资源的所有权',
  })
  managedBy!: string | null;
}

export class KubernetesWorkloadCollectionDto {
  @ApiProperty({ enum: workloadKinds }) kind!: KubernetesWorkloadKind;
  @ApiProperty({ enum: capabilityStates }) state!: KubernetesCapabilityState;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    description: '已载入预览条数；truncated=true 时不是总数',
  })
  listedCount!: number | null;
  @ApiProperty() truncated!: boolean;
  @ApiProperty({ type: String, nullable: true }) errorCode!: KubernetesErrorCode | null;
}

export class KubernetesWorkloadObservationDto implements KubernetesWorkloadObservation {
  @ApiProperty({ enum: ['available', 'partial', 'unknown'] }) state!:
    'available' | 'partial' | 'unknown';
  @ApiProperty({ type: [KubernetesWorkloadSnapshotDto] }) items!: KubernetesWorkloadSnapshotDto[];
  @ApiProperty({ type: [KubernetesWorkloadCollectionDto] })
  collections!: KubernetesWorkloadCollectionDto[];
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
}

export class KubernetesSecretsEncryptionDto {
  @ApiProperty({ enum: ['unknown'] }) state!: 'unknown';
  @ApiProperty({ enum: ['not_available_via_standard_api'] })
  evidence!: 'not_available_via_standard_api';
}

export class KubernetesInspectionDto implements KubernetesInspection {
  @ApiProperty() endpoint!: string;
  @ApiProperty() version!: string;
  @ApiProperty({ type: KubernetesIdentityDto }) identity!: KubernetesIdentityDto;
  @ApiProperty({ type: KubernetesCredentialSummaryDto })
  credential!: Readonly<KubernetesCredentialSummaryDto>;
  @ApiProperty({ type: KubernetesPermissionsDto }) permissions!: KubernetesPermissionsDto;
  @ApiProperty({ type: [KubernetesNodeSnapshotDto] }) nodes!: KubernetesNodeSnapshotDto[];
  @ApiProperty({ type: String, nullable: true }) nodesResourceVersion!: string | null;
  @ApiProperty({ type: KubernetesMetricsCapabilityDto }) metrics!: KubernetesMetricsCapabilityDto;
  @ApiProperty({ type: KubernetesCapabilitiesDto }) capabilities!: KubernetesCapabilitiesDto;
  @ApiProperty({ type: KubernetesWorkloadObservationDto })
  workloads!: KubernetesWorkloadObservationDto;
  @ApiProperty({ type: KubernetesSecretsEncryptionDto })
  secretsEncryption!: KubernetesSecretsEncryptionDto;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
}

export class NodeClusterSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['unverified', 'connected', 'unreachable', 'unknown'] })
  connectionStatus!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastObservedAt!:
    string | null;
}

export class NodeResponseDto extends KubernetesNodeSnapshotDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) serverId!: string | null;
  @ApiProperty({ description: '最近成功同步是否仍存在；失联不会将其改写为 false' })
  present!: boolean;
  @ApiProperty({ format: 'date-time' }) lastObservedAt!: string;
  @ApiPropertyOptional({
    type: NodeClusterSummaryDto,
    description: '服务器的关联节点查询附带唯一集群登记上下文',
  })
  cluster?: NodeClusterSummaryDto;
}

export class NodeListDto {
  @ApiProperty({ type: [NodeResponseDto] }) data!: NodeResponseDto[];
  @ApiProperty({ type: PageInfoDto }) page!: PageInfoDto;
}

export class ConnectionPreviewDto {
  @ApiProperty() apiEndpoint!: string;
  @ApiProperty() caFingerprint!: string;
  @ApiProperty({ type: String, nullable: true }) currentCaFingerprint!: string | null;
  @ApiProperty() requiresCaConfirmation!: boolean;
  @ApiProperty({ type: KubernetesCredentialSummaryDto })
  credential!: Readonly<KubernetesCredentialSummaryDto>;
}

export class ConnectionPreviewEnvelopeDto {
  @ApiProperty({ type: ConnectionPreviewDto }) data!: ConnectionPreviewDto;
}
