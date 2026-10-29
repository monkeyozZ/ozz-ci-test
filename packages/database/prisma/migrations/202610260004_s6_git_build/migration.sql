BEGIN;

-- AlterEnum
ALTER TYPE "SecretKind" ADD VALUE 'webhook';
ALTER TYPE "SecretKind" ADD VALUE 'builder';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "sourceKind" VARCHAR(16) NOT NULL DEFAULT 'image';

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "artifactId" UUID,
ADD COLUMN     "initiatorKind" VARCHAR(16) NOT NULL DEFAULT 'admin',
ADD COLUMN     "reuseArtifactId" UUID,
ADD COLUMN     "sourceRevisionId" UUID,
ADD COLUMN     "webhookDeliveryId" UUID,
ADD COLUMN     "webhookTargetId" UUID;

-- CreateTable
CREATE TABLE "GitHubConnection" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "credentialRefId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "verificationState" VARCHAR(32) NOT NULL DEFAULT 'unverified',
    "verifiedCredentialRefId" UUID,
    "verifiedAt" TIMESTAMP(3),
    "accountId" VARCHAR(32),
    "accountLogin" VARCHAR(100),
    "verificationJson" JSONB,
    "lastErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitHubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitRepository" (
    "id" UUID NOT NULL,
    "githubConnectionId" UUID NOT NULL,
    "githubRepositoryId" VARCHAR(32) NOT NULL,
    "fullName" VARCHAR(255) NOT NULL,
    "defaultBranch" VARCHAR(255) NOT NULL,
    "private" BOOLEAN NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lastVerifiedAt" TIMESTAMP(3) NOT NULL,
    "hookId" VARCHAR(32),
    "hookSecretRefId" UUID,
    "previousHookSecretRefId" UUID,
    "previousHookSecretUntil" TIMESTAMP(3),
    "candidateHookSecretRefId" UUID,
    "candidateHookSecretUntil" TIMESTAMP(3),
    "hookState" VARCHAR(32) NOT NULL DEFAULT 'unregistered',
    "hookVerifiedAt" TIMESTAMP(3),
    "hookErrorCode" VARCHAR(80),
    "hookOperationId" UUID,
    "hookCallbackId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitRepository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistryConnection" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "authority" VARCHAR(253) NOT NULL,
    "namespace" VARCHAR(255) NOT NULL,
    "pushCredentialRefId" UUID NOT NULL,
    "pullCredentialRefId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "pushVerificationState" VARCHAR(32) NOT NULL DEFAULT 'unverified',
    "pullVerificationState" VARCHAR(32) NOT NULL DEFAULT 'unverified',
    "pushVerifiedAt" TIMESTAMP(3),
    "pullVerifiedAt" TIMESTAMP(3),
    "pushVerificationJson" JSONB,
    "pullVerificationJson" JSONB,
    "pushErrorCode" VARCHAR(80),
    "pullErrorCode" VARCHAR(80),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RegistryConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Builder" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "instanceId" UUID NOT NULL,
    "identityPublicKey" VARCHAR(2048) NOT NULL,
    "endpoint" VARCHAR(2048) NOT NULL,
    "credentialRefId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "profileRevision" INTEGER NOT NULL DEFAULT 1,
    "profileJson" JSONB NOT NULL,
    "verificationState" VARCHAR(32) NOT NULL DEFAULT 'unverified',
    "verifiedAt" TIMESTAMP(3),
    "capabilitiesJson" JSONB,
    "lastObservedAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(80),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Builder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitSource" (
    "id" UUID NOT NULL,
    "originalServiceId" UUID NOT NULL,
    "serviceId" UUID,
    "currentRevisionId" UUID,
    "autoDeploy" BOOLEAN NOT NULL DEFAULT false,
    "policyRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GitSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitSourceRevision" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "githubConnectionId" UUID NOT NULL,
    "repositoryId" UUID NOT NULL,
    "builderId" UUID NOT NULL,
    "registryConnectionId" UUID NOT NULL,
    "branchRef" VARCHAR(270) NOT NULL,
    "recipeHash" CHAR(64) NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitSourceRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitSourceSecretReference" (
    "sourceRevisionId" UUID NOT NULL,
    "mountId" VARCHAR(64) NOT NULL,
    "secretRefId" UUID NOT NULL,
    "secretKey" VARCHAR(128) NOT NULL,
    "contentRevision" INTEGER NOT NULL,

    CONSTRAINT "GitSourceSecretReference_pkey" PRIMARY KEY ("sourceRevisionId","mountId")
);

-- CreateTable
CREATE TABLE "GitPublicationPreview" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "serviceRevision" INTEGER NOT NULL,
    "configRevision" INTEGER NOT NULL,
    "policyRevision" INTEGER NOT NULL,
    "sourceRevisionId" UUID NOT NULL,
    "webhookTargetId" UUID,
    "commitSha" CHAR(40) NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "targetJson" JSONB NOT NULL,
    "issuesJson" JSONB NOT NULL,
    "consumedDeploymentId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitPublicationPreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(16) NOT NULL DEFAULT 'github',
    "externalDeliveryId" VARCHAR(128) NOT NULL,
    "repositoryId" UUID NOT NULL,
    "githubRepositoryId" VARCHAR(32) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "event" VARCHAR(64) NOT NULL,
    "ref" VARCHAR(270),
    "afterSha" CHAR(40),
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(32) NOT NULL DEFAULT 'received',
    "reason" VARCHAR(80),
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "lastReceivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookRejection" (
    "repositoryId" UUID NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(80) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "WebhookRejection_pkey" PRIMARY KEY ("repositoryId","bucket","reason")
);

-- CreateTable
CREATE TABLE "WebhookTarget" (
    "id" UUID NOT NULL,
    "webhookDeliveryId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "currentServiceId" UUID,
    "sourceRevisionId" UUID NOT NULL,
    "commitSha" CHAR(40) NOT NULL,
    "configRevisionAtReceipt" INTEGER NOT NULL,
    "policyRevisionAtReceipt" INTEGER NOT NULL,
    "targetJson" JSONB NOT NULL,
    "receiptSequence" BIGSERIAL NOT NULL,
    "manualRequired" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(32) NOT NULL DEFAULT 'waiting',
    "reason" VARCHAR(80) NOT NULL DEFAULT 'ready',
    "deploymentId" UUID,
    "admittedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildRun" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "builderId" UUID NOT NULL,
    "builderInstanceId" UUID NOT NULL,
    "specJson" JSONB NOT NULL,
    "specHash" CHAR(64) NOT NULL,
    "generation" INTEGER NOT NULL,
    "ownershipEpoch" INTEGER NOT NULL DEFAULT 1,
    "submissionAttemptedAt" TIMESTAMP(3),
    "executionState" VARCHAR(32) NOT NULL DEFAULT 'prepared',
    "executionClosedAt" TIMESTAMP(3),
    "closureReason" VARCHAR(80),
    "endProofJson" JSONB,
    "proofVerifiedAt" TIMESTAMP(3),
    "phase" VARCHAR(64) NOT NULL DEFAULT 'prepared',
    "cancelRequestedAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3),
    "observationState" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "lastErrorCode" VARCHAR(80),
    "remoteLedgerRevision" BIGINT NOT NULL DEFAULT 0,
    "remoteEpochJson" JSONB,
    "reconcileLeaseToken" UUID,
    "reconcileLeaseExpiresAt" TIMESTAMP(3),
    "nextReconcileAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "afterSequence" BIGINT NOT NULL DEFAULT 0,
    "logBytes" INTEGER NOT NULL DEFAULT 0,
    "logsTruncated" BOOLEAN NOT NULL DEFAULT false,
    "logsExpireAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildArtifact" (
    "id" UUID NOT NULL,
    "producedByRunId" UUID NOT NULL,
    "sourceRevisionId" UUID NOT NULL,
    "registryConnectionId" UUID NOT NULL,
    "commitSha" CHAR(40) NOT NULL,
    "recipeHash" CHAR(64) NOT NULL,
    "specHash" CHAR(64) NOT NULL,
    "descriptorJson" JSONB NOT NULL,
    "rootDigest" VARCHAR(80) NOT NULL,
    "mediaType" VARCHAR(128) NOT NULL,
    "platformsJson" JSONB NOT NULL,
    "archiveHandle" VARCHAR(255) NOT NULL,
    "builderInstanceId" UUID NOT NULL,
    "archiveSha256" CHAR(64) NOT NULL,
    "archiveBytes" BIGINT NOT NULL,
    "archiveExpiresAt" TIMESTAMP(3) NOT NULL,
    "producedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locationState" VARCHAR(16) NOT NULL DEFAULT 'oci',
    "destinationJson" JSONB NOT NULL,
    "resolvedImageJson" JSONB,
    "pushedAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "availability" VARCHAR(32) NOT NULL DEFAULT 'available',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildLogChunk" (
    "runId" UUID NOT NULL,
    "sequence" BIGINT NOT NULL,
    "phase" VARCHAR(64) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "content" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuildLogChunk_pkey" PRIMARY KEY ("runId","sequence")
);

-- CreateIndex
CREATE INDEX "GitHubConnection_createdAt_id_idx" ON "GitHubConnection"("createdAt", "id");

-- CreateIndex
CREATE INDEX "GitRepository_createdAt_id_idx" ON "GitRepository"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GitRepository_githubConnectionId_githubRepositoryId_key" ON "GitRepository"("githubConnectionId", "githubRepositoryId");

-- CreateIndex
CREATE INDEX "RegistryConnection_createdAt_id_idx" ON "RegistryConnection"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RegistryConnection_authority_namespace_key" ON "RegistryConnection"("authority", "namespace");

-- CreateIndex
CREATE UNIQUE INDEX "Builder_instanceId_key" ON "Builder"("instanceId");

-- CreateIndex
CREATE INDEX "Builder_createdAt_id_idx" ON "Builder"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GitSource_serviceId_key" ON "GitSource"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "GitSource_currentRevisionId_key" ON "GitSource"("currentRevisionId");

-- CreateIndex
CREATE INDEX "GitSourceRevision_repositoryId_branchRef_idx" ON "GitSourceRevision"("repositoryId", "branchRef");

-- CreateIndex
CREATE UNIQUE INDEX "GitSourceRevision_sourceId_revision_key" ON "GitSourceRevision"("sourceId", "revision");

-- CreateIndex
CREATE INDEX "GitSourceSecretReference_secretRefId_idx" ON "GitSourceSecretReference"("secretRefId");

-- CreateIndex
CREATE UNIQUE INDEX "GitPublicationPreview_consumedDeploymentId_key" ON "GitPublicationPreview"("consumedDeploymentId");

-- CreateIndex
CREATE INDEX "GitPublicationPreview_serviceId_createdAt_idx" ON "GitPublicationPreview"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "GitPublicationPreview_expiresAt_idx" ON "GitPublicationPreview"("expiresAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_createdAt_id_idx" ON "WebhookDelivery"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_provider_externalDeliveryId_key" ON "WebhookDelivery"("provider", "externalDeliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookTarget_receiptSequence_key" ON "WebhookTarget"("receiptSequence");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookTarget_deploymentId_key" ON "WebhookTarget"("deploymentId");

-- CreateIndex
CREATE INDEX "WebhookTarget_currentServiceId_state_receiptSequence_idx" ON "WebhookTarget"("currentServiceId", "state", "receiptSequence");

-- CreateIndex
CREATE INDEX "WebhookTarget_state_nextAttemptAt_receiptSequence_idx" ON "WebhookTarget"("state", "nextAttemptAt", "receiptSequence");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookTarget_webhookDeliveryId_serviceId_key" ON "WebhookTarget"("webhookDeliveryId", "serviceId");

-- CreateIndex
CREATE INDEX "BuildRun_executionClosedAt_nextReconcileAt_idx" ON "BuildRun"("executionClosedAt", "nextReconcileAt");

-- CreateIndex
CREATE UNIQUE INDEX "BuildRun_deploymentId_runNumber_key" ON "BuildRun"("deploymentId", "runNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BuildArtifact_producedByRunId_key" ON "BuildArtifact"("producedByRunId");

-- CreateIndex
CREATE INDEX "BuildArtifact_archiveExpiresAt_idx" ON "BuildArtifact"("archiveExpiresAt");

-- CreateIndex
CREATE INDEX "BuildLogChunk_expiresAt_idx" ON "BuildLogChunk"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_webhookTargetId_key" ON "Deployment"("webhookTargetId");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_sourceRevisionId_fkey" FOREIGN KEY ("sourceRevisionId") REFERENCES "GitSourceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_reuseArtifactId_fkey" FOREIGN KEY ("reuseArtifactId") REFERENCES "BuildArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "BuildArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_webhookDeliveryId_fkey" FOREIGN KEY ("webhookDeliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_webhookTargetId_fkey" FOREIGN KEY ("webhookTargetId") REFERENCES "WebhookTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitHubConnection" ADD CONSTRAINT "GitHubConnection_credentialRefId_fkey" FOREIGN KEY ("credentialRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_githubConnectionId_fkey" FOREIGN KEY ("githubConnectionId") REFERENCES "GitHubConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_hookSecretRefId_fkey" FOREIGN KEY ("hookSecretRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_previousHookSecretRefId_fkey" FOREIGN KEY ("previousHookSecretRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GitRepository" ADD CONSTRAINT "GitRepository_candidateHookSecretRefId_fkey" FOREIGN KEY ("candidateHookSecretRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryConnection" ADD CONSTRAINT "RegistryConnection_pushCredentialRefId_fkey" FOREIGN KEY ("pushCredentialRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistryConnection" ADD CONSTRAINT "RegistryConnection_pullCredentialRefId_fkey" FOREIGN KEY ("pullCredentialRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Builder" ADD CONSTRAINT "Builder_credentialRefId_fkey" FOREIGN KEY ("credentialRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSource" ADD CONSTRAINT "GitSource_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSource" ADD CONSTRAINT "GitSource_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "GitSourceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceRevision" ADD CONSTRAINT "GitSourceRevision_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "GitSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceRevision" ADD CONSTRAINT "GitSourceRevision_githubConnectionId_fkey" FOREIGN KEY ("githubConnectionId") REFERENCES "GitHubConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceRevision" ADD CONSTRAINT "GitSourceRevision_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "GitRepository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceRevision" ADD CONSTRAINT "GitSourceRevision_builderId_fkey" FOREIGN KEY ("builderId") REFERENCES "Builder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceRevision" ADD CONSTRAINT "GitSourceRevision_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceSecretReference" ADD CONSTRAINT "GitSourceSecretReference_sourceRevisionId_fkey" FOREIGN KEY ("sourceRevisionId") REFERENCES "GitSourceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitSourceSecretReference" ADD CONSTRAINT "GitSourceSecretReference_secretRefId_fkey" FOREIGN KEY ("secretRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublicationPreview" ADD CONSTRAINT "GitPublicationPreview_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublicationPreview" ADD CONSTRAINT "GitPublicationPreview_sourceRevisionId_fkey" FOREIGN KEY ("sourceRevisionId") REFERENCES "GitSourceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublicationPreview" ADD CONSTRAINT "GitPublicationPreview_webhookTargetId_fkey" FOREIGN KEY ("webhookTargetId") REFERENCES "WebhookTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitPublicationPreview" ADD CONSTRAINT "GitPublicationPreview_consumedDeploymentId_fkey" FOREIGN KEY ("consumedDeploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "GitRepository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookRejection" ADD CONSTRAINT "WebhookRejection_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "GitRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookTarget" ADD CONSTRAINT "WebhookTarget_webhookDeliveryId_fkey" FOREIGN KEY ("webhookDeliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookTarget" ADD CONSTRAINT "WebhookTarget_currentServiceId_fkey" FOREIGN KEY ("currentServiceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookTarget" ADD CONSTRAINT "WebhookTarget_sourceRevisionId_fkey" FOREIGN KEY ("sourceRevisionId") REFERENCES "GitSourceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookTarget" ADD CONSTRAINT "WebhookTarget_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_builderId_fkey" FOREIGN KEY ("builderId") REFERENCES "Builder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_producedByRunId_fkey" FOREIGN KEY ("producedByRunId") REFERENCES "BuildRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_sourceRevisionId_fkey" FOREIGN KEY ("sourceRevisionId") REFERENCES "GitSourceRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_registryConnectionId_fkey" FOREIGN KEY ("registryConnectionId") REFERENCES "RegistryConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildLogChunk" ADD CONSTRAINT "BuildLogChunk_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BuildRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- S6 is additive. The existing Service/Volume/Outbox integrity triggers remain
-- installed; these guards also cover execution that outlives a Worker lease.
ALTER TABLE "Service" ADD CONSTRAINT "Service_source_kind" CHECK ("sourceKind" IN ('image', 'github'));
ALTER TABLE "RegistryConnection" ADD CONSTRAINT "RegistryConnection_separate_credentials" CHECK ("pushCredentialRefId" <> "pullCredentialRefId");
ALTER TABLE "GitSourceRevision" ADD CONSTRAINT "GitSourceRevision_hash" CHECK ("recipeHash" ~ '^[0-9a-f]{64}$' AND "revision" > 0);
ALTER TABLE "WebhookTarget" ADD CONSTRAINT "WebhookTarget_state" CHECK ("state" IN ('waiting', 'pending', 'ignored', 'orphaned', 'enqueued'));
ALTER TABLE "WebhookTarget" ADD CONSTRAINT "WebhookTarget_admission" CHECK (("state" = 'enqueued' AND "deploymentId" IS NOT NULL AND "admittedAt" IS NOT NULL) OR ("state" <> 'enqueued' AND "deploymentId" IS NULL AND "admittedAt" IS NULL));
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_execution_state" CHECK (
  ("executionState" IN ('prepared','open') AND "executionClosedAt" IS NULL AND "endProofJson" IS NULL AND "proofVerifiedAt" IS NULL) OR
  ("executionState" = 'never_submitted' AND "executionClosedAt" IS NOT NULL AND "submissionAttemptedAt" IS NULL AND "endProofJson" IS NULL AND "proofVerifiedAt" IS NULL AND "closureReason" IN ('cancelled_before_submission','rejected_before_submission')) OR
  ("executionState" = 'ended' AND "executionClosedAt" IS NOT NULL AND "endProofJson" IS NOT NULL AND "proofVerifiedAt" IS NOT NULL)
);
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_bounds" CHECK ("runNumber" > 0 AND "ownershipEpoch" > 0 AND "generation" >= 0 AND "remoteLedgerRevision" >= 0 AND "afterSequence" >= 0 AND "logBytes" >= 0 AND "specHash" ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX "BuildRun_one_open_per_deployment" ON "BuildRun" ("deploymentId") WHERE "executionClosedAt" IS NULL;
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_state" CHECK ("locationState" IN ('oci','registry') AND ("locationState" <> 'registry' OR "pushedAt" IS NOT NULL));
ALTER TABLE "BuildArtifact" ADD CONSTRAINT "BuildArtifact_identity_shape" CHECK ("archiveBytes" > 0 AND "archiveSha256" ~ '^[0-9a-f]{64}$' AND "commitSha" ~ '^[0-9a-f]{40}$' AND "rootDigest" ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE "BuildLogChunk" ADD CONSTRAINT "BuildLogChunk_bounds" CHECK ("sequence" >= 0 AND "bytes" >= 0 AND "bytes" <= 8192 AND octet_length("content") = "bytes");

CREATE FUNCTION "ozz_s6_immutable_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Git source revision history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Git source revisions are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GitSourceRevision_immutable" BEFORE UPDATE OR DELETE ON "GitSourceRevision" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_immutable_source"();
CREATE TRIGGER "GitSourceSecretReference_immutable" BEFORE UPDATE OR DELETE ON "GitSourceSecretReference" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_immutable_source"();

CREATE FUNCTION "ozz_s6_source_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."originalServiceId") IS DISTINCT FROM (OLD."id", OLD."originalServiceId") OR
     (NEW."serviceId" IS NOT NULL AND NEW."serviceId" IS DISTINCT FROM OLD."serviceId") THEN
    RAISE EXCEPTION 'Git source original service identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GitSource_identity" BEFORE UPDATE ON "GitSource" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_source_identity"();

CREATE FUNCTION "ozz_s6_credential_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'RegistryConnection' THEN
    IF (NEW."authority", NEW."namespace") IS DISTINCT FROM (OLD."authority", OLD."namespace") THEN RAISE EXCEPTION 'Registry destination identity is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME = 'Builder' THEN
    IF (NEW."instanceId", NEW."identityPublicKey") IS DISTINCT FROM (OLD."instanceId", OLD."identityPublicKey") THEN RAISE EXCEPTION 'Builder signing identity is immutable' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME = 'GitRepository' THEN
    IF (NEW."githubConnectionId", NEW."githubRepositoryId") IS DISTINCT FROM (OLD."githubConnectionId", OLD."githubRepositoryId") THEN RAISE EXCEPTION 'GitHub repository numeric identity is immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RegistryConnection_identity" BEFORE UPDATE ON "RegistryConnection" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_credential_identity"();
CREATE TRIGGER "Builder_identity" BEFORE UPDATE ON "Builder" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_credential_identity"();
CREATE TRIGGER "GitRepository_identity" BEFORE UPDATE ON "GitRepository" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_credential_identity"();

CREATE FUNCTION "ozz_s6_build_secret_bytes"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."kind", NEW."contentRevision", NEW."encryptedPayload", NEW."nonce", NEW."tag", NEW."keyVersion") IS DISTINCT FROM
     (OLD."kind", OLD."contentRevision", OLD."encryptedPayload", OLD."nonce", OLD."tag", OLD."keyVersion") AND
     EXISTS (SELECT 1 FROM "GitSourceSecretReference" WHERE "secretRefId" = OLD."id") THEN
    RAISE EXCEPTION 'A referenced build secret retains its original encrypted bytes; create a new reference' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "SecretReference_build_bytes" BEFORE UPDATE ON "SecretReference" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_build_secret_bytes"();

CREATE FUNCTION "ozz_s6_check_service_source"(service_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s "Service"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "Service" WHERE "id"=service_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF s."sourceKind"='github' THEN
    IF s."kind" <> 'application' OR s."templateId" IS NOT NULL OR s."registryCredentialRefId" IS NOT NULL OR s."configJson" ? 'image' OR
       EXISTS (SELECT 1 FROM "DatabaseInstance" WHERE "serviceId"=s."id") OR
       NOT EXISTS (SELECT 1 FROM "GitSource" g JOIN "GitSourceRevision" r ON r."id"=g."currentRevisionId" AND r."sourceId"=g."id" WHERE g."serviceId"=s."id" AND g."originalServiceId"=s."id") THEN
      RAISE EXCEPTION 'Git service requires its own valid source and runtime-only configuration' USING ERRCODE='23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM "GitSource" WHERE "serviceId"=s."id") THEN
    RAISE EXCEPTION 'Image service cannot own a Git source' USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION "ozz_s6_validate_source"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='Service' THEN PERFORM "ozz_s6_check_service_source"(NEW."id");
  ELSIF TG_TABLE_NAME='DatabaseInstance' THEN PERFORM "ozz_s6_check_service_source"(NEW."serviceId");
  ELSE
    IF TG_OP <> 'DELETE' THEN PERFORM "ozz_s6_check_service_source"(NEW."serviceId"); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM "ozz_s6_check_service_source"(OLD."serviceId"); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "Service_git_source" AFTER INSERT OR UPDATE ON "Service" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_source"();
CREATE CONSTRAINT TRIGGER "GitSource_service" AFTER INSERT OR UPDATE OR DELETE ON "GitSource" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_source"();
CREATE CONSTRAINT TRIGGER "DatabaseInstance_no_git" AFTER INSERT OR UPDATE ON "DatabaseInstance" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_source"();

CREATE FUNCTION "ozz_s6_guard_target"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id",NEW."webhookDeliveryId",NEW."serviceId",NEW."sourceRevisionId",NEW."commitSha",NEW."configRevisionAtReceipt",NEW."policyRevisionAtReceipt",NEW."targetJson",NEW."receiptSequence") IS DISTINCT FROM
     (OLD."id",OLD."webhookDeliveryId",OLD."serviceId",OLD."sourceRevisionId",OLD."commitSha",OLD."configRevisionAtReceipt",OLD."policyRevisionAtReceipt",OLD."targetJson",OLD."receiptSequence") OR
     (OLD."manualRequired" AND NOT NEW."manualRequired") OR
     (OLD."deploymentId" IS NOT NULL AND (NEW."deploymentId",NEW."admittedAt") IS DISTINCT FROM (OLD."deploymentId",OLD."admittedAt")) OR
     (NEW."currentServiceId" IS NOT NULL AND NEW."currentServiceId" IS DISTINCT FROM OLD."currentServiceId") THEN
    RAISE EXCEPTION 'Webhook target identity, admission and stopped latch are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "WebhookTarget_identity" BEFORE UPDATE ON "WebhookTarget" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_guard_target"();

CREATE FUNCTION "ozz_s6_guard_deployment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."kind",NEW."sourceRevisionId",NEW."reuseArtifactId",NEW."initiatorKind",NEW."webhookDeliveryId",NEW."webhookTargetId") IS DISTINCT FROM
     (OLD."kind",OLD."sourceRevisionId",OLD."reuseArtifactId",OLD."initiatorKind",OLD."webhookDeliveryId",OLD."webhookTargetId") OR
     (OLD."artifactId" IS NOT NULL AND NEW."artifactId" IS DISTINCT FROM OLD."artifactId") THEN
    RAISE EXCEPTION 'Deployment Git intent and acquired artifact are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Deployment_git_intent" BEFORE UPDATE ON "Deployment" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_guard_deployment"();

CREATE FUNCTION "ozz_s6_guard_run"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Build run ledger cannot be deleted' USING ERRCODE='23514'; END IF;
  -- Parent row serializes an external send intent against terminal/slot changes.
  PERFORM 1 FROM "Deployment" WHERE "id"=NEW."deploymentId" FOR UPDATE;
  IF TG_OP='UPDATE' AND (
    (NEW."id",NEW."deploymentId",NEW."runNumber",NEW."builderId",NEW."builderInstanceId",NEW."specJson",NEW."specHash") IS DISTINCT FROM
    (OLD."id",OLD."deploymentId",OLD."runNumber",OLD."builderId",OLD."builderInstanceId",OLD."specJson",OLD."specHash") OR
    (OLD."submissionAttemptedAt" IS NOT NULL AND NEW."submissionAttemptedAt" IS DISTINCT FROM OLD."submissionAttemptedAt") OR
    (NEW."generation",NEW."ownershipEpoch") < (OLD."generation",OLD."ownershipEpoch") OR NEW."remoteLedgerRevision" < OLD."remoteLedgerRevision" OR
    (OLD."cancelRequestedAt" IS NOT NULL AND NEW."cancelRequestedAt" IS NULL) OR
    (OLD."executionClosedAt" IS NOT NULL AND (NEW."executionState",NEW."executionClosedAt",NEW."closureReason",NEW."endProofJson",NEW."proofVerifiedAt",NEW."submissionAttemptedAt") IS DISTINCT FROM
      (OLD."executionState",OLD."executionClosedAt",OLD."closureReason",OLD."endProofJson",OLD."proofVerifiedAt",OLD."submissionAttemptedAt"))
  ) THEN RAISE EXCEPTION 'Build run identity, send intent and verified end facts are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BuildRun_ledger" BEFORE INSERT OR UPDATE OR DELETE ON "BuildRun" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_guard_run"();

CREATE FUNCTION "ozz_s6_guard_artifact"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id",NEW."producedByRunId",NEW."sourceRevisionId",NEW."registryConnectionId",NEW."commitSha",NEW."recipeHash",NEW."specHash",NEW."descriptorJson",NEW."rootDigest",NEW."mediaType",NEW."platformsJson",NEW."archiveHandle",NEW."builderInstanceId",NEW."archiveSha256",NEW."archiveBytes",NEW."archiveExpiresAt",NEW."producedAt",NEW."destinationJson") IS DISTINCT FROM
     (OLD."id",OLD."producedByRunId",OLD."sourceRevisionId",OLD."registryConnectionId",OLD."commitSha",OLD."recipeHash",OLD."specHash",OLD."descriptorJson",OLD."rootDigest",OLD."mediaType",OLD."platformsJson",OLD."archiveHandle",OLD."builderInstanceId",OLD."archiveSha256",OLD."archiveBytes",OLD."archiveExpiresAt",OLD."producedAt",OLD."destinationJson") OR
     (OLD."locationState"='registry' AND NEW."locationState" <> 'registry') OR
     (OLD."pushedAt" IS NOT NULL AND NEW."pushedAt" IS DISTINCT FROM OLD."pushedAt") THEN
    RAISE EXCEPTION 'Artifact content identity and trusted push receipt cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "BuildArtifact_identity" BEFORE UPDATE ON "BuildArtifact" FOR EACH ROW EXECUTE FUNCTION "ozz_s6_guard_artifact"();

CREATE FUNCTION "ozz_s6_check_execution_gate"(deployment_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d "Deployment"%ROWTYPE;
BEGIN
  IF deployment_id IS NULL THEN RETURN; END IF;
  SELECT * INTO d FROM "Deployment" WHERE "id"=deployment_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM "BuildRun" WHERE "deploymentId"=deployment_id AND "executionClosedAt" IS NULL) AND (
    d."status" <> 'running' OR d."serviceId" IS NULL OR
    NOT EXISTS (SELECT 1 FROM "ServiceMutation" WHERE "serviceId"=d."serviceId" AND "deploymentId"=d."id") OR
    EXISTS (SELECT 1 FROM "DeploymentVolumeReference" r LEFT JOIN "VolumeMutation" m ON m."volumeId"=r."volumeId" AND m."deploymentId"=d."id" WHERE r."deploymentId"=d."id" AND m."volumeId" IS NULL)
  ) THEN RAISE EXCEPTION 'Unclosed remote execution forbids terminal status or mutation slot release' USING ERRCODE='23514'; END IF;
END $$;
CREATE FUNCTION "ozz_s6_validate_execution_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='Deployment' THEN PERFORM "ozz_s6_check_execution_gate"(NEW."id");
  ELSE
    IF TG_OP <> 'DELETE' THEN PERFORM "ozz_s6_check_execution_gate"(NEW."deploymentId"); END IF;
    IF TG_OP <> 'INSERT' THEN PERFORM "ozz_s6_check_execution_gate"(OLD."deploymentId"); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "BuildRun_execution_gate" AFTER INSERT OR UPDATE ON "BuildRun" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_execution_gate"();
CREATE CONSTRAINT TRIGGER "Deployment_execution_gate" AFTER INSERT OR UPDATE ON "Deployment" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_execution_gate"();
CREATE CONSTRAINT TRIGGER "ServiceMutation_execution_gate" AFTER INSERT OR UPDATE OR DELETE ON "ServiceMutation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_execution_gate"();
CREATE CONSTRAINT TRIGGER "VolumeMutation_execution_gate" AFTER INSERT OR UPDATE OR DELETE ON "VolumeMutation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "ozz_s6_validate_execution_gate"();

COMMIT;
