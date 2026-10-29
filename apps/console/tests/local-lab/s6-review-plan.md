# S6 Console verification plan

This plan separates controlled interface evidence from the real API/Worker/Builder acceptance.
S5 is sealed and is not part of these commands. All commands run from the repository root and
share the coordinated single validation window.

## Static and production compilation

```sh
pnpm --filter @ozz/console exec vitest run --config vitest.config.ts tests/unit/git-presentation.test.ts --maxWorkers=1
pnpm --filter @ozz/console exec tsc --noEmit -p tests/tsconfig.s6.json
pnpm --filter @ozz/console typecheck
pnpm --filter @ozz/console exec vite build
```

The package's combined production command is `pnpm --filter @ozz/console build`. When the
current source has just passed `vue-tsc`, the separate `vite build` command avoids running the
same compiler twice. TS ESLint and changed-file Prettier checks run once after the final edits.
The repository ESLint configuration does not cover `.vue`; Vue typing is covered by `vue-tsc`.

## Controlled interface

```sh
S6_UI_RUN_ID=attempt-1 pnpm --filter @ozz/console exec playwright test --config tests/local-lab/s6.playwright.config.ts
```

This uses installed system Chrome, one worker, and an existing Console Vite server on
`http://127.0.0.1:5173` (or `E2E_BASE_URL`). There is no automatic server startup. The fixture
intercepts every `/api/**` request and fails on undeclared API traffic. It uses generated
response/request types, has no access to Prisma, and never writes real product resources.
For the controlled pass, serve the completed production build with
`pnpm --filter @ozz/console exec vite preview --host 127.0.0.1 --port 5173 --strictPort`.
Start this only after the preceding build has exited, and stop it when the browser pass ends.

| Area    | Scenario and observable boundary                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G04     | Saving a GitHub connection does not verify or register a Hook. Authorized repository pagination omits platform `limit`; Hook registration is explicit and produces a persisted operation.                                |
| G04     | Registry push and pull references differ. Verification requires its own explicit action and produces an integration operation. Builder generation mismatch preserves and displays both generations.                      |
| B03     | Git creation has no image or independent pull-credential field. Repository changes clear the prior branch. Failed response retry preserves the creation idempotency key.                                                 |
| C03     | Expired previews block publication. Publish submits only persisted `previewId`, current resource revision, and explicit start/repair confirmations.                                                                      |
| C03     | Editing the commit while a preview request is in progress discards its old reply and preserves the newer fixed commit.                                                                                                   |
| B03/F04 | Source and automatic policy writes remain separate. Pending targets keep their receipt identity and request a retained-source preview.                                                                                   |
| F04     | Restore creates only a resume operation and leaves pending commits pending. Event targets paginate independently; deleted original services retain their history.                                                        |
| F01/F06 | Registry with no verified image retains its digest. Expired OCI and unknown remote execution block retry. Cancellation remains pending until execution closure is observed.                                              |
| F06     | Builder logs order decimal strings without numeric precision loss, page independently of deployment logs, and show expiry/truncation. Active reads advance to the tail and retain at most 200 chunks/200,000 characters. |
| UI      | Ten page states at 1440px/light and 390px/dark run WCAG A/AA checks, document-overflow checks, focus/current-tab visibility checks, and screenshots.                                                                     |

Outputs under `apps/console/tests/artifacts/s6-interface/<S6_UI_RUN_ID>/` include `browser-results.json`,
`responsive-results.json`, and the ten screenshots. Their provenance is the controlled
interface fixture. Each retry uses a new run ID so the first failure and its screenshot are retained.
Passing these checks does not establish GitHub public delivery, actual
build execution, Registry ACL isolation, cluster deployment, or HTTPS reachability.

## Real API/Worker fixture

The root agent owns startup, typed dependency injection, build resources, and actual resource
creation. The real UI spec is `s6-real.spec.ts`, with `s6-real.playwright.config.ts` and
`s6-real-support.ts`. Its only origin is `https://127.0.0.1:51448`; it does not start, stop, or
edit the root's API/Worker/HTTPS services or probe scripts.

Before a browser starts, the global setup uses Node HTTPS with
`.local/local-lab/s6-github/product/ca.crt` and certificate verification enabled. The browser
certificate exception is confined to this test context. No global trust or TLS environment
variable is changed. Authentication uses the real login UI with the existing administrator
password held in memory; no cookies, passwords, or CSRF tokens are saved in reports. This is
the current **development cookie flow**, not production Secure cookie validation.

The spec reads `.local/local-lab/s6-product/state.json` and requires the root's successful
Build/Pod and application HTTPS checks, resource identities, fixed commit, and first successful
deployment/digest. All public resource payloads use the generated API types. It reads the saved
GitHub/Registry/Builder checks, the existing Registry verification operation, Git source,
deployment build/proofs/artifact/logs, and separate default-domain DNS/route/TLS observations.
The one allowed post-login write is an explicit fixed-commit **preview from the UI**, which
is then closed without publication. Before/after task inventories and service publication
identity must match. There is no API interception or mock, no verification invocation, no new
task, and no stop/resume/deploy action.

Only run after root grants the real browser window, while A's Webhook/stop/resume flow is idle:

```sh
pnpm --filter @ozz/console exec tsc --noEmit -p tests/tsconfig.s6-real.json
S6_REAL_UI_RUN_ID=attempt-1 E2E_BASE_URL=https://127.0.0.1:51448 pnpm --filter @ozz/console exec playwright test --config tests/local-lab/s6-real.playwright.config.ts
```

Evidence lives under `apps/console/tests/artifacts/s6-real-product/<S6_REAL_UI_RUN_ID>/`:
`preflight.json`, `ui-evidence.json`, `browser-results.json`, and up to nine screenshots.
The report records local GitHub transport provenance and links API task/commit/digest identities;
it does not certify a genuine GitHub public delivery or a public CA. Raw log contents are not
copied to JSON evidence; log sequences and content hashes link the displayed output to its API page.

No browser, production build, or real-resource validation is claimed by the presence of this plan.
