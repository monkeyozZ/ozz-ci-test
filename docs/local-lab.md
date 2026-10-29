# 本地应用测试环境

默认使用 **Lima VZ 的三台独立 Ubuntu VM**。A/B 是已存在的 K3s，已通过产品导入；C 从干净 Linux 经产品 API、Worker 与 SSH Adapter 完成 K3s 初始化。三个 Cluster 分别绑定一个 Project，各自有默认 production，节点都叫 `ozz-node`，实际 UID、CA 与集群身份独立。

产品接入证据见 [S2 验收](acceptance/S2.md)及[实际接入报告](acceptance/s2-local-results.json)。A/B 的镜像服务生命周期、日志和 Worker 中断恢复见 [S3 验收](acceptance/S3.md)，本地 DNS/ACME 与 HTTPS 见 [S4 验收](acceptance/S4.md)，数据库、持久卷、恢复和失联见 [S5 验收](acceptance/S5.md)。这些是真实本地 Linux/K3s 的结果；公网 DNS、公开可信 ACME、云防火墙和 Oracle 容量仍待远端验收。运行状态会随开发改变，使用下文 `status` 查询；历史报告中的停机或运行状态不代表当前进程状态。

## 当前状态与范围

| 环境                | 版本与资源                                                                                                             | 已验证范围                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认：Lima VZ 三 VM | Lima `2.2.1`、Ubuntu 24.04 ARM64 `20261017`、K3s `v1.35.9+k3s1`；每台 2 CPU / 2304 MiB，A/B 各 20 GiB、C 40 GiB 稀疏盘 | A/B 实验环境的 SSH、TLS、Ready、Metrics 与故障恢复；产品导入 A/B；产品对 C 的指纹发现/信任、只读预检、安装、原意图重试恢复及加密验证；三集群、节点和项目身份隔离 |
| 备用：Docker 双集群 | 缓存 K3s `v1.35.5+k3s1`，ARM64；每集群 2 CPU / 2 GiB 上限，独立网络与命名 volumes                                      | Compose 配置、固定镜像身份与官方 airgap SHA256 已验证；**本轮未启动，也未执行 API 或故障验收**                                                                   |

最初的双 VM 环境报告为 [2026-10-25-vz-verification.json](../infra/local-lab/acceptance/2026-10-25-vz-verification.json)，保存当时版本、资源、身份、故障恢复、安装幂等及最终停机状态。后续产品接入单独记在 [s2-local-results.json](acceptance/s2-local-results.json)，不改写早期证据。

本机为 macOS 14.8 / M1 Pro / 16 GiB。三台 VM 合计配置约 6.75 GiB 内存，CPU 可共享宿主调度，磁盘按实际写入增长。C 为保留 Linux 构建旧产物，于 2026-10-26 先从 20 GiB 原位扩至 28 GiB，再为 S5 构建准备扩至 40 GiB；CPU、内存、机器与集群身份不变，A/B 未扩容。两次独立记录分别为 [20→28 GiB 收据](../.local/local-lab/linux-build-c/c-disk-resize/receipt.json)和 [28→40 GiB 收据](../.local/local-lab/linux-build-c/s5-preparation-c-20261025T230216Z/receipt.json)，后者另有[准备摘要](../.local/local-lab/linux-build-c/s5-preparation-c-20261025T230216Z/summary.md)。这些本机证据位于未纳入版本控制的 `.local/`，新检出仓库不会自带。

第二次扩盘后的历史采样为 C 可用 16.43 GiB、Mac 可用 21.15 GiB；新增 12 GiB 逻辑容量只增加约 12.64 MiB 宿主实际分配。原有镜像、容器、卷、源码快照及 S4 四份镜像归档均保留。构建或导出前仍须重新测量空间：Mac 至少保留 8 GiB，另计算约 5 GiB 新镜像归档；C 至少保留 2 GiB，并计入单镜像导出的临时空间。扩盘记录仅证明空间准备完成，Linux 镜像与 Compose 的已完成验收见 [S4 部署验收](acceptance/S4-deployment.md)和 [S5 部署验收](acceptance/S5-deployment.md)。

控制面性能采样、镜像构建和 VM 启动应错开。只验证镜像发布时可运行 A/B，C 用于保留真实初始化证据和回归。Docker 备用方案与 Lima 使用相同 API 端口，**一次只运行一种环境**。停止无关服务时保留了数据，不能用全局清理命令代替停止。

2026-10-26 本地 Docker Desktop 内存已由 8092 MiB 调至 4096 MiB，给 Lima 测试释放内存。调整前已通过正式备份工具保存控制面与匹配密钥，再正常停止 API/Worker 和两个数据库容器；调整后使用原容器 ID 恢复，数据库健康、容器/卷/磁盘身份及其他设置均通过[比对](../.local/local-lab/docker-desktop-memory/after-databases-20261026T0706.json)。原设置私有备份与[恢复步骤](../.local/local-lab/docker-desktop-memory/PLAN.md)保留；这些本机操作记录不会随新检出仓库提供。

