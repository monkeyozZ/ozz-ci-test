import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServiceTaskTargetDto } from '../services/execution.dto.js';
import {
  DomainCertificateObservationDto,
  DomainDnsObservationDto,
  DomainRouteObservationDto,
  NetworkingCapabilitiesDto,
} from './networking.dto.js';

export class DomainTaskTargetDto extends ServiceTaskTargetDto {
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceUid!: string;
  @ApiProperty({ format: 'uuid' }) domainId!: string;
  @ApiProperty() hostname!: string;
  @ApiProperty({ format: 'uuid' }) portId!: string;
  @ApiProperty() portName!: string;
}
export class StagingVerificationDto {
  @ApiProperty({ enum: ['letsencrypt', 'local_test'] }) authority!: 'letsencrypt' | 'local_test';
  @ApiProperty({ format: 'date-time' }) certificateObservedAt!: string;
  @ApiProperty({ format: 'date-time' }) certificateNotAfter!: string;
  @ApiProperty({ format: 'date-time' }) dnsObservedAt!: string;
}
export class DomainOperationInputDto {
  @ApiProperty({ format: 'uuid' }) domainId!: string;
  @ApiProperty() hostname!: string;
  @ApiProperty({ format: 'uuid' }) serviceId!: string;
  @ApiProperty() serviceMutationRevision!: number;
  @ApiProperty() domainRevision!: number;
  @ApiProperty() platformRevision!: number;
  @ApiProperty() networkRevision!: number;
  @ApiProperty({ enum: ['staging', 'production'] }) certificateEnvironment!:
    'staging' | 'production';
  @ApiPropertyOptional({ type: StagingVerificationDto })
  stagingVerification?: StagingVerificationDto;
  @ApiProperty({ type: DomainTaskTargetDto }) target!: DomainTaskTargetDto;
}
export class ClusterNetworkingOperationInputDto {
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ format: 'uuid' }) installationId!: string;
  @ApiProperty() kubeSystemUid!: string;
  @ApiProperty() clusterConnectionRevision!: number;
  @ApiProperty() networkRevision!: number;
}
export class DomainOperationResultDto {
  @ApiProperty({ format: 'uuid' }) domainId!: string;
  @ApiProperty() hostname!: string;
  @ApiProperty({ enum: ['bind', 'sync', 'reconcile', 'unbind', 'production'] }) action!: string;
  @ApiProperty({ format: 'date-time' }) completedAt!: string;
  @ApiProperty({ type: DomainDnsObservationDto, nullable: true })
  dns!: DomainDnsObservationDto | null;
  @ApiProperty({ type: DomainRouteObservationDto, nullable: true })
  route!: DomainRouteObservationDto | null;
  @ApiProperty({ type: DomainCertificateObservationDto, nullable: true })
  certificate!: DomainCertificateObservationDto | null;
}
export class ClusterNetworkingOperationResultDto {
  @ApiProperty({ format: 'uuid' }) clusterId!: string;
  @ApiProperty({ type: NetworkingCapabilitiesDto }) capabilities!: NetworkingCapabilitiesDto;
}
