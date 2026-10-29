# S3 私有镜像仓库验收

2026-10-26 在本地 Linux ARM64 K3s B 完成真实 Distribution 3.1.2 验收：仓库 fixture **15/15**、产品流程 **28/28**。结果分别保存在 [fixture 报告](s3-private-registry-fixture-results.json)和[产品报告](s3-private-registry-product-results.json)。新镜像的 manifest、config 和 marker layer 发布前均不存在于 B 的 containerd，随后记录到这三项的 runtime GET 200。原有 Podinfo 基础层复用已有缓存。

源码入口如下，生成文件都留在被 Git 忽略的 `.local/local-lab/`：

| 入口                                                                                           | 用途                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [`private-registry-assets.lock.json`](../../infra/local-lab/private-registry-assets.lock.json) | 固定官方 Distribution 版本、下载地址、大小和 SHA256，以及 Podinfo 根摘要  |
| [`private-registry-assets.mjs`](../../infra/local-lab/private-registry-assets.mjs)             | 下载或复核本地资产；逐一核验 OCI index、ARM64 manifest、config 和 layers  |
| [`private-registry-b.mjs`](../../infra/local-lab/private-registry-b.mjs)                       | 生成或复用专用 TLS/Basic fixture，安装 B 专用 unit、CA 与 SSH 转发        |
| [`private-registry-seed.mjs`](../../tests/probes/private-registry-seed.mjs)                    | 推送固定 ARM64 源镜像、唯一新 layer/config/manifest，以及 AMD64-only 负例 |
| [`private-registry-local-lab.mjs`](../../tests/probes/private-registry-local-lab.mjs)          | 经产品 API/Worker 创建一个专用服务，运行凭据矩阵并删除该服务              |

三个 fixture/probe 入口整理自本次已经执行的 `.local/local-lab/private-registry-b/{setup,seed,product-check}.mjs`。原有本地入口只导入版本库中的同一份实现。凭据、私钥、原请求、幂等键及执行状态没有移入源码。资产准备补齐了空缓存下载入口；原 28 项产品断言及阶段顺序保持一致。

先按[本地实验环境](../local-lab.md)和[开发说明](../development.md)准备项目依赖、构建输出、数据库、API、Worker 和 B。脚本依赖已存在的专用 SSH 配置 `.local/local-lab/credentials/ssh_config`，其 `ozz-lab-b` 别名固定已验证的主机公钥；B 必须保存 `/etc/ozz-local-lab-instance = ozz-lab-b`。产品 probe 从 S2 探针留下的 `.local/local-lab/product-state.json` 读取 B 的 Cluster/Project ID，并查找该项目的 `production` 环境；它不会创建替代集群或重绑现有项目。首次新环境登记入口是 `tests/probes/s2-local-lab.mjs`。

从仓库根目录依次执行：

```sh
pnpm exec node infra/local-lab/private-registry-assets.mjs
pnpm exec node infra/local-lab/private-registry-b.mjs
pnpm exec node tests/probes/private-registry-seed.mjs
pnpm exec node --env-file=.env tests/probes/private-registry-local-lab.mjs
```

资产脚本从官方 Distribution release 下载固定归档。源镜像只读取固定的 GHCR 摘要，匿名拉取 token 仅保留在内存，跳转到官方 blob CDN 时不发送认证头。下载失败保留已经核验的文件；重跑会继续使用它们。`--verify-only` 只读复核现有缓存，不下载、不导入节点：

```sh
pnpm exec node infra/local-lab/private-registry-assets.mjs --verify-only
```

Registry 监听 B 内的 `127.0.0.1:50443`，Mac 通过专用 SSH `-L 127.0.0.1:50443:127.0.0.1:50443` 连接同一服务。systemd unit 是 `ozz-local-registry-b.service`，其二进制、数据、TLS 证书、htpasswd 和脱敏日志均在 `/var/lib/ozz-local-lab/b/registry-3.1.2/`。所有 HTTPS 客户端验证 CA 和主机名。

B 已有 containerd `config_path = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d"`。fixture 只在其中的 `127.0.0.1:50443/` 安装专用 `ca.crt` 与 `hosts.toml`：

```toml
server = "https://127.0.0.1:50443"

[host."https://127.0.0.1:50443"]
  capabilities = ["pull", "resolve"]
  ca = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d/127.0.0.1:50443/ca.crt"
```

该配置没有认证头；Kubelet/containerd 必须使用产品管理的 `imagePullSecret`。安装只重启专用 registry unit，不重启 K3s、API 或 Worker。节点 CA 是实验 fixture 的显式配置，验收不表示产品自动配置节点信任，也不表示公网 registry 网络路径已经通过。

原始 registry 日志先经过 sanitizer，再写入 `access.jsonl`；`runtime-access.jsonl` 只接收 User-Agent 为 containerd 的 GET。两个文件均仅保留 `time`、去掉查询参数的 `path`、`status`。不会持久记录 Authorization、token、请求头或 Secret 数据。新的 marker layer 使用唯一仓库和摘要，probe 会在发布前核对 B 缓存缺失，再核对实际 GET 200；不会清理共享镜像缓存制造这个条件。

`credentials/registry-b.json` 与 `credentials/registry-b-rotated.json` 保存两个有效身份，文件权限 0600。PKI 私钥只在受保护目录中。产品 probe 使用独立的 `private-registry-b/product-state.json`，不要与上级的 S2 `product-state.json` 混淆。每个请求先保存原始 body 和幂等键，完成阶段有持久检查点，重跑复用既有状态；**不要删除或重置 state、runtime-variant、凭据或旧报告来制造新尝试**，也不要并行启动两个 probe。失败会停在原阶段并保留服务和任务，修复后继续原意图。

矩阵覆盖凭据只写返回、过期/类型/仓库不匹配、缺少/错误 Basic 认证、AMD64-only 拒绝、有效私仓发布与请求重放、停止后选择新凭据、恢复、重启，以及当前错误凭据不能回退到旧的有效 Secret。恢复后远端 Secret 必须匹配当前新凭据，同时保留 Deployment/Secret UID 和已发布快照。只有全部阶段通过后才经产品 API 删除本次专用服务；共享 Namespace、原有其他服务、成功/失败任务和加密凭据记录保留。本次删除的服务 ID 是 `2a023757-dae7-4ca2-a366-76aa8e4ba27f`，完整保留记录见产品报告。

结束使用 fixture 时，以下命令仅停止专用 registry 与它的 SSH 转发，保留数据、凭据和信任材料供复核：

```sh
ssh -F .local/local-lab/credentials/ssh_config ozz-lab-b \
  sudo systemctl stop ozz-local-registry-b.service

ssh -F .local/local-lab/credentials/ssh_config \
  -S .local/local-lab/private-registry-b/tunnel.sock \
  -O exit ozz-lab-b
```

重新运行 setup 会复用现有身份和数据并恢复这两个入口。fixture CA 有效期 14 天、服务证书 7 天；过期后 TLS 会明确失败，不能关闭证书验证或通过重置已验收状态绕过。