## S6 独立构建机

S5 交付完成后，C 已停止并保留完整磁盘，A/B 继续运行。新增专用 `ozz-build` VM，Ubuntu 24.04 ARM64、2 CPU / 2 GiB / 12 GiB 稀疏盘，使用独立 Lima 目录和 SSH 身份，不挂载 Mac 文件目录。首次预检确认没有 K3s、Docker 或 containerd。现已安装固定版本 Node、BuildKit、RootlessKit、runc 与独立 manager/watchdog，真实 mTLS 与签名检查通过；固定 Git 提交已实际完成构建、私有镜像推送、B 集群健康发布及应用 HTTPS，真实控制台也已核验。双状态 Webhook 与七类 Linux Builder 故障已通过；最终交付与联合恢复继续验收，见 [S6](acceptance/S6.md)与[产品链路结果](acceptance/s6-product-results.json)。

```sh
pnpm exec node scripts/local-builder.mjs status
pnpm exec node scripts/local-builder.mjs inspect
pnpm exec node scripts/local-builder.mjs paths
pnpm exec node scripts/local-builder.mjs stop
pnpm exec node scripts/local-builder.mjs start
```

Builder 和 C 共用本机的一份运行内存预算；启动任一方都会拒绝另一方仍在运行的情况，需要明确停止后切换，停止始终保留磁盘。A/B 不参与此切换。`prepare` 只校验已缓存的官方 Ubuntu/Lima 资产并创建新配置；`start` 不安装构建器。首次创建要求 Mac 至少 14 GiB 空闲，启动后至少保留 8 GiB，后续安装与实际构建仍需单独检查余量。

配置、SSH 文件与每次启动结果位于 `.local/local-lab/builder/`。最初的长实例名在创建前被 Lima 的 UNIX socket 路径上限拒绝；失败日志和原准备配置已保留，最终短名使用新配置成功启动，没有删除或重建已有 VM。

S6 控制台与回环 API 使用独立的 `https://127.0.0.1:51448` 入口。GitHub HTTPS 提供方、Registry CONNECT 转发和该入口都使用受保护的本地配置；只为 S6 子进程覆盖测试 origin，不改原 `.env`。启动和停止顺序见[运行说明](acceptance/s6-github-product-runtime.md)。远端 Builder run 必须由产品任务创建，不能手工提交无平台记录的试验 run；这会破坏后续恢复盘点的完整性。

## 日常启动与停止

本机的工具、固定资产和三台 K3s 已准备完成。在项目根目录执行即可，**已有 VM 不需要重复 `prepare` 或 `install`**：

```sh
pnpm exec node scripts/local-lab.mjs start a
pnpm exec node scripts/local-lab.mjs start b
pnpm exec node scripts/local-lab.mjs start c
pnpm exec node scripts/local-lab.mjs verify
```

`start` 复用原磁盘并验证已保存的 SSH 主机指纹。工具的 `verify` **只检查 A/B**，要求它们同时运行，使用真实 SSH 和启用证书校验的 HTTPS API，检查版本、Node Ready、Secret 静态加密及跨集群身份。成功输出应包含 `verified-local-api-and-ssh`；同时查看 `systemPodsReady` 和每台的 `metricsAvailable`，等待启动预热完成后再开展依赖系统组件的测试。C 的产品初始化结果和关联通过产品接口验证，不能用 `verify` 的成功推断 C 状态。

API 可能先于系统 Pod 和 Metrics 就绪。刚启动时验证若报告未就绪，等待片刻后再次执行 `verify`；不要因此重装 K3s。最新结果位于 `.local/local-lab/verification.json`，每次 `verify` 都会刷新快照，历史验收报告不会被改写。

查看状态、只读预检和停止：

```sh
pnpm exec node scripts/local-lab.mjs status
pnpm exec node scripts/local-lab.mjs preflight a
pnpm exec node scripts/local-lab.mjs paths
pnpm exec node scripts/local-lab.mjs stop all
```

`stop all` 只停止本项目三台 VM，保留磁盘和集群身份。支持单独 `start a` / `stop a`，以及 b/c；双集群 `verify` 仍要求 A/B 均运行。

## 本地连接与身份

| VM          | SSH                           | Kubernetes API            | HTTP / HTTPS 预留端口 |
| ----------- | ----------------------------- | ------------------------- | --------------------- |
| `ozz-lab-a` | `127.0.0.1:60122`，用户 `ozz` | `https://127.0.0.1:16443` | `18080` / `18443`     |
| `ozz-lab-b` | `127.0.0.1:60222`，用户 `ozz` | `https://127.0.0.1:26443` | `28080` / `28443`     |
| `ozz-lab-c` | `127.0.0.1:60322`，用户 `ozz` | `https://127.0.0.1:36443` | `38080` / `38443`     |

