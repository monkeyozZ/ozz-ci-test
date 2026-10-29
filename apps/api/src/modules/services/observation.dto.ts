import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class WorkloadMetricsDto {
  @ApiProperty({ enum: ['available', 'unknown'] }) state!: 'available' | 'unknown';
  @ApiProperty({ type: Number, nullable: true }) cpuCores!: number | null;
  @ApiProperty({ type: Number, nullable: true }) memoryBytes!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) observedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) windowSeconds!: number | null;
}

export class WorkloadContainerResourcesDto {
  @ApiProperty({ type: Number, nullable: true }) cpuCores!: number | null;
  @ApiProperty({ type: Number, nullable: true }) memoryBytes!: number | null;
}

export class WorkloadContainerDto {
  @ApiProperty() name!: string;
  @ApiProperty() image!: string;
  @ApiProperty({ type: String, nullable: true }) imageId!: string | null;
  @ApiProperty({ type: Boolean, nullable: true }) ready!: boolean | null;
  @ApiProperty({ type: Number, nullable: true }) restartCount!: number | null;
  @ApiProperty({ enum: ['waiting', 'running', 'terminated', 'unknown'] }) state!:
    'waiting' | 'running' | 'terminated' | 'unknown';
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastTerminationReason!: string | null;
  @ApiProperty() oomKilled!: boolean;
  @ApiProperty({ type: Number, nullable: true }) exitCode!: number | null;
  @ApiProperty({ type: WorkloadContainerResourcesDto }) requests!: WorkloadContainerResourcesDto;
  @ApiProperty({ type: WorkloadContainerResourcesDto }) limits!: WorkloadContainerResourcesDto;
  @ApiProperty({ type: WorkloadMetricsDto }) metrics!: WorkloadMetricsDto;
}

export class WorkloadPodOwnerDto {
  @ApiProperty({ enum: ['ReplicaSet', 'StatefulSet'] }) kind!: 'ReplicaSet' | 'StatefulSet';
  @ApiProperty() uid!: string;
}
export class WorkloadPodDto {
  @ApiProperty() uid!: string;
  @ApiProperty() name!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty({ type: String, nullable: true }) nodeName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) createdAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) deletionTimestamp!:
    string | null;
  @ApiProperty({ enum: ['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown'] }) phase!: string;
  @ApiProperty({ type: Boolean, nullable: true }) ready!: boolean | null;
  @ApiProperty({ type: String, nullable: true }) snapshotId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) configRevision!: number | null;
  @ApiProperty({ type: String, nullable: true }) rolloutId!: string | null;
  @ApiProperty({ type: String, nullable: true }) replicaSetUid!: string | null;
  @ApiPropertyOptional({ type: WorkloadPodOwnerDto }) owner?: WorkloadPodOwnerDto;
  @ApiPropertyOptional() matchesControllerTemplate?: boolean;
  @ApiProperty() matchesDeploymentTemplate!: boolean;
  @ApiProperty({ type: [WorkloadContainerDto] }) containers!: WorkloadContainerDto[];
}

export class WorkloadEventDto {
  @ApiProperty() uid!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: ['Normal', 'Warning', 'Unknown'] }) type!: string;
  @ApiProperty() objectUid!: string;
  @ApiProperty() objectKind!: string;
  @ApiProperty() objectName!: string;
  @ApiProperty({ type: Number, nullable: true }) count!: number | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) firstObservedAt!:
    string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) lastObservedAt!:
    string | null;
  @ApiProperty({ description: '受控原因文案，不含原始 Kubernetes 消息或秘密' }) message!: string;
}

export class WorkloadDriftDto {
  @ApiProperty({ enum: ['Namespace', 'Deployment', 'StatefulSet', 'Service', 'Secret', 'Pod'] })
  kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty() reason!: string;
}

