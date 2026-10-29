import { ApiProperty } from '@nestjs/swagger';

export class WebhookRegistrationInputDto {
  @ApiProperty({ format: 'uuid' }) integrationId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['register_webhook'] }) action!: 'register_webhook';
  @ApiProperty({ format: 'uuid' }) hookSecretRefId!: string;
  @ApiProperty() callbackUrl!: string;
}
export class RegistryProbeInputDto {
  @ApiProperty({ format: 'uuid' }) integrationId!: string;
  @ApiProperty() revision!: number;
  @ApiProperty({ enum: ['validate_registry'] }) action!: 'validate_registry';
  @ApiProperty() probeRepository!: string;
}
export class WebhookRegistrationResultDto {
  @ApiProperty({ format: 'uuid' }) repositoryId!: string;
  @ApiProperty() hookId!: string;
  @ApiProperty({ enum: [true] }) registered!: true;
}
export class RegistryProbeResultDto {
  @ApiProperty({ enum: [true] }) push!: true;
  @ApiProperty({ enum: [true] }) pull!: true;
  @ApiProperty({ enum: [true] }) pullCannotPush!: true;
  @ApiProperty() probeReference!: string;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
  @ApiProperty() probeRetained!: boolean;
}
