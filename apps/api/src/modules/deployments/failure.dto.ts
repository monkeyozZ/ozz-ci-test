import { ApiProperty, ApiPropertyOptional, OmitType, PickType } from '@nestjs/swagger';
import {
  WorkloadDeploymentDto,
  WorkloadControllerObservationDto,
  WorkloadDriftDto,
  WorkloadPodDto,
  WorkloadResourceDto,
  WorkloadContainerDto,
} from '../services/observation.dto.js';

export class DeploymentFailureWorkloadDto extends OmitType(WorkloadDeploymentDto, [
  'image',
  'deleting',
] as const) {}
export class DeploymentFailureControllerDto extends OmitType(WorkloadControllerObservationDto, [
  'image',
  'deleting',
] as const) {}

/** Only recognized reason codes and scalar states; never raw container messages or specs. */
export class DeploymentFailureContainerDto extends PickType(WorkloadContainerDto, [
  'name',
  'state',
  'ready',
  'restartCount',
  'reason',
  'lastTerminationReason',
  'oomKilled',
  'exitCode',
] as const) {}

export class DeploymentFailurePodDto extends PickType(WorkloadPodDto, [
  'uid',
  'name',
  'snapshotId',
  'configRevision',
  'rolloutId',
  'replicaSetUid',
  'owner',
  'matchesControllerTemplate',
  'phase',
  'ready',
  'deletionTimestamp',
] as const) {
  @ApiProperty() matchesDeploymentTemplate!: boolean;
  @ApiPropertyOptional({ type: [DeploymentFailureContainerDto], maxItems: 16 })
  containers?: DeploymentFailureContainerDto[];
}

export class DeploymentFailureTruncationDto {
  @ApiProperty() drift!: boolean;
  @ApiProperty() resources!: boolean;
  @ApiProperty() pods!: boolean;
  @ApiPropertyOptional() containers?: boolean;
}

/** Captured once by the failed execution; subsequent observations do not replace it. */
export class DeploymentFailureObservationDto {
  @ApiProperty({ minimum: 1 }) attempt!: number;
  @ApiProperty() errorCode!: string;
  @ApiProperty({ format: 'date-time' }) capturedAt!: string;
  @ApiProperty({ format: 'date-time' }) observedAt!: string;
  @ApiProperty({ enum: ['consistent', 'drifted', 'missing', 'unknown'] })
  configurationState!: string;
  @ApiProperty({ type: [WorkloadDriftDto], maxItems: 128 }) drift!: WorkloadDriftDto[];
  @ApiProperty({ type: [WorkloadResourceDto], maxItems: 64 }) resources!: WorkloadResourceDto[];
  @ApiProperty({ type: DeploymentFailureWorkloadDto, nullable: true })
  deployment!: DeploymentFailureWorkloadDto | null;
  @ApiPropertyOptional({ type: DeploymentFailureControllerDto, nullable: true })
  controller?: DeploymentFailureControllerDto | null;
  @ApiProperty({ type: [DeploymentFailurePodDto], maxItems: 32 }) pods!: DeploymentFailurePodDto[];
  @ApiProperty({ type: DeploymentFailureTruncationDto }) truncated!: DeploymentFailureTruncationDto;
}
