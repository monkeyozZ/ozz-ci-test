import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WorkloadObservationDto } from './observation.dto.js';

export class ServiceTaskTargetDto {
  @ApiProperty({ format: 'uuid' }) installationId!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty() kubeSystemUid!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty() serviceName!: string;
}
export class ServiceOperationInputDto {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() mutationRevision!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) snapshotId!: string | null;
  @ApiProperty({ type: ServiceTaskTargetDto }) target!: ServiceTaskTargetDto;
  @ApiPropertyOptional({ type: [String], maxItems: 16 }) volumeIds?: string[];
}
export class WorkloadControllerIdentityDto {
  @ApiProperty({ enum: ['Deployment', 'StatefulSet'] }) kind!: 'Deployment' | 'StatefulSet';
  @ApiProperty() uid!: string;
}
export class WorkloadRolloutDto {
  @ApiProperty({ format: 'uuid' }) snapshotId!: string;
  @ApiProperty() configRevision!: number;
  @ApiProperty() image!: string;
  @ApiProperty() replicas!: number;
  @ApiPropertyOptional({ description: '仅旧版 Deployment 回执提供' }) deploymentUid?: string;
  @ApiPropertyOptional({
    type: WorkloadControllerIdentityDto,
    description: '新版回执提供实际 controller 身份',
  })
  controller?: WorkloadControllerIdentityDto;
  @ApiProperty() templateFingerprint!: string;
  @ApiProperty() workloadFingerprint!: string;
  @ApiProperty() usesPullSecret!: boolean;
  @ApiProperty() generation!: number;
  @ApiProperty() rolloutId!: string;
}
export class WorkloadResourceReceiptDto {
  @ApiProperty({ enum: ['created', 'replaced', 'verified', 'deleted'] }) action!: string;
  @ApiProperty({ enum: ['Namespace', 'Deployment', 'StatefulSet', 'Service', 'Secret'] })
  kind!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) namespace!: string | null;
  @ApiProperty() creationNonce!: string;
  @ApiProperty() uid!: string;
  @ApiProperty({ type: String, nullable: true }) resourceVersion!: string | null;
  @ApiProperty({ type: Number, nullable: true }) generation!: number | null;
  @ApiProperty() mutationRevision!: number;
  @ApiProperty({ type: String, nullable: true }) specFingerprint!: string | null;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
}
export class ServiceOperationResultDto {
  @ApiProperty({ enum: ['stop', 'resume', 'restart', 'delete'] }) action!: string;
  @ApiProperty() mutationRevision!: number;
  @ApiProperty({ type: [WorkloadResourceReceiptDto] }) resources!: WorkloadResourceReceiptDto[];
  @ApiProperty({ type: WorkloadRolloutDto, nullable: true }) rollout!: WorkloadRolloutDto | null;
  @ApiProperty({ format: 'date-time' }) completedAt!: string;
  @ApiPropertyOptional({ type: WorkloadObservationDto }) observation?: WorkloadObservationDto;
}
export class ServiceNoRemoteResultDto {
  @ApiProperty({ enum: ['stop', 'delete'] }) action!: string;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty({ enum: ['none'] }) remoteEffects!: 'none';
}
