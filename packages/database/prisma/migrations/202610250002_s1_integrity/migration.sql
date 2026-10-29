-- These constraints protect invariants even if concurrent API requests race.
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_singleton_check" CHECK ("singleton" = 1);
ALTER TABLE "Project" ADD CONSTRAINT "Project_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "Environment" ADD CONSTRAINT "Environment_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "Server" ADD CONSTRAINT "Server_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "Server" ADD CONSTRAINT "Server_ssh_port_check" CHECK ("sshPort" BETWEEN 1 AND 65535);
ALTER TABLE "Server" ADD CONSTRAINT "Server_tags_count_check" CHECK (cardinality("tags") <= 20);
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "SecretReference" ADD CONSTRAINT "SecretReference_encryption_check"
  CHECK ("keyVersion" > 0 AND "revision" >= 1 AND octet_length("nonce") = 12 AND octet_length("tag") = 16 AND octet_length("encryptedPayload") > 0);
ALTER TABLE "KeyVerification" ADD CONSTRAINT "KeyVerification_encryption_check"
  CHECK ("keyVersion" > 0 AND octet_length("nonce") = 12 AND octet_length("tag") = 16);
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_attempts_check"
  CHECK ("attempts" >= 0 AND "maxAttempts" BETWEEN 1 AND 10 AND "attempts" <= "maxAttempts" AND "generation" >= 0);
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_input_object_check" CHECK (jsonb_typeof("input") = 'object');
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_retryOfId_fkey" FOREIGN KEY ("retryOfId") REFERENCES "Operation"("id") ON DELETE RESTRICT;
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_delivery_check" CHECK ("attempts" >= 0 AND "deliverySequence" >= 0);
ALTER TABLE "ControlPlaneState" ADD CONSTRAINT "ControlPlaneState_singleton_check" CHECK ("id" = 'control-plane' AND "generation" >= 0);

CREATE FUNCTION ozz_immutable_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) ->> TG_ARGV[0]) IS DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0]) THEN
    RAISE EXCEPTION 'Placement is immutable; copy into a new target resource' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_cluster_immutable BEFORE UPDATE OF "clusterId" ON "Project"
  FOR EACH ROW EXECUTE FUNCTION ozz_immutable_placement('clusterId');
CREATE TRIGGER environment_project_immutable BEFORE UPDATE OF "projectId" ON "Environment"
  FOR EACH ROW EXECUTE FUNCTION ozz_immutable_placement('projectId');

INSERT INTO "ControlPlaneState" ("id", "restoreLocked", "generation", "updatedAt")
VALUES ('control-plane', false, 0, NOW()) ON CONFLICT ("id") DO NOTHING;
