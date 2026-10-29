# Local ACME and DNS fixture

This fixture runs the pinned official Pebble v2.10.1 and challtestsrv binaries in the existing `ozz-lab-a` and `ozz-lab-b` Lima guests. It is a **local test CA**, including its `production` endpoint. Certificates issued here are not publicly trusted.

```sh
pnpm exec node infra/local-lab/networking-assets.mjs --verify-only
pnpm exec node infra/local-lab/networking-lab.mjs start
pnpm exec node infra/local-lab/networking-lab.mjs status
pnpm exec node infra/local-lab/networking-lab.mjs stop
```

`start` checks `/etc/ozz-local-lab-instance`, the existing `kube-system` UID in `.local/local-lab/verification.json`, and the single node's InternalIP before installing anything. A/B must have the same private InternalIP for this configuration. Different addresses require an explicit per-cluster mapping; the script refuses to change addresses. Later commands compare the original Node/cluster identities, existing namespace/workload/Service/PVC/Ingress UIDs, and hashes of K3s, Traefik, resolver, and system CA configuration.

| Location   | Listener                              | Purpose                                                                     |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------- |
| Each guest | `0.0.0.0:14000` / `0.0.0.0:14100`     | Separate staging / production ACME directories, HTTPS `/dir`                |
| Each guest | `127.0.0.1:15000` / `127.0.0.1:15100` | Pebble management, explicit transport CA verification                       |
| Each guest | `0.0.0.0:1053`, UDP and TCP           | challtestsrv DNS; A defaults to that guest's Node InternalIP; AAAA is empty |
| Each guest | `127.0.0.1:8055`                      | DNS management only                                                         |
| Mac        | `127.0.0.1:10553`, UDP and TCP        | Explicit resolver for the Worker DNS inspector                              |
| Mac        | `127.0.0.1:18055`                     | Host DNS management only                                                    |

All challtestsrv HTTP-01, HTTPS HTTP-01, TLS-ALPN-01, and DoH listeners are disabled. Pebble validates HTTP-01 on **port 80**, through the existing Traefik and the future cert-manager solver; its TLS challenge port is **443**. `-dnsserver 127.0.0.1:1053` selects the fixture resolver without changing guest resolver settings. `PEBBLE_VA_NOSLEEP=1` removes artificial delays, `PEBBLE_AUTHZREUSE=0` requires fresh authorization, and `PEBBLE_WFE_NONCEREJECT=0` disables simulated random rejection of valid nonces. `PEBBLE_VA_ALWAYS_VALID` is explicitly unset and its live process environment is checked.

Fixture units also unset inherited HTTP/HTTPS/ALL proxy variables. Verification uses an explicit direct HTTP client: the Lima guests have proxy variables that otherwise redirect a private HTTPS request through the host proxy. This isolation affects only fixture processes and requests; guest and host proxy settings remain unchanged.

The default certificate profile lasts **240 seconds** to make a real renewal observable. `start --leaf-seconds 180` through `300` selects another short duration. A running fixture with changed files is refused; stop it before changing its configuration. Repeating `start` with the same configuration preserves the running Pebble processes.

Files are under `.local/local-lab/networking-lab/`, with directory mode `0700` and configuration/private-key mode `0600`. Each guest owns only `/var/lib/ozz-local-lab/{a,b}/networking-v1` and its three `ozz-local-networking-{a,b}-{dns,staging,production}.service` units. The new transport CA and separate guest server keys are generated locally and copied into those protected directories. No CA is installed in a system trust store. Existing cluster resources, K3s/Traefik configuration, S3 fixture records, and `.env` are not edited.

`worker-test-config.json` contains only `version`, `stagingUrl`, `productionUrl`, the single transport CA PEM in `caBundle`, and `solverNameservers`. URLs use the shared private Node IP; solver DNS uses that IP on port 1053. The Worker owner must explicitly opt into this file and the host resolver `127.0.0.1:10553`. Creating this fixture does not restart or reconfigure the Worker.

`stop` verifies ownership before stopping those units and the recorded Mac PID. PID creation time and command identity protect against PID reuse. It does not remove files, credentials, Kubernetes objects, or systemd units. Units are not enabled for boot. **Pebble's CA signing roots, ACME accounts, and orders are in memory:** stopping/restarting Pebble replaces that ACME state even though transport keys, logs, configuration, and evidence remain. Finish issuance/renewal checks before stopping it. Public signing-root snapshots are saved in each protected guest directory; these are separate from the transport CA used to authenticate `/dir`.

`status` refreshes the saved `staging-signing-root.pem` and `production-signing-root.pem` files from the management endpoints after authenticating them with the persistent transport CA. It is therefore not a read-only command. Preserve previous root snapshots before using it during an incident. A healthy `/dir` response does not establish that existing applications have valid certificates: after the October 2026 host restart, cached cert-manager account URLs still referred to the previous Pebble instance, renewal failed with `Key ID (kid) in JWS header missing expected URL prefix`, and old application certificates expired while Issuers still reported `Ready`. Check the actual application HTTPS chain, hostname, validity and content before starting another acceptance window; restore account registration and real issuance without disabling TLS verification.

`status.json` and `last-start.json` record actual UDP/TCP DNS answers, empty AAAA results, authenticated `/dir` responses, rejection by the default system trust store, management listener addresses, disabled challenge mocks, and unchanged cluster identities. They deliberately retain `issuanceVerified: false` and `http01Verified: false`: certificate issuance, real solver routing, and automatic renewal require the later cert-manager product acceptance.

Official source references: [configuration](https://github.com/letsencrypt/pebble/blob/v2.10.1/test/config/pebble-config.json), [Pebble options](https://github.com/letsencrypt/pebble/blob/v2.10.1/cmd/pebble/main.go), [challtestsrv listener options](https://github.com/letsencrypt/pebble/blob/v2.10.1/cmd/pebble-challtestsrv/main.go), and [validation behavior](https://github.com/letsencrypt/pebble/blob/v2.10.1/README.md). The release archives are verified against [networking.assets.lock.json](networking.assets.lock.json).
