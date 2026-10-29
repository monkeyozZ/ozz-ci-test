# S6 persistent GitHub fixture and product runtime

The local provider uses `tests/probes/support/s6-github-fixture.py` for its HTTPS API and real bare-Git upload-pack. Product requests use `GitHubAdapter` with an explicit private CA. API, Worker, task admission, BuildRun registration, checkout, build execution, reconciliation and observers use the production implementations.

All fixture configuration, credentials, repositories and logs are under `.local/local-lab/s6-github/product`. The directory is private to the current user, and generated credential/configuration files have mode `0600`.

| File                                 | Contents                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata.json`                      | Safe manifest: `fixtureId`, `repositoryId`, `fullName`, `branch`, `initialSha`, `marker`, `apiOrigin`, `cloneOrigin`, `publicAppOrigin`, `preparedAt`, `baseImage`, `owner` |
| `pat.json`                           | `{ "token": "..." }`; read into the normal Git connection API request without printing it                                                                                   |
| `state.json`                         | Provider repositories, accepted PAT and registered webhook secrets                                                                                                          |
| `config.json`                        | Python provider configuration                                                                                                                                               |
| `ca.crt`                             | Private CA supplied to production GitHub HTTPS and clone transports                                                                                                         |
| `server.crt`, `server.key`, `ca.key` | Fixture TLS identity and signing key                                                                                                                                        |
| `registry-proxy.json`                | Fixed local CONNECT mapping and the original `REGISTRY_HTTP_PROXY` as upstream                                                                                              |
| `repositories/100001.git`, `seed/`   | Persistent bare repository and its editable local source                                                                                                                    |

The API origin is `https://127.0.0.1:51446`; the Builder clone origin is `https://host.lima.internal:51446`. The certificate contains both `IP:127.0.0.1` and `DNS:host.lima.internal`. The TLS server binds `0.0.0.0:51446` so the lab VM can reach it. Repository reads require the private PAT.

The product Console and API share `https://127.0.0.1:51448`, recorded as `publicAppOrigin`. A separate loopback HTTPS process serves the current `apps/console/dist` and forwards only `/api` requests to `127.0.0.1:3000`. It reuses the fixture certificate, preserves raw webhook bytes and authentication headers, and records no request bodies or credentials.

The initial repository is `100001`, `ozz-fixture/application`, branch `main`. `metadata.json` records the initial commit and a unique marker embedded in `public/index.html`. Its Dockerfile is:

```dockerfile
FROM nginx@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236
COPY public/index.html /usr/share/nginx/html/index.html
```

## Startup

Run commands from the repository root using the project's Node 24 runtime. Build the current API and Worker artifacts before switching runtime profiles. The main database migration remains an explicit operator step.

1. Prepare the private fixture. This is idempotent and preserves existing PATs, hooks, Git history and certificates. Load the original `.env` so the existing Registry proxy is retained as upstream.

   ```sh
   pnpm exec node --env-file=.env tests/probes/s6-github-product.mjs prepare
   pnpm exec node tests/probes/s6-github-product.mjs start
   ```

2. Run the persistent CONNECT helper in its own supervised session. It maps only `host.lima.internal:50444` and `host.lima.internal:51445` to loopback; other authorities use the saved upstream. TLS remains end to end.

   ```sh
   pnpm exec node tests/probes/support/s6-registry-proxy.mjs serve .local/local-lab/s6-github/product/registry-proxy.json
   ```

   The dedicated Builder additionally uses port 51449 for this lab's Docker Hub
   egress. Start its separate supervised helper when the Builder's private host
   configuration enables `buildHttpProxy`:

   ```sh
   pnpm exec node tests/probes/support/s6-build-proxy.mjs serve .local/local-lab/builder/network/proxy.json
   ```

   Its protected configuration has owner `ozz-s6-build-proxy-v1`, listen host
   `127.0.0.1`, port `51449`, and the existing host CONNECT proxy as `upstream`.
   The helper admits only the three exact HTTPS authorities observed for this
   fixture's pinned Dockerfile frontend and nginx image: `registry-1.docker.io`,
   `auth.docker.io` and `production.cloudfront.docker.com`, each on port 443.
   It exposes no loopback mappings to the Builder. The building network allows
   only this pinned proxy endpoint; checkout and push use their separate
   policies. TLS remains end to end. This fixture ACL is intentionally limited
   to these image downloads; it does not certify arbitrary package downloads.
   See [Builder operator configuration](../../infra/builder/README.md).