SSH/API 配置只绑定 `127.0.0.1`。表中的 HTTP/HTTPS 端口是原始配置预留：Lima 未从 K3s ServiceLB 的 host port 发现可自动转发的监听，不能仅凭这张表将其当作可用入口。S4 后续已通过独立本地路由与测试 CA 验证应用访问，实际映射和 TLS 证据见 [S4 验收](acceptance/S4.md)与[网络实验环境](../infra/local-lab/NETWORKING.md)；该结果不改变系统 DNS 或信任库。

以上地址供宿主机上的开发进程使用。控制面改在容器内运行时，还需另行配置到宿主机的路由和证书目标，容器自己的 `127.0.0.1` 不指向这些 VM。

三套集群故意使用相同节点名 `ozz-node`，产品验证已确认它们具有不同的 `kube-system` UID、Node UID 与 CA 摘要；A/B 还验证过同名 namespace 的不同 UID。客户端必须保留 Cluster 身份，不能仅用节点名或 namespace 名区分资源。

私钥、SSH config、known_hosts 和实验 kubeconfig 都保存在 `.local/local-lab/`；`paths` 只输出路径。A/B 的两份 kubeconfig 位于 `.local/local-lab/credentials/a.kubeconfig.json` 和 `b.kubeconfig.json`，权限 0600。C 的初始化凭证由产品 SSH Adapter 回调交给 Worker 并加密保存，产品不返回其明文。它们包含本地集群管理凭证，不复制到聊天、PR 或日志。工具错误只给出受控信息，必要诊断写入项目内受保护文件。

## 产品接入与保留数据

控制面按[开发说明](development.md)启动后，可在“集群”查看 A/B/C，在“服务器”查看 C 的预检、初始化任务与唯一所属 Cluster；三个项目均继承各自固定目标。产品流程脚本为：

```sh
pnpm exec node --env-file=.env tests/probes/s2-local-lab.mjs
```

脚本需要三台 VM、API 与 Worker 运行，使用已有受保护凭证，并沿用 `.local/local-lab/product-state.json` 中的资源 ID、原请求和幂等键。该脚本会通过产品 API 登记、连接或同步资源，保留所创建的项目/集群，不是纯只读检查。已有 state 不要删除后盲目重建；控制面有数据时也不要再次初始化管理员或替换主密钥。

首次 C 初始化已真正安装 K3s，但加密确认阶段返回 `SSH_ENCRYPTION_NOT_ENABLED`。后续只读检查确认加密已开启；初始化改为严格读取 JSON 布尔值并最多等待 30 秒后，使用原任务的“重试”恢复成功。原失败与成功记录均保留；因为首次失败的原始输出未保存，不能将精确原因断言为某一种竞态。证据见[首次报告](acceptance/s2-local-first-attempt.json)、[干净预检](../infra/local-lab/acceptance/s2-c-preflight.json)及[成功报告](acceptance/s2-local-results.json)。

只有在已有初始化任务失败且需要继续原意图时使用 `--retry-initialization`；它不是重装命令。C 已存在绑定项目，新的初始化请求按产品规则被拒绝；不要卸载 C 或创建新安装意图来重复验证已通过的初始化。需要全新安装验收时另建明确的隔离测试目标。

## 在新的本机环境首次准备

这组固定资产支持 macOS 14+ ARM64，不全局安装 Lima。`LIMA_HOME` 只在脚本子进程中设置；VM 不挂载宿主 Home、不加载用户其他 SSH 公钥、不转发 SSH agent，也不修改全局 SSH 或 Docker 配置。

```sh
pnpm exec node scripts/local-lab.mjs prepare
pnpm exec node scripts/local-lab.mjs start a
pnpm exec node scripts/local-lab.mjs preflight a
pnpm exec node scripts/local-lab.mjs install a
pnpm exec node scripts/local-lab.mjs start b
pnpm exec node scripts/local-lab.mjs install b
pnpm exec node scripts/local-lab.mjs verify
```

以上命令准备 A/B 作为“已有集群导入”路径。需要在新环境复现产品初始化时，另执行 `start c`、`preflight c` 和 `cache-assets c`，再走控制台或产品流程脚本；`install c` 会明确拒绝。`cache-assets c` 只把已校验的固定 K3s 资产缓存到 C，不安装软件。

`prepare` 校验 Lima 工具约 38 MB、Ubuntu 镜像约 617 MB，以及 K3s 二进制约 71 MB / airgap 约 176 MB，再生成并验证 VM 配置。版本、官方来源、字节数和 SHA256 见 [assets.lock.json](../infra/local-lab/assets.lock.json)。只准备工具和配置时可使用 `prepare --tools-only`。

