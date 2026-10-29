BEGIN;

-- CreateEnum
CREATE TYPE "ServiceDesiredState" AS ENUM ('running', 'stopped');

-- CreateEnum
CREATE TYPE "ServiceConfigurationState" AS ENUM ('unpublished', 'consistent', 'partial', 'drifted', 'unknown');

-- AlterTable
ALTER TABLE "ControlPlaneState" ADD COLUMN     "installationId" UUID NOT NULL DEFAULT gen_random_uuid();

-- AlterTable
ALTER TABLE "Operation" ADD COLUMN     "serviceId" UUID;

-- AlterTable
ALTER TABLE "Outbox" ADD COLUMN     "deploymentId" UUID,
ALTER COLUMN "operationId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "description" VARCHAR(1000),
    "kind" VARCHAR(32) NOT NULL DEFAULT 'application',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "configRevision" INTEGER NOT NULL DEFAULT 1,
    "configJson" JSONB NOT NULL,
    "registryCredentialRefId" UUID,
    "desiredState" "ServiceDesiredState" NOT NULL DEFAULT 'running',
    "configurationState" "ServiceConfigurationState" NOT NULL DEFAULT 'unpublished',
    "mutationRevision" INTEGER NOT NULL DEFAULT 0,
    "publishedDeploymentId" UUID,
    "lastSuccessfulDeploymentId" UUID,
    "remoteCreatedAt" TIMESTAMP(3),
    "observationJson" JSONB,
    "lastObservedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastErrorCode" VARCHAR(80),
    "lastErrorMessage" VARCHAR(1000),
    "nextObservationAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observationFailures" INTEGER NOT NULL DEFAULT 0,
    "observationLeaseToken" UUID,
    "observationLeaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServicePort" (
    "id" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "name" VARCHAR(15) NOT NULL,
    "protocol" VARCHAR(8) NOT NULL,
    "containerPort" INTEGER NOT NULL,
    "servicePort" INTEGER NOT NULL,

    CONSTRAINT "ServicePort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceSecretReference" (
    "serviceId" UUID NOT NULL,
    "secretRefId" UUID NOT NULL,

    CONSTRAINT "ServiceSecretReference_pkey" PRIMARY KEY ("serviceId","secretRefId")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(64) NOT NULL DEFAULT 'image_deploy',
    "scope" VARCHAR(64) NOT NULL DEFAULT 'service',
    "status" "OperationStatus" NOT NULL DEFAULT 'queued',
    "phase" VARCHAR(64) NOT NULL DEFAULT 'queued',
    "input" JSONB NOT NULL,
    "result" JSONB,
    "logsJson" JSONB,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "createdById" UUID,
    "requestId" VARCHAR(128),
    "idempotencyScope" VARCHAR(160) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(128),
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(80),
    "errorMessage" VARCHAR(1000),
    "retryOfId" UUID,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "serviceId" UUID,
    "configRevision" INTEGER NOT NULL,
    "mutationRevision" INTEGER NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "targetJson" JSONB NOT NULL,
    "resolvedImageJson" JSONB,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentStage" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(32) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(80),

    CONSTRAINT "DeploymentStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentSecretReference" (
    "deploymentId" UUID NOT NULL,
    "secretRefId" UUID NOT NULL,

    CONSTRAINT "DeploymentSecretReference_pkey" PRIMARY KEY ("deploymentId","secretRefId")
);

-- CreateTable
CREATE TABLE "ServiceMutation" (
    "serviceId" UUID NOT NULL,
    "operationId" UUID,
    "deploymentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceMutation_pkey" PRIMARY KEY ("serviceId")
);

-- CreateTable
CREATE TABLE "ManagedResource" (
    "id" UUID NOT NULL,
    "clusterId" UUID NOT NULL,
    "environmentId" UUID,
    "serviceId" UUID,
    "kind" VARCHAR(64) NOT NULL,
    "namespace" VARCHAR(63) NOT NULL,
    "name" VARCHAR(253) NOT NULL,
    "targetJson" JSONB NOT NULL,
    "creationNonce" UUID NOT NULL,
    "creationAttempted" BOOLEAN NOT NULL DEFAULT false,
    "uid" VARCHAR(128),
    "resourceVersion" VARCHAR(128),
    "mutationRevision" INTEGER NOT NULL DEFAULT 0,
    "receiptJson" JSONB,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManagedResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_publishedDeploymentId_key" ON "Service"("publishedDeploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Service_lastSuccessfulDeploymentId_key" ON "Service"("lastSuccessfulDeploymentId");

-- CreateIndex
CREATE INDEX "Service_createdAt_id_idx" ON "Service"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Service_nextObservationAt_idx" ON "Service"("nextObservationAt");

-- CreateIndex
CREATE UNIQUE INDEX "Service_environmentId_slug_key" ON "Service"("environmentId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ServicePort_serviceId_name_key" ON "ServicePort"("serviceId", "name");

-- CreateIndex
CREATE INDEX "Deployment_status_nextAttemptAt_idx" ON "Deployment"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Deployment_serviceId_createdAt_idx" ON "Deployment"("serviceId", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_createdAt_id_idx" ON "Deployment"("createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Deployment_idempotencyScope_idempotencyKey_key" ON "Deployment"("idempotencyScope", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentStage_deploymentId_attempt_name_key" ON "DeploymentStage"("deploymentId", "attempt", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceMutation_operationId_key" ON "ServiceMutation"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceMutation_deploymentId_key" ON "ServiceMutation"("deploymentId");

-- CreateIndex
CREATE INDEX "ManagedResource_environmentId_idx" ON "ManagedResource"("environmentId");

-- CreateIndex
CREATE INDEX "ManagedResource_serviceId_idx" ON "ManagedResource"("serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedResource_clusterId_kind_namespace_name_key" ON "ManagedResource"("clusterId", "kind", "namespace", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ControlPlaneState_installationId_key" ON "ControlPlaneState"("installationId");

-- CreateIndex
CREATE INDEX "Operation_serviceId_createdAt_idx" ON "Operation"("serviceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_deploymentId_key" ON "Outbox"("deploymentId");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_registryCredentialRefId_fkey" FOREIGN KEY ("registryCredentialRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_publishedDeploymentId_fkey" FOREIGN KEY ("publishedDeploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_lastSuccessfulDeploymentId_fkey" FOREIGN KEY ("lastSuccessfulDeploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicePort" ADD CONSTRAINT "ServicePort_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSecretReference" ADD CONSTRAINT "ServiceSecretReference_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceSecretReference" ADD CONSTRAINT "ServiceSecretReference_secretRefId_fkey" FOREIGN KEY ("secretRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Admin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "DeploymentStage" ADD CONSTRAINT "DeploymentStage_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSecretReference" ADD CONSTRAINT "DeploymentSecretReference_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentSecretReference" ADD CONSTRAINT "DeploymentSecretReference_secretRefId_fkey" FOREIGN KEY ("secretRefId") REFERENCES "SecretReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceMutation" ADD CONSTRAINT "ServiceMutation_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceMutation" ADD CONSTRAINT "ServiceMutation_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceMutation" ADD CONSTRAINT "ServiceMutation_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManagedResource" ADD CONSTRAINT "ManagedResource_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Infrastructure admission is separate from service mutation admission.
DROP INDEX "Operation_active_cluster_key";
CREATE UNIQUE INDEX "Operation_active_cluster_key" ON "Operation" ("clusterId")
  WHERE "clusterId" IS NOT NULL AND "scope" <> 'service' AND "status" IN ('queued', 'running');

ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_one_task"
  CHECK (num_nonnulls("operationId", "deploymentId") = 1);
ALTER TABLE "ServiceMutation" ADD CONSTRAINT "ServiceMutation_one_task"
  CHECK (num_nonnulls("operationId", "deploymentId") = 1);
ALTER TABLE "ServicePort" ADD CONSTRAINT "ServicePort_valid_target"
  CHECK ("protocol" IN ('http', 'tcp') AND "containerPort" BETWEEN 1 AND 65535 AND "servicePort" BETWEEN 1 AND 65535);
CREATE UNIQUE INDEX "ServicePort_serviceId_servicePort_key" ON "ServicePort" ("serviceId", "servicePort");
ALTER TABLE "Service" ADD CONSTRAINT "Service_positive_revisions"
  CHECK ("revision" > 0 AND "configRevision" > 0 AND "mutationRevision" >= 0);
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_positive_revisions"
  CHECK ("configRevision" > 0 AND "mutationRevision" > 0);

-- Queries keep their original service scope after a deleted Service FK becomes NULL.
CREATE INDEX "Deployment_original_service_idx" ON "Deployment" (("input"->>'serviceId'), "createdAt");
CREATE INDEX "Operation_original_service_idx" ON "Operation" (("input"->>'serviceId'), "createdAt") WHERE "scope" = 'service';

-- Admission and release are transactional. Deferred checks permit creating a
-- task and its common service slot in either order within that transaction.
CREATE FUNCTION "ozz_validate_service_task"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_service uuid;
  task_status "OperationStatus";
BEGIN
  IF TG_TABLE_NAME = 'Deployment' THEN
    SELECT "serviceId", "status" INTO task_service, task_status FROM "Deployment" WHERE "id" = NEW."id";
    IF task_status IN ('queued', 'running') AND
      (task_service IS NULL OR NOT EXISTS (
        SELECT 1 FROM "ServiceMutation" WHERE "serviceId" = task_service AND "deploymentId" = NEW."id"
      )) THEN
      RAISE EXCEPTION 'Active deployment requires its service mutation slot' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "serviceId", "status" INTO task_service, task_status FROM "Operation" WHERE "id" = NEW."id";
    IF task_service IS NOT NULL AND task_status IN ('queued', 'running') AND NOT EXISTS (
      SELECT 1 FROM "ServiceMutation" WHERE "serviceId" = task_service AND "operationId" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'Active service operation requires its mutation slot' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "Deployment_service_slot"
  AFTER INSERT OR UPDATE ON "Deployment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ozz_validate_service_task"();
CREATE CONSTRAINT TRIGGER "Operation_service_slot"
  AFTER INSERT OR UPDATE ON "Operation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ozz_validate_service_task"();

CREATE FUNCTION "ozz_validate_service_slot"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  slot "ServiceMutation"%ROWTYPE;
BEGIN
  SELECT * INTO slot FROM "ServiceMutation" WHERE "serviceId" = NEW."serviceId";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF slot."deploymentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Deployment" WHERE "id" = slot."deploymentId" AND "serviceId" = slot."serviceId" AND "status" IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'Service slot must reference its active deployment' USING ERRCODE = '23514';
  END IF;
  IF slot."operationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Operation" WHERE "id" = slot."operationId" AND "serviceId" = slot."serviceId" AND "status" IN ('queued', 'running')
  ) THEN
    RAISE EXCEPTION 'Service slot must reference its active operation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "ServiceMutation_active_task"
  AFTER INSERT OR UPDATE ON "ServiceMutation" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "ozz_validate_service_slot"();

CREATE FUNCTION "ozz_immutable_deployment_intent"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."input" IS DISTINCT FROM OLD."input" OR
     NEW."snapshotJson" IS DISTINCT FROM OLD."snapshotJson" OR
     NEW."targetJson" IS DISTINCT FROM OLD."targetJson" OR
     NEW."configRevision" IS DISTINCT FROM OLD."configRevision" OR
     NEW."mutationRevision" IS DISTINCT FROM OLD."mutationRevision" THEN
    RAISE EXCEPTION 'Deployment intent is immutable; create a new deployment' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Deployment_immutable_intent" BEFORE UPDATE ON "Deployment"
  FOR EACH ROW EXECUTE FUNCTION "ozz_immutable_deployment_intent"();

COMMIT;
