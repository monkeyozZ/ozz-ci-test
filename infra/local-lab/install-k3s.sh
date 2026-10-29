#!/bin/sh
# Bootstrap only an explicitly marked Ozz local VM. The product's S2 installer
# and its remote acceptance remain separate work.
set -eu

instance=$1
version=$2
binary_digest=$3
images_digest=$4
case "$instance" in ozz-lab-a|ozz-lab-b) ;; *) echo 'Invalid lab instance' >&2; exit 2;; esac
case "$version" in v1.35.9+k3s1) ;; *) echo 'Unsupported pinned K3s version' >&2; exit 2;; esac
if [ "$(id -u)" != 0 ] || [ "$(cat /etc/ozz-local-lab-instance 2>/dev/null)" != "$instance" ]; then
  echo 'Refusing installation outside the matching Ozz-owned local VM' >&2
  exit 2
fi
if [ "$(uname -m)" != aarch64 ] || ! grep -q '^VERSION_ID="24.04"$' /etc/os-release; then
  echo 'This local bootstrap requires Ubuntu 24.04 ARM64' >&2
  exit 2
fi
if [ "$(cat /proc/1/comm)" != systemd ]; then
  echo 'A real systemd Linux guest is required' >&2
  exit 2
fi

assets=/home/ozz/ozz-lab-assets
state=/var/lib/ozz-local-lab
if { [ -e /usr/local/bin/k3s ] || [ -d /etc/rancher/k3s ] || [ -d /var/lib/rancher/k3s ]; } && [ ! -f "$state/k3s-version" ]; then
  echo 'An existing unmanaged K3s installation will not be replaced' >&2
  exit 3
fi
if [ -f "$state/k3s-version" ] && [ "$(cat "$state/k3s-version")" != "$version" ]; then
  echo 'An existing lab version will not be upgraded implicitly' >&2
  exit 3
fi
if [ -f "$state/ready" ]; then
  if ! /usr/local/bin/k3s --version | grep -Fq "k3s version $version "; then
    echo 'Installed K3s version changed; manual reconciliation required' >&2
    exit 3
  fi
  systemctl start k3s
  echo 'Existing matching lab installation preserved'
  exit 0
fi

printf '%s  %s\n' "$binary_digest" "$assets/k3s" | sha256sum --check --status
printf '%s  %s\n' "$images_digest" "$assets/images.tar.zst" | sha256sum --check --status
install -d -m 0700 "$state"
printf '%s\n' "$version" > "$state/k3s-version"
chmod 0600 "$state/k3s-version"
install -m 0755 "$assets/k3s" /usr/local/bin/k3s
install -d -m 0700 /etc/rancher/k3s
install -d -m 0755 /var/lib/rancher/k3s/agent/images
install -m 0600 "$assets/images.tar.zst" /var/lib/rancher/k3s/agent/images/ozz-pinned-images.tar.zst

# All networks live inside this VM. The host wrapper forwards only specific
# ports to 127.0.0.1. A/B intentionally use the same node name and CIDRs to check
# that higher-level clients keep cluster identity separate.
cat > /etc/rancher/k3s/config.yaml <<'CONFIG'
node-name: ozz-node
write-kubeconfig-mode: "0600"
secrets-encryption: true
tls-san:
  - "127.0.0.1"
CONFIG
chmod 0600 /etc/rancher/k3s/config.yaml

cat > /etc/systemd/system/k3s.service <<'UNIT'
[Unit]
Description=Ozz local lab K3s
Documentation=https://docs.k3s.io/
Wants=network-online.target
After=network-online.target
Conflicts=shutdown.target

[Service]
Type=notify
KillMode=process
Delegate=yes
Restart=always
RestartSec=5s
LimitNOFILE=1048576
LimitNPROC=infinity
LimitCORE=infinity
TasksMax=infinity
TimeoutStartSec=0
ExecStartPre=-/sbin/modprobe br_netfilter
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/k3s server

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now k3s

attempt=0
while [ "$attempt" -lt 120 ]; do
  # /readyz may succeed before the kubelet has registered its Node object.
  # A missing or not-yet-ready Node is a retryable bootstrap state.
  if /usr/local/bin/k3s kubectl --request-timeout=5s get --raw=/readyz >/dev/null 2>&1 &&
     /usr/local/bin/k3s kubectl --request-timeout=5s wait --for=condition=Ready node/ozz-node --timeout=1s >/dev/null 2>&1; then
    /usr/local/bin/k3s secrets-encrypt status | grep -q 'Encryption Status: Enabled'
    touch "$state/ready"
    chmod 0600 "$state/ready"
    echo 'Pinned K3s ready; Secret encryption enabled'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 3
done
echo 'K3s did not become ready within the local bootstrap timeout' >&2
exit 4
