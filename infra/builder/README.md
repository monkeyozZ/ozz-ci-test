The Builder runs on a dedicated Ubuntu 24.04 ARM64 host. It is separate from the control plane, Kubernetes nodes and the S5 Docker packaging host. No Linux execution has been established merely by adding these files.

`install.py` requires a private operator configuration, an already built workspace deployment bundle, pinned assets and explicit `--designate-dedicated-host`. `--fetch` permits downloading the named official assets; without it, missing assets fail. `--start` starts only the new Builder manager. The installer refuses an active Docker, containerd or Kubernetes host. It never stops or prunes another service.

The private configuration supplies `installationId`, `instanceId`, the current control-plane `generation`, `serverCertificate`, `serverPrivateKey`, `clientCa`, `clientFingerprints` (SHA256 fingerprints of the authorized control-plane client certificates), `trustedUploadOrigins` and `blockedNetworks` for management networks. Optional fields are `trustedCloneOrigins` (default GitHub), `privateEgress` (a map from a trusted HTTPS origin to explicitly authorized private IPv4 addresses), `dnsServer`, `listenHost` and `listenPort`. Certificates and keys are file paths, never command arguments containing PEM values. The configuration and receipt remain under `/etc/ozz-builder`; the installation prints only receipt and public-key paths.

The manager uses mTLS and a separately generated Ed25519 identity key. It runs as UID 62000. Git checkout, rootless BuildKit and skopeo uploader run as UIDs 62001, 62002 and 62003. Only the solve UID receives subordinate UID/GID ranges. A constrained root launcher creates the surrounding filesystem, cgroups and network namespace; source execution remains rootless with the BuildKit process sandbox enabled. Missing kernel or rootless capabilities fail closed.

Each run uses a fixed-capacity ext4 loop filesystem, a systemd slice with enforced CPU/memory/PID limits, and a root-owned deadline and lease record. Its phases run serially. Git has no user/system configuration, hooks, recursive submodules or implicit helpers. A verified current clone locator is supplied separately from the fixed numeric repository ID and commit. Checkout paths and symlinks are verified before the solve UID receives read access. The Dockerfile frontend is pinned by digest and `BUILDKIT_*` arguments are rejected. Only explicit build secret mounts enter the solve.

After Git metadata is removed, ordinary source files use mode `0644`, executable files use `0755`, and source directories use `0755`, preserving usable permissions when Dockerfile `COPY` places them in an image. Root owns these entries. The enclosing checkout directory stays root-owned `0550` with only the solve group admitted; the building service sees it under `ProtectSystem=strict`, outside its writable work directory.

The outer network namespace permits approved Git/upload destinations per phase and public IPv4 HTTP/HTTPS for the solve, while excluding management/private/metadata ranges. IPv6 is disabled at the outer namespace, so it cannot bypass that policy. Extra private destinations must be named by exact trusted origin and IPv4 address in the host configuration. Upload CA material is scoped to the uploader, and token-service origins must match the trusted upload origins. TLS verification stays enabled.

For hosts that require an HTTP CONNECT proxy to reach public image registries, the optional root-owned `buildHttpProxy` configuration has exactly two fields:

```json
{
  "buildHttpProxy": {
    "url": "http://host.lima.internal:51449",
    "addresses": ["192.168.5.2"]
  }
}
```

The URL requires an explicit port and permits no credentials, path (including a trailing slash), query or fragment. The address list contains 1–8 distinct canonical IPv4 addresses. Only global unicast and explicitly listed RFC1918 addresses are accepted; loopback, link-local, multicast, reserved and other special ranges are rejected. Installation, identity preflight and each solve verify that DNS resolves to exactly the pinned set. The helper receives a literal pinned-IP endpoint, so a later DNS change cannot redirect its connection.

With this option, the building phase permits outbound traffic only to those proxy addresses and that port; its direct public HTTP/HTTPS and external DNS allowances are removed. Only this phase receives `HTTP_PROXY`, `HTTPS_PROXY` and their lowercase equivalents. Checkout and upload keep their own destination policies. Host proxy environment variables are never inherited. The private device view is retained, with only the building phase receiving `/dev/net/tun` and read/write device permission for rootless networking.

The configured endpoint must be a dedicated CONNECT service with its own exact destination and port allowlist, no access to management/private targets, bounded tunnels, and end-to-end TLS validation by the client. An unrestricted forwarding proxy or an arbitrary existing upstream is not a suitable endpoint. The local S6 entry restricts CONNECT to `registry-1.docker.io:443`, `auth.docker.io:443` and `production.cloudfront.docker.com:443` before using the host's upstream proxy. Endpoint pinning alone does not establish that target policy; retain the proxy's separate ACL checks. Do not disable registry TLS verification or pass a proxy credential through build arguments.

The launcher verifies cgroup emptiness before reading/promoting an OCI archive or issuing upload credentials. OCI manifests, configuration platforms and layer digests are checked. Artifacts are promoted into root-owned read-only storage before skopeo receives a push credential. A failed upload retains the original artifact; retries upload that archive and never repeat the solve. The control plane independently verifies the immutable registry digest before deploying.

Every systemd phase enters a fixed root-owned gate in its own cgroup. The gate checks the durable run fence, boot identity and phase nonce under the run lock, drops all user/group identities to the phase UID, and execs the unprivileged helper in the same process. A delayed systemd start after cancellation cannot start source. OCI promotion pins every parent and the archive inode with no-follow file descriptors, rejects links, bounds archive metadata and validates the complete descriptor graph before copying bytes into trusted storage.

`ozz-builder-watchdog.timer` is independent of the manager. It stops execution on lease/deadline expiry and continues until the kernel confirms termination. Cancelling a run creates a durable tombstone. Builder run identities and signed terminal proofs never expire with caches or output. Logs are already redacted across transport chunks before append, are bounded, and expire after 14 days. The control plane has its own bounded log retention.

Only an explicit authenticated installation fence can advance the admitted generation. Submission, credentials and renewal require that exact generation; an installation config change cannot advance an existing ledger. Recovery fences every registered Builder, including disabled Builders with no known local run, then verifies signed complete inventories. Pages contain at most 100 run/tombstone identities, remain stable for 60 seconds, and are bounded by four cached snapshots. Missing, unknown, open, expired or changed inventory entries keep the restore lock. Terminal proof reads retain their original epoch.

After compiling Builder and infrastructure, run `pnpm exec node infra/builder/bundle.mjs /absolute/empty/directory`. The explicit allowlist copies only Builder JavaScript and the pure infrastructure build, log-redaction and registry-contract modules; it includes no Prisma, control-plane runtime or native dependencies. Local import/hash checks are separate from the Linux installation and execution checks.

`assets.lock.json` pins official BuildKit, rootlesskit, runc and Node archives plus the Dockerfile frontend digest. Ubuntu execution packages use exact versions from authenticated Ubuntu archive metadata. Installation records their package SHA256 values before download and checks installed versions; the receipt also records every execution tool's binary hash. The launcher rechecks those binary hashes during identity verification. The first profile uses the native snapshotter, a single concurrent run and native ARM64 only. No rootful or emulation fallback exists.

Tests under `tests/infrastructure/build-protocol.test.ts` and `tests/unit/builder-ledger.test.ts` cover the protocol and persistent state machine with controlled fault drivers. They do not prove the Linux isolation boundary. Real Git→BuildKit→Registry→Kubernetes execution and its acceptance records are owned by the root S6 orchestration, after resource scheduling.