export class WorkloadResourceDto {
  @ApiProperty({ enum: ['Namespace', 'Deployment', 'StatefulSet', 'Service', 'Secret'] })
  kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) namespace!: string | null;
  @ApiProperty({ type: String, nullable: true }) expectedUid!: string | null;
  @ApiProperty({ type: String, nullable: true }) observedUid!: string | null;
  @ApiProperty({ type: String, nullable: true }) resourceVersion!: string | null;
  @ApiProperty({ enum: ['verified', 'missing', 'drifted', 'unknown'] }) state!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class WorkloadDeploymentDto {
  @ApiProperty() uid!: string;
  @ApiProperty() resourceVersion!: string;
  @ApiProperty() generation!: number;
  @ApiProperty({ type: Number, nullable: true }) observedGeneration!: number | null;
  @ApiProperty() replicas!: number;
  @ApiProperty({ type: Number, nullable: true }) currentReplicas!: number | null;
  @ApiProperty({ type: Number, nullable: true }) updatedReplicas!: number | null;
  @ApiProperty({ type: Number, nullable: true }) readyReplicas!: number | null;
  @ApiProperty({ type: Number, nullable: true }) availableReplicas!: number | null;
  @ApiProperty({ type: String, nullable: true }) snapshotId!: string | null;
  @ApiProperty({ type: Number, nullable: true }) configRevision!: number | null;
  @ApiProperty({ type: Number, nullable: true }) mutationRevision!: number | null;
  @ApiProperty({ type: String, nullable: true }) rolloutId!: string | null;
  @ApiProperty({ type: String, nullable: true }) image!: string | null;
  @ApiProperty() templateFingerprint!: string;
  @ApiProperty() workloadFingerprint!: string;
  @ApiProperty() progressDeadlineExceeded!: boolean;
  @ApiProperty() deleting!: boolean;
}

export class WorkloadControllerObservationDto extends WorkloadDeploymentDto {
  @ApiProperty({ enum: ['Deployment', 'StatefulSet'] }) kind!: 'Deployment' | 'StatefulSet';
  @ApiProperty({ enum: ['RollingUpdate', 'Recreate', 'OnDelete'] }) strategy!:
    'RollingUpdate' | 'Recreate' | 'OnDelete';
  @ApiProperty({ type: String, nullable: true }) currentRevision!: string | null;
  @ApiProperty({ type: String, nullable: true }) updateRevision!: string | null;
}

export class WorkloadObservationDto {
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ enum: ['consistent', 'drifted', 'missing', 'unknown'] })
  configurationState!: string;
  @ApiProperty({ type: [WorkloadDriftDto] }) drift!: WorkloadDriftDto[];
  @ApiProperty({ type: [WorkloadResourceDto] }) resources!: WorkloadResourceDto[];
  @ApiProperty({ type: WorkloadDeploymentDto, nullable: true })
  deployment!: WorkloadDeploymentDto | null;
  @ApiPropertyOptional({ type: WorkloadControllerObservationDto, nullable: true })
  controller?: WorkloadControllerObservationDto | null;
  @ApiProperty({ type: [WorkloadPodDto] }) pods!: WorkloadPodDto[];
  @ApiProperty() podsTruncated!: boolean;
  @ApiProperty({ type: [WorkloadEventDto] }) events!: WorkloadEventDto[];
  @ApiProperty({ enum: ['available', 'unknown'] }) eventsState!: string;
  @ApiProperty() eventsTruncated!: boolean;
  @ApiProperty({ type: WorkloadMetricsDto }) metrics!: WorkloadMetricsDto;
  @ApiProperty({ type: String, nullable: true }) metricsErrorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) serviceDns!: string | null;
}

export class ServicePodsDto {
  @ApiProperty({ type: [WorkloadPodDto] }) pods!: WorkloadPodDto[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) observedAt!: string | null;
  @ApiProperty() stale!: boolean;
  @ApiProperty() truncated!: boolean;
}
export class ServicePodsEnvelopeDto {
  @ApiProperty({ type: ServicePodsDto }) data!: ServicePodsDto;
}
export class ServiceMetricsDto extends WorkloadMetricsDto {
  @ApiProperty() stale!: boolean;
}
export class ServiceMetricsEnvelopeDto {
  @ApiProperty({ type: ServiceMetricsDto }) data!: ServiceMetricsDto;
}
