import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { VolumeOperationInput, VolumeTarget } from '@ozz/control-plane/storage';

export class VolumeOperationTargetDto implements VolumeTarget {
  @ApiProperty({ format: 'uuid' }) installationId!: string;
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty() kubeSystemUid!: string;
  @ApiProperty({ format: 'uuid' }) projectId!: string;
  @ApiProperty({ format: 'uuid' }) environmentId!: string;
  @ApiProperty() namespace!: string;
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
}
export class VolumeTaskConfirmationDto {
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty({ type: String, nullable: true }) pvcUid!: string | null;
  @ApiProperty({ type: String, enum: ['Delete', 'Retain'], nullable: true }) reclaimPolicy!:
    'Delete' | 'Retain' | null;
  @ApiProperty() previewDigest!: string;
  @ApiProperty() volumeName!: string;
}
export class VolumeOperationInputDto implements VolumeOperationInput {
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty() volumeRevision!: number;
  @ApiProperty() mutationRevision!: number;
  @ApiProperty({ type: VolumeOperationTargetDto }) target!: VolumeOperationTargetDto;
  @ApiPropertyOptional({ format: 'uuid' }) maintenanceId?: string;
  @ApiPropertyOptional({ type: VolumeTaskConfirmationDto })
  confirmation?: VolumeTaskConfirmationDto;
}
export class VolumeOperationResultDto {
  @ApiProperty({ format: 'uuid' }) volumeId!: string;
  @ApiProperty() state!: string;
  @ApiPropertyOptional({ format: 'date-time' }) observedAt?: string;
  @ApiPropertyOptional({ format: 'uuid' }) maintenanceId?: string;
  @ApiPropertyOptional() neverCreated?: boolean;
}
