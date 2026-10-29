# S6 Linux 镜像与部署验收

日期：2026-10-29（Asia/Shanghai）。**L07 本地 Linux ARM64 交付通过**：四个控制面镜像、独立 Builder 安装包、干净安装与生产鉴权、两集群接入、升级回退、OCI/Registry/Docker 互操作和最终资源保留均有实测证据。S6 与 G-MVP 总体仍在进行中，剩余范围见 [S6](S6.md)。

完整镜像身份、原始收据 SHA、检查结果和限制见 [机器报告](s6-deployment-results.json)。本文件在构建后生成，不回填冻结源码。

## 固定源码与交付物

源码快照为 `s6-20261028T173714Z-f8b90388`，归档 SHA256 为 `f90c4c378fa454e32d5f7a0a67ea77a4bb91e02d30bad4c6ab846eaf7d88f217`。四目标共享经过来源核验的 Linux build stage；运行 Node 24.22.1，项目锁定 pnpm 12.14.0，C 的专用 Docker 为 28.5.2。Node 22 基础层只用于下载引导。

| 交付物 | 字节数 | SHA256 |
| --- | ---: | --- |
| [四镜像 OCI archive](../../.local/local-lab/linux-build-c/artifacts/s6-20261028T173714Z-f8b90388-linux-arm64.oci.tar) | 496,756,224 | `242a799fcb85b8fc0e26fa4c64b2ed7f1473d2d913ae1945af0bab37bb35bd60` |
| [Builder installer tar.gz](../../.local/local-lab/linux-build-c/evidence/s6-final-20261028/builder-installer.tar.gz) | 80,828 | `ba78829f00cfdac07e28a47eaa2bb3e10f37480a3d2b156e7f31034c03a7d682` |

| 镜像 | Image/config ID 前缀 |
| --- | --- |
| api | `sha256:8827450c584a1754…` |
| worker | `sha256:9644126003fb142d…` |
| migrate | `sha256:a3e8258fe8215c0c…` |
| console | `sha256:289ddd1ddab880d1…` |

机器报告保留完整 image/config、原始 Registry manifest、OCI manifest 与 rootfs diffIDs。OCI 包有 **33 个唯一 blob、21 个唯一镜像层**，共享层只保存一次。归一化会改变 manifest 媒体类型和摘要，config 与压缩层字节保持。实际验证链为 archive → Registry roundtrip → Docker pull：复用 25 个已有 blob、上传 0 个新 blob、发布 4 个目标；四次真实 pull 的镜像身份均与原构建一致，缓存命中如实保留。

Builder 包与相同源码/build stage 绑定，包含白名单应用、固定安装脚本/资产锁和包内相对链接，不包含 operator 配置、PKI 或 ledger。独立 Builder 的真实运行与故障证据继续按 S6 原有范围引用。

## 安装、鉴权与升级

干净 Compose 使用独立空库、主密钥和卷，完成 **9 个迁移、8 项检查**。生产 Secure/HttpOnly/SameSite=Strict Cookie、错误 Origin 与缺失 CSRF 的无副作用拒绝、真实登录和 Worker 诊断、重启后的会话/数据/任务保留均通过。A/B 两套原有集群经过严格 TLS 接入，核对不同 CA、kube-system UID、Node UID 和新鲜观察；本轮没有部署或重装应用集群。

四镜像包检查均以默认 `node` 用户在只读、禁网容器中运行。API/Worker 验证生成 Prisma、S6 模型、Builder client/proof transport、固定基础设施资产及生产环境拒绝本地 ACME；migrate 保持独立数据库包、CLI 与迁移。Console 的静态资产检查与真实 UI 验收分别留证。

升级回退另有 **七阶段、六项检查**，不由 portable acceptance 代替。冻结 S5 的 8 个迁移升级至 S6 的 9 个迁移，六类旧模型字段、原会话与凭证保持。正式备份恢复到新空库后，旧会话失效、只读锁与 Worker paused 有效，正式解锁后新诊断成功。该隔离回退样本的导入为 **1.402 秒**，只读可用 **15.664 秒**，读写可用 **32.337 秒**；这些时间不代表包含远端对账的完整 RTO。

故意失败的迁移使 migrate exit 1 并阻止 API/Worker 启动。另一个明确不兼容的样本先确认联库并返回 P2022，再确认冻结旧 API/Worker 均 exit 1；错误、原数据与哨兵保留。正常 additive 升级与不兼容拒绝独立验证。

## 保留、修复与安全证据

最终收据确认 **340 个镜像、106 个容器、34 个卷**以及全部历史对象保留，四个候选镜像身份不变。finalize 完成时 C 的 K3s 原身份保持、Node Ready，专用 Docker 已停止、运行容器为零。随后 Registry 原 ACL 字节和权限恢复；临时 Docker CA 与三个新建目录被移除，原来的目录缺失状态恢复。恢复预检另确认 Docker `inactive`、MainPID 为 0。

窗口关闭后的 **9 项只读检查通过**：C 虚拟机停止，A/B 与原 Builder 运行，VM 互斥保持；原 API/Worker 身份及就绪状态正常。Builder 通过新的 mTLS、签名身份和完整单页 inventory 核验，generation 5、28 个 run 全部关闭、0 个开放 run，与原基线一致。该结果来自 10:15:49–10:15:50 的短观察窗口，不作为持续可用性或新候选容器部署的证明。

两处影响判断的问题保留解释。第二候选在 production dynamic import 下未进入 Worker 的原 CJS 启动分支，经入口修复、独立三场景回归和新候选真实 Compose 验证。另一次停止窗口把 live 列表中的 **13 条 `<none>:<none>` 合成标签**与 offline 真实标签直接比较，产生保留失败误报；后续独立只读和恢复窗口检查确认全部真实标签、四个候选 image ID 及上述资源数量保留。原失败没有改写，缓存准入和 Registry 准备的其他失败/修复也保留在机器报告中。

源码、Builder 包和 OCI 压缩层的显式库存扫描均未检出已知秘密。扫描只覆盖实际列出的产物与当前存在的库存值；未知秘密、已经消失的进程内会话/CSRF 不在覆盖范围。本轮最后的公开文本扫描覆盖 README、PRODUCT、开发计划、S6 记录、本地联合验收矩阵、本页及机器报告，共 7 份文件；结果与最终字节由外置收据 `.local/local-lab/linux-build-c/evidence/s6-final-20261028/delivery-secret-scan-public-01.json` 记录，报告不内嵌自身扫描哈希。

## 复现与剩余范围

产物位置、原收据及冻结工具引用见机器报告。本地阶段入口保存在 `.local/local-lab/linux-build-c/s6-tooling/README.md` 与 `L07-INCREMENT.md`，使用绑定 run/source 的新 attempt；配置和凭据仅从受保护输入读取。产品安装沿用冻结 Compose 与 `infra/docker/setup-compose.mjs`，备份回退遵循[控制面恢复手册](../control-plane-recovery.md)。OCI 归档通过已实测的 Registry roundtrip/pull 路径使用。

旧完整工程与各窄增量分别绑定，不合并为新版本的一次全套测试。发布说明更新后另核对 830 个冻结源文件：825 个不变，仅 5 份既有说明按计划更新，14 份冻结工具未改变；本页与机器报告为冻结后新建文件。Mac/C 空闲量与增长按原采样时间记录，冻结预算不作为容量上界。尚未完成的 G-MVP 联合身份核对、精确 PG 快照/完整远端 RTO、真实读屏，以及公网 GitHub、公共 DNS/可信 ACME、AMD64、跨物理机恢复和目标 VPS/Oracle 容量，均不由本次 L07 结果替代。
