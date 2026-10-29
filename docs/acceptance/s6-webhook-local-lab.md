# S6 stopped-service and running-service webhook acceptance

`tests/probes/s6-webhook-local-lab.mjs` uses the service, Git repository, connection and domain already recorded by `s6-product-local-lab.mjs`. It exercises the real product HTTP API, Worker, Builder, Registry and K3s. The GitHub provider and event sender are controlled local fixtures.

## Prerequisites

Complete the original product probe's `publish` and `https` modes first. Its `.local/local-lab/s6-product/state.json` must contain the healthy `firstDeploymentId`, `firstImage`, `initialSha`, service/repository/connection IDs, domain ID and hostname. A fresh Webhook probe pins the published V3 snapshot, Registry artifact, seed HEAD and remote branch HEAD to that successful parent publication's `initialSha`. A previous failed seed or a later branch tip does not replace the successful baseline. Resumed attempts use their retained Git checkpoints.

The Git fixture, Registry CONNECT helper, product HTTPS entry, API and Worker must be running. The product origin is `metadata.publicAppOrigin`, fixed to `https://127.0.0.1:51448`; the script trusts the fixture CA explicitly. The repository must belong only to this acceptance service, with automatic Git deployment enabled. This prevents a test push from starting unrelated services.

The host must retain at least 8 GiB free. Each new build admission requires an additional 1 GiB of headroom; deployment observation checks the 8 GiB floor every 30 seconds. A low-space failure retains the current task and evidence for the operator. The two new builds run sequentially on the existing Builder. After resume or deployment, domain observations may lag the successful service Operation. The probe retains those transitions and waits up to three minutes for a fresh ready route and a certificate valid throughout the bounded TLS read. A valid certificate observed as `renewing` is allowed only alongside the same actual TLS chain, hostname and validity verification required for ready certificates.

## Commands

After the operator has confirmed the first application and its HTTPS content, completed the real Console checks, and granted this probe its execution window:

```sh
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node tests/probes/s6-webhook-local-lab.mjs run
```

The script reads local fixture metadata and the existing private administrator password. It obtains a normal session through the HTTPS product API. Its command does not need to load or change `.env`.

Read retained progress without calling the product API:

```sh
pnpm exec node tests/probes/s6-webhook-local-lab.mjs status
```

## Verified sequence

1. Capture the original service, deployment snapshots, BuildRun closure states, source HTML and verified HTTPS body hash.
2. Create a dedicated webhook secret through the product API and register the hook through its real durable Operation. Compare the registered provider hook, callback URL and secret with the private fixture state. The callback remains HTTPS with `insecure_ssl=0`.
3. Stop the published service through its normal Operation. Preserve its published deployment and digest.
4. Commit a new, uniquely marked `public/index.html` to the actual fixture repository and push the branch normally. The original commit and pinned nginx Dockerfile remain available.
5. Submit an invalid HMAC for the planned delivery ID. Require `401 WEBHOOK_SIGNATURE_INVALID` and prove that no delivery reserved that ID. Submit the correctly signed original bytes through the HTTPS callback, then replay the same bytes and ID. Require one durable receipt/target and an incremented duplicate count.
6. Observe several dispatcher cycles while the service remains stopped. The target must remain manual and pending, with its fixed source/SHA/cluster identity and no deployment. The previous deployment inventory must remain unchanged.
7. Resume through the product Operation. Require the original published deployment/digest, unchanged HTTPS body, and the pending target to survive several more dispatcher cycles.
8. Preview the explicit pending target, verify its fixed SHA and current runtime configuration, then publish that preview through the normal deployment API. Confirm the original delivery/target linkage, retained previous evidence, registered closed BuildRuns and the verified Registry artifact.
9. Read the service through its existing domain using TLS hostname and local CA verification inside the application lab VM. Require the new marker and absence of the original marker.
10. Capture a separate running-service baseline from that successful explicit publication. Require fresh, consistent, running observations, automatic deployment enabled, exclusive ownership of the repository, and a complete retained inventory of earlier Deployments and closed BuildRuns.
11. Make another real commit and push with a third content marker. Submit a new, correctly signed push delivery through the same registered HTTPS callback. Persist the delivery intent before sending, and require exactly one target with the fixed new SHA, source revision, runtime configuration revision, policy revision and cluster identity.
12. Observe the production dispatcher move that target to `enqueued` / `automatic_publication`. Its one Deployment must have `initiatorKind: webhook`, the exact receipt/target links, a V3 snapshot for the new SHA, and no manual retry or reused artifact. Wait for a real successful build and publication. Verify the Registry artifact's recipe/source/digest and its registered, submitted, ended, proof-verified producing BuildRun. Retain all earlier Deployments; allow exactly one new Deployment for this delivery.
13. Read the existing domain over verified TLS. Require the third marker, absence of the previous marker, and an HTTPS body hash equal to the committed HTML. The published digest and HTTPS body must both differ from the running baseline.
14. Replay the same signed bytes and delivery ID after automatic publication succeeds. Require `200`, the same durable receipt/target/Deployment and exactly one additional duplicate count. Sample the published service and the complete Deployment/BuildRun inventory across at least 6.5 seconds, with a final observation after that interval. Require no additional Deployment or BuildRun and no change to the published SHA/digest or retained failure records.