`start` 从 Lima 本地引导通道取得新建 VM 的 Ed25519 公钥并固定到项目 `known_hosts`，后续 SSH 使用 `StrictHostKeyChecking=yes`。首次 provisioning 为 cloud-init 设置 `ssh_deletekeys: false`，使 Lima 更新 instance-id 时保留这台 VM 的 SSH host key。已有信任记录若发生变化仍会失败，不自动接纳新指纹。

本轮故障演练曾发现 Lima 更新 instance-id 导致 cloud-init 默认重生成 host key，检查正确拒绝了变化。核对本项目 VM 磁盘、归属标记和原集群 UID 后，修复了这两台实验 VM 的持久化设置并记录一次人工信任修复；随后 A 再次重启已确认指纹保持。归档报告保存了此审计，通用 SSH 路径没有加入自动更新信任的逻辑。

`preflight` 只读取 OS、架构、CPU、内存、磁盘和已有 K3s 状态。`install` 只允许匹配 Ozz 标记的 Ubuntu 24.04 ARM64 / systemd VM，校验固定资产后安装；不替换其他安装、不隐式升级版本。安装成功需同时等到 API 和 Node Ready。再次执行已匹配版本的安装会保留集群；本轮已实测 A 重复安装后 CA、Node 和 namespace 身份不变。

## 可复现的故障检查

两台均运行时执行：

```sh
pnpm exec node scripts/local-lab.mjs fault-check
pnpm exec node scripts/local-lab.mjs verify
```

`fault-check` 先保存双集群身份，停止整台 A，验证 A 不可访问而 B API 正常，再启动 A，检查 SSH 信任和集群身份保留。成功输出 `one-vm-outage-isolated-and-recovered`，并在当次报告写入 `faultCheck`。

这个检查只验证 A/B 实验环境底层，不能代替产品 Worker 后台观察器的断联与恢复验收。它等待 API/Node 恢复；系统 Pod 和 Metrics 可能稍后才完成预热。因此第二条 `verify` 用于读取恢复后的组件状态。若要保存某次故障证据，先保留其报告快照，再运行会刷新快照的 `verify`。产品观察器的实际结果统一记录在 [S2 验收](acceptance/S2.md)。

## Docker 备用方案

仅在明确需要容器中的独立 API、Lima 已停止且 Docker 磁盘有可用空间时使用。**以下运行步骤本轮尚未执行**：

```sh
pnpm exec node infra/local-lab/clusters.mjs prepare-images
pnpm exec node infra/local-lab/clusters.mjs start
pnpm exec node infra/local-lab/clusters.mjs inject-images
pnpm exec node infra/local-lab/clusters.mjs verify
pnpm exec node infra/local-lab/clusters.mjs fault-check
pnpm exec node infra/local-lab/clusters.mjs stop
```

镜像锁定为已有的 ARM64 K3s `v1.35.5+k3s1` digest，官方匹配 airgap 约 223 MB 已下载并校验。两个 server 名为 `ozz-local-api-a` / `ozz-local-api-b`，Compose project 为 `ozz-local-api`，各有独立 bridge 网络和 volumes，API 端口仍为 `16443` / `26443`。

嵌套 K3s 配置使用 `privileged`、private cgroup 和专属 tmpfs，不挂载宿主目录、宿主网络、Docker socket 或其他项目数据。容器中 Node 报告的容量可能反映 Docker Desktop 内核总资源；2 GiB / 2 CPU 的 Compose 上限另行记录，不能据此推断真实 VPS 容量。

`status` / `paths` 可查看本项目状态与路径；`stop` 保留容器和 volumes。工具没有清库、卸载或删卷命令，不用 `docker system prune` 或 `down -v` 代替停止。Docker 的 kubeconfig 和报告使用 `.local/local-lab/docker/`，与 Lima 凭证分开保存。

## 下载中断与后续接真实 VPS

官方大资产使用有界分片下载，最多四个并发请求。GitHub 签名地址只在内存中使用；Ubuntu 使用固定日期的官方 URL。只有完整文件大小和 SHA256 都匹配后才允许解压或执行。本轮所有固定资产均已通过整包验证。

重试相同 `prepare` 命令会复用已下载分片；未完整验证的 `.part` 不可作为镜像。异常中断可能留下 `operation.lock`，先核对其中 PID 是否仍属于本项目操作，再移除该单独锁文件；不要删除整个 `.local`。

准备好真实 VPS 后，使用真实 SSH 指纹、凭证和 Kubernetes API 创建新的集群登记。现有 Project 固定绑定 Cluster，不能把本地演示集群的地址直接替换成另一套集群；项目和数据迁移需另行处理。服务器数量及配置建议见 [本地测试与 VPS 准备](local-test-and-vps-plan.md)。