3. Start the product HTTPS entry in its own supervised session. Verify its health with the explicit CA; browser acceptance should also trust this fixture CA without disabling TLS verification globally.

   ```sh
   pnpm exec node tests/probes/support/s6-product-https.mjs serve
   curl --cacert .local/local-lab/s6-github/product/ca.crt https://127.0.0.1:51448/__ozz_s6_health
   ```

4. Complete the operator's stop, backup, S6 migration and preservation checks. The existing launcher owns both runtime profiles in `.local/s3-runtime.json`. Start the S6 API alone:

   ```sh
   NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node --env-file=.env tests/probes/local-runtime.mjs start --profile=s6-github --only=api
   ```

5. Use the real product HTTP API to register Git, Registry and Builder connections. Read the PAT from `pat.json`. Read current Registry credentials from the Registry fixture's private credential store. Queue Registry verification, then grant only its exact fixture probe repository, `ozz-s6/ozz-probe-${operationId}`, before starting the Worker.

6. Start the missing Worker. A plain `start` retains the saved `s6-github` profile and existing API PID:

   ```sh
   NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node --env-file=.env tests/probes/local-runtime.mjs start
   ```

`tests/probes/s6-product-api.mjs` calls `createApp({ githubAdapter })`. `tests/probes/s6-product-worker.mjs` calls `startWorker({ github })`. The fixture adapter is supplied only at these composition points. The launcher sets the child process's `REGISTRY_HTTP_PROXY` to `http://127.0.0.1:51447`, preserves `REGISTRY_PROXY_BLOB_ORIGINS`, and checks that the saved upstream still matches the operator's original setting. `.env` remains unchanged.

The S6 child processes use `APP_ORIGIN=https://127.0.0.1:51448`. This gives browser requests and registered webhook callbacks the same real HTTPS origin while preserving the strict webhook HTTPS and application Origin checks. The launcher verifies the Git provider and HTTPS entry before starting API or Worker. The local development cookie policy remains the production application's configured policy.

All remote checkout/solve operations should enter through the normal product HTTP workflow so the platform records each BuildRun before sending it to the Builder.

After a host or Pebble restart, also verify the existing A/B application HTTPS endpoints with their explicit signing roots. Git provider health, product entry health and API/Worker readiness do not cover application certificate renewal. Pebble's signing roots and ACME accounts are held in memory; cert-manager can retain a stale account URL and a `Ready` Issuer while renewal fails and the old leaf certificate expires. The [networking fixture lifecycle](../../infra/local-lab/NETWORKING.md) describes this boundary and the fact that its `status` command refreshes saved signing-root files. Preserve the old certificate-request and order evidence before restoring registration and issuance, and require real HTTPS verification before the next recovery measurement.

## Status and shutdown

```sh
pnpm exec node tests/probes/s6-github-product.mjs status
pnpm exec node --env-file=.env tests/probes/local-runtime.mjs status
pnpm exec node --env-file=.env tests/probes/local-runtime.mjs stop
pnpm exec node tests/probes/s6-github-product.mjs stop
```

The runtime stop command retains its queued/running task check and stops both owned processes. The fixture refuses to stop while an owned S6 API or Worker is running. Terminate the separately supervised Registry CONNECT, Builder CONNECT and product HTTPS helpers after runtime shutdown and confirmed remote run termination. To return to the standard entry points after shutdown, use `local-runtime.mjs start --profile=standard`.

This fixture supplies controlled local protocol evidence. GitHub-hosted PAT authorization and GitHub-origin webhook delivery require separate provider acceptance.