During every `running-*` phase, the probe's HTTP boundary permits reads and anonymous, signed POSTs to the already registered callback only. A preview, deployment, retry, service mutation or other authenticated write fails before it can be sent. The saved manual command inventory must also stay unchanged. An automatic admission or build failure remains a failure; the probe does not fall back to explicit publication.

## Evidence and interrupted attempts

The probe keeps its own state and credential under `.local/local-lab/s6-webhook`, using private directories and `0600` files. Every attempt gets a unique directory containing the previous probe state, task transitions, HTTP receipt results, service/target snapshots, TLS facts and `report.json`. Source metadata, platform tasks, deployments, failed attempts and BuildRun records are retained.

The probe acquires the original product probe's lock as well as its own lock. The original `.local/local-lab/s6-product/state.json` is read without changing it. Repeating `run` continues incomplete phases using saved task IDs and idempotency keys. Completed phases retain the attempt that supplied their evidence. Failure leaves the current platform state available for diagnosis.

The original state version, owner, stopped-delivery fields and phase names remain unchanged. Running-delivery checkpoints are additive under `state.running`, with these phases: `running-baseline`, `running-advance-commit`, `running-deliver-webhook`, `running-auto-publication`, `running-https-content`, and `running-duplicate-stable`. Existing completed stopped-service phases are reused. Both `status` and version 2 attempt reports expose the separate running receipt, target, Deployment, commit, digest, BuildRun IDs and duplicate verification. A version 1 report or the earlier `new-https-content` checkpoint alone does not prove running-service automatic publication. The final acceptance checkpoint is `completed['running-duplicate-stable']`.

Git intent is saved before committing. Recovery after a lost commit response requires the exact parent, subject, committed HTML and sole changed path; it neither rewrites history nor creates a replacement commit. A lost webhook response is recovered with the saved external delivery ID and identical payload bytes. Once the automatic target identifies a Deployment, all retries of the probe continue observing that same Deployment. Interrupted duplicate checks may replay the same delivery again; each attempt and before/after duplicate count is retained without changing the commit or deployment intent.

An explicit retry of this probe's failed **manual pending publication**, while `publish-pending` is still incomplete, uses a new product Deployment linked through `retryOfId`, while the stopped-service webhook target keeps its original deployment linkage:

```sh
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node tests/probes/s6-webhook-local-lab.mjs run --retry-deployment=<failed-webhook-publication-id>
```

The script requires the failed task's executions to be closed before requesting that retry. It does not replace the original failure record. Supplying `--retry-deployment` after `publish-pending` completes is rejected, including when the running automatic Deployment fails. A failed stop/resume/hook Operation, an expired preview, changed service configuration, unexpected repository mutation or failed automatic Deployment is reported with the retained phase and evidence for operator reconciliation.

Preparing this probe and passing syntax, lint and formatting checks do not establish product acceptance. Execution and a retained version 2 passing report are required for the extended sequence.

## Recorded local result — 2026-10-26

The extended real sequence passed at `04:53:28 UTC`: [shareable results](s6-webhook-local-results.json), with the private version 2 report at `.local/local-lab/s6-webhook/20261026T045122280Z-304dc9b0/report.json`. All 16 phases completed, retaining 18 successful checks across two attempts. The final attempt contains 11 checks; earlier successful phases retain their original evidence.

The stopped delivery remained manual through resume, then its explicit publication produced Deployment `44f344a4-ad5d-4b3f-a816-24cb79cde3cf` and digest `83d3f71c…`. The next real push automatically produced Deployment `19cf6191-2ac5-44ce-a69f-8f6182d25c6b`, BuildRun `4810a2ce-b440-4d90-9934-be18550b14c5` and digest `d72278b4…`, with the committed HTML served over verified TLS. The running sequence sent only the signed delivery and its replay. Five observations over 7,361 ms confirmed that replay added no Deployment or BuildRun; the final inventory stayed at 10 Deployments and 15 BuildRuns.

The first attempt's `resume-service` failure remains at `.local/local-lab/s6-webhook/20261026T044832197Z-c82c58e9/report.json`. The service Operation had succeeded before its domain read model became ready. Read-only evidence confirmed the original publication and healthy route; the probe gained a bounded observation wait and resumed the same Operation without rebuilding the baseline or replacing the delivery. Both locks were released after success. Nine disk observations retained at least 12,661,039,104 bytes free, above the 8 GiB floor.
