This is a prepared local acceptance procedure. Static checks and temporary-file tests do not establish that a real node outage or persistent-data recovery has passed. Do not execute it until root assigns the C window and stops the Builder VM. The probe never stops Builder, A, B or Pebble.

The existing C instance, registered Cluster, Server and SSH trust are reused. No VM, Cluster, Server or credential is created. `prepare` requires the existing C VM already running and Builder stopped; starting C for preparation remains a root-coordinated step. Every later C stop/start checks Builder is stopped, the existing instance exists and the saved C VM identity/SSH configuration hashes match.

The sample uses a new project with its production environment, one Docker-template service, and one retained `local-path` PVC requested at 1 GiB. The request is not a hard-quota claim. The image is the existing immutable Node example index:

```text
docker.io/library/node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
```

The application listens on port 8080. `/healthz` permits initial deployment before any marker exists. `GET /` opens `/data/ozz-node-persistence-marker` read only with `O_NOFOLLOW`, validates its size and returns its contents. Application startup and every HTTP request contain no marker-writing path. No image is built by this probe. If C cannot pull the fixed image, preserve that failed deployment; any later cache assistance must be recorded separately and must use the same immutable image.

After product deployment succeeds, a fixed, identity-bound `kubectl exec` writes a synthetic 65-byte marker once using `O_EXCL | O_NOFOLLOW`, then fsyncs the file and its directory. The durable write intent is saved before SSH starts. If that command's response is lost, resuming preparation reads the existing file; it does not repeat the write. A missing or mismatched marker fails the attempt. The marker value and session cookie remain in private `0600` files and never enter evidence; reports contain hashes and resource identities only.

The host helper validates the C instance sentinel, registered kube-system UID, one Ready Node, exact PVC/PV UID and claim reference, Deployment/ReplicaSet/Pod owner chain, and the Pod's `/data` PVC mount before marker access. Both direct file reads and actual HTTP responses from the application must hash to the original marker. Recovery uses only these read paths.

Use the product APIs and existing trusted SSH configuration through this entry point:

```sh
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs plan
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs prepare
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs run
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs report
```

`plan` is entirely static. `prepare` creates the dedicated resources, deploys, performs the one explicit marker write and saves the baseline. `run` records a single-use stop intent, stops only `ozz-lab-c` through `limactl`, confirms the whole VM is stopped for at least 30 seconds, and takes repeated independent B Node/boot/Ready observations. It restarts only C in a `finally` block and then verifies:

- C has a new boot ID and retains its kube-system UID and Node UID.
- The original PVC UID, PV UID and marker bytes remain; marker inode and modification time are unchanged.
- The unchanged application serves the original marker over HTTP without a write during recovery.
- B retains its Node UID, kube-system UID and boot ID and stays Ready during the C outage.
- Product observations recover to running with the original publication and no active task; the volume is not destroyed.

If the first preparation deployment fails health waiting before any marker write or baseline, preserve that failed deployment and diagnose its actual container state. After a root-reviewed correction such as importing the exact immutable image from an existing trusted cache, explicitly use `retry-prepare`. This calls the original deployment's product retry API with a durable request, retains the first failed deployment and retry receipts, and adopts the new deployment ID only after its task succeeds and its publication is observed. A Pod starting automatically after cache import does not count as a successful publication. Re-entering `retry-prepare` reuses the same retry command; it does not create another retry. Once a marker write intent or baseline exists, use the ordinary read-only preparation/recovery path instead.

```sh
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs retry-prepare
```

The inherited Docker-template startup probe must also use `/healthz`; `/` intentionally returns 404 until the marker has been written. Initial preparation sets both startup and readiness to `/healthz`. The product does not generate a liveness probe. For the retained failed sample whose explicit retry still had startup `/`, `repair-prepare` changes only that startup path through the product service API and creates a new publication from the changed configuration. It retains both failed deployments and the new publication receipt, and permits the first marker write only after the corrected publication succeeds. It never uses marker creation to make a health check pass.

```sh
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs repair-prepare
```

An interrupted process can recover C without product API availability:

```sh
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs recover
pnpm exec node tests/probes/g-mvp-node-persistence-local-lab.mjs verify
```

`recover` still requires Builder stopped and the original C identity files. It never writes or regenerates a marker. `verify` performs read-only evaluation after the API returns; an incomplete outage or missing B evidence remains unaccepted. `run` refuses a second stop after the durable stop intent exists. A failed attempt, partial stop or ambiguous response remains evidence rather than being erased or silently replayed.

After successful verification, root may stop the dedicated application with `stop-service`. This retains the project, service, PVC, PV, publication and all receipts. The driver never requests volume destruction and never deletes an object, image, VM or evidence. C remains running after recovery for root's next coordinated action. At least 8 GiB of local free space is required throughout, with 10 GiB before preparation and the node fault.

Private state and attempt receipts use `.local/local-lab/g-mvp-node-persistence`. No API, SSH, VM transition, image pull or resource creation has been run merely by preparing these files.
