# S5 存储、数据库与模板实施方案

日期：2026-10-26。状态：**本地产品验收与固定源码的 Linux ARM64 交付通过**。S5 schema/迁移、领域、模板、适配器与 API 已落地，公共本地库已完成 S4 → S5 升级；真实模板/持久化 27 项、连接注入 15 项、删除保留 10 项、三类新目标恢复 9 项及失联恢复 13 项已通过，真实控制台和工程回归已通过。本文记录领域职责和实施规则；实际结果与剩余关口见 [S5 验收](acceptance/S5.md)。

依据：[PRD F18–F22 与数据规则](prd.md#54-数据模板与-git)、[技术方案 3.5](technical-plan.md#35-存储日志与凭证)、[开发计划 S5.01–S5.08](development-plan.md#8-s5持久化数据库与基础模板)、[S5 UI 实施说明](s5-ui-implementation-notes.md)。公开名称以 [S5 契约](api-contract-s5.md)、DTO/OpenAPI 和生成客户端为准。

## 1. 交付范围与固定决策

S5 交付卷与挂载、单实例 StatefulSet、PostgreSQL/Redis、同环境的有限数据库连接注入、五类基础模板，以及 PostgreSQL、Redis、普通文件卷各自的手工备份和新目标恢复闭环。S8 再实现平台备份执行、定时、下载与自动对象存储上传；S7 实现通用变量引用、组合模板和镜像回滚，F48 实现密码轮换、主版本升级与迁移。

本阶段保持以下规则：

1. `Cluster → Project → Environment → Service/Volume`。Volume 的实际集群、Namespace 由所属环境的项目确定；请求不能覆盖目标，重试不能改投另一集群。
2. **Volume 的生命周期独立于 Service。** 停止、重启、重新发布和删除服务均不删除 PVC/PV；Namespace 清理不能绕过卷保留。
3. 首版只管理经过验证的 local-path 文件系统卷，使用 RWO；申请容量不等于硬配额。其他 StorageClass 可观察并明确给出不支持原因，不仅因类名存在就开放破坏性动作。扩容、缩容、存储类型转换和自动搬盘不进入普通编辑。
4. 普通应用有可写卷时单副本、Recreate；数据库使用单实例 StatefulSet。节点失联时停止自动恢复写入，不强制删除失联 Pod、不猜测数据已移动。
5. 数据库保护随**数据身份**保留。PVC 已存在或初始化写入可能发生后，保存、发布、重试、恢复/重启及后续回滚都不能改变密码、引擎主版本或数据目录语义。
6. 草稿、已发布快照、任务结果与实际观察分别保存。PVC 创建成功不等于 Bound；数据库端口可连接不等于认证和数据验证已通过。
7. 手工恢复在明确目标环境下创建新卷/新服务；源数据保留，不自动修改应用连接、DNS 或项目归属。

## 2. 当前工程与实际改动位置

| 实现位置 | 已落地职责 |
| --- | --- |
| [ServiceCommands](../packages/control-plane/src/services/commands.ts) | revision、草稿、发布、原快照重试与显式启动，共用数据库变更保护；模板和卷/连接配置进入同一服务生命周期 |
| [ServiceExecutor](../packages/control-plane/src/services/executor.ts) | 固定目标、任务租约、逐资源回执及完整发布快照；组合存储预检、挂载占用、StatefulSet 和数据库认证检查，删除服务保留数据 |
| [服务持久化](../packages/control-plane/src/services/persistence.ts)、[数据库运行配置](../packages/control-plane/src/databases/runtime.ts) | 通用 Secret 引用和有限数据库连接输出分开解析；数据库凭证通过固定依赖进入发布，不能作为任意 `database` Secret 注入 |
| [Workload Interface](../packages/infrastructure/src/workload/contracts.ts)、[manifests](../packages/infrastructure/src/workload/manifests.ts) | 共用 `apply/observe/waitHealthy/operate`；明确 Deployment/StatefulSet 类型，支持固定 PVC、Recreate 和单实例数据库 |
| [Workload 观察](../packages/infrastructure/src/workload/observation.ts)、[日志读取](../packages/control-plane/src/services/logs.ts) | 按 UID 校验 Pod 归属，区分 ReplicaSet 与 StatefulSet，使用同一套有界日志和秘密脱敏 |
| [存储领域](../packages/control-plane/src/storage/index.ts)、[存储 Adapter](../packages/infrastructure/src/storage/adapter.ts) | Volume/PVC 身份、PV/节点观察、挂载互斥、维护与独立销毁；逐次回执和版本比较保护原数据位置 |
| [数据库领域](../packages/control-plane/src/databases/index.ts)、[模板目录](../packages/control-plane/src/templates/catalog.ts) | 初始化保护、受限同环境连接、五类固定版本模板与镜像资产，不为每种数据库建立独立发布引擎 |
| [Prisma 模型](../packages/database/prisma/schema.prisma) | Volume、VolumeMount、VolumeMutation、VolumeMaintenance、DatabaseInstance、DatabaseBinding 及两类 Deployment 引用与原任务模型共存 |

S3 的 `repairMissing` 可以重建确认丢失的无状态工作负载。**这条规则不能扩展为自动重建丢失的 PVC**：创建同名空 PVC 会掩盖数据丢失，存储必须失败并进入恢复流程。

## 3. Module、Interface 与 Seam

| Module       | 对调用方的 Interface                                                     | 留在 Implementation 内的职责                                                      |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Storage      | 创建/观察 Volume、保存挂载草稿、为发布准备固定卷引用、显式销毁审查与任务 | 目标继承、PVC 身份、PV 关联、单写入占用、节点约束、维护锁、删除检查、回执 CAS     |
| Database     | 根据固定模板生成配置、检查候选变更、观察初始化、解析有限连接输出         | 数据身份、初始化保护、凭证生成/解析、引擎和数据目录兼容、认证验证                 |
| Templates    | 列出固定版本、预览参数、生成统一 Service 草稿                            | 有限 schema、版本/架构资产、生成配置；不包含单独的 PostgreSQL/Redis 部署引擎      |
| Services     | 现有保存、发布、原快照重试、停止/恢复/删除                               | 组合上述结果，创建统一 Deployment/Operation，继续持有 ServiceMutation             |
| 手工数据记录 | 记录和查询操作者提交的备份/恢复证据                                      | 元数据校验、来源标记、审计；S5 不由记录接口执行任意命令、下载文件或上传到对象存储 |

基础设施 Seam 分为现有 `KubernetesWorkloadManager` 和新增的 `KubernetesStorageManager`。前者处理 controller、Service、运行期 Secret 与 Pod 观察；后者处理已登记 PVC 和只读 PV/StorageClass/实际挂载观察。两个 Seam 都有真实 Kubernetes Adapter 和受控协议故障 Adapter，测试跨同一 Interface 验证行为。

Storage 对 Workload 提供已经校验过的 `PreparedVolumeBindings`，包含 Volume ID、Namespace/PVC 名与 UID、只读属性、受控挂载路径、存储身份和观察时间。它不接受任意宿主路径。服务编排负责在远端写入前再次调用 Storage 的检查；不能仅在生成预览时检查一次。

Namespace 保持现有环境级 ManagedResource 的唯一身份。独立创建 Volume 和发布服务都使用同一个 Namespace 登记/写入实现，不能分别生成 nonce 或建立两条所有权记录。出现这两个真实调用方后再提取该共享 Implementation。

## 4. 数据模型与迁移

### 4.1 新增持久对象

| 对象                          | 关键字段/约束                                                                                                                                                        | 保留与删除语义                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Volume`                      | 稳定 id、name/slug、environmentId、只读 clusterId/Namespace、完整 targetJson；requestBytes、StorageClass 名及 UID、volumeMode/accessModes；revision/mutationRevision | 一个 Volume 对应一个平台创建的 PVC。归属不能 PATCH；确认销毁后保留 tombstone 和原目标                    |
| Volume 内的 PVC 台账          | 固定 pvcName、creationNonce、creationAttempted、pvcUid/resourceVersion、ledgerVersion、specFingerprint、逐次 receipt、删除意图/确认时间                              | 不放入服务的可删除 ManagedResource 清单；nonce 在首次 POST 前持久化；已存在 UID 不能由观察换成另一个 UID |
| Volume 观察                   | PVC phase、PV 名/UID、claimRef UID、StorageClass 实际参数、回收策略、reportedCapacity、nodeAffinity、匹配 Node UID、观察时间/过期/错误                               | PV 是动态 provisioner 生成的关联对象，默认只读；PVC/PV/Node 的名称都不能单独充当身份                     |
| `VolumeMount`                 | serviceId、volumeId、mountPath、readOnly、desired、detachedAt、最近发布引用；保留原服务/目标摘要                                                                     | 删除挂载草稿后保留“待实际卸载”记录。确认新快照已应用且旧 Pod 不再挂载后才释放占用                        |
| `VolumeMutation`              | volumeId 为唯一活动槽；operationId/deploymentId 二选一，关联既有任务租约                                                                                             | 独立卷操作与服务发布串行修改同一卷；任务结束释放槽，不代表挂载占用或维护锁也已释放                       |
| `DatabaseInstance`            | 稳定 id、唯一可空 serviceId、唯一 dataVolumeId；engine、固定模板版本/镜像族/主版本/数据布局；credentialRefId、用户名/库名/Redis DB index                             | 服务删除后 serviceId 置空，数据身份、初始化保护、凭证引用继续保留；不把保留卷当作新库                    |
| Database 初始化证据           | protectionRevision、initializationFenceAt、状态、固定 engine/major/credentialRefId/layout、初次意图和确认的 PVC UID、认证检查时间/结果                               | fence 单向建立；失败、取消、未知观察及服务删除都不能清除。`initializedAt` 与保护是否生效分开             |
| `DatabaseBinding`             | consumerServiceId、databaseInstanceId、固定输出 profile、变量名映射、revision                                                                                        | 只支持同项目/环境/集群；保存进入消费者草稿，不触发热更新                                                 |
| `DeploymentVolumeReference`   | deploymentId、volumeId、挂载路径/只读、存储 revision 与固定数据身份、受理时已知 PVC UID                                                                              | 快照引用用 FK 保留；首次创建的实际 UID 进入单次解析回执，重试复用它，不改写原 snapshot                   |
| `DeploymentDatabaseReference` | deploymentId、bindingId/数据库身份、提供方固定发布与 Service UID、输出版本、credentialRefId                                                                          | 与 DeploymentSecretReference 同事务保存；历史可追溯，不能重试到同名的新数据库                            |

`Volume` 已是一对一 PVC 台账，首版不再创建只转发同一组字段的第三张通用存储台账表。PV 不属于平台主动创建的资源，也不加入普通服务删除清单。

数据库 identity 必须在脱离服务后继续保护原卷。S5 的数据库模板默认分配新卷；如果提供“重新接回保留数据库”入口，它必须引用原 DatabaseInstance，并保留引擎、主版本、凭证与实际 PVC UID。普通应用不能把已标记为数据库数据的卷作为可写通用卷，以此绕过这些规则；缺少可信身份的旧数据库卷只允许观察和独立恢复。

### 4.2 由 SQL 与事务共同保证的约束

- Volume 的 `(clusterId, namespace, pvcName)` 唯一；所有活卷必须关联有效 Environment/Cluster，并与 Environment→Project 的目标一致。跨表一致性由写入事务和受控触发器维护，不能只校验 HTTP 输入。
- `(serviceId, mountPath)` 在未完成卸载的记录中唯一；一个 Volume 最多保留一个未释放的可写服务占用。只读挂载也参与销毁检查。多卷锁按固定顺序获取，并与 Service 行锁顺序统一，避免发布/卸载/销毁相互死锁。
- 活动 VolumeMount 的 serviceId、Volume 归属与实际集群必须有效；草稿解除不立即删除 FK。服务删除提交前必须完成实际停止/删除，并把其挂载记录标记为已脱离。
- `DatabaseInstance.dataVolumeId` 唯一；凭证 FK `RESTRICT`，并验证类型为现有 `SecretKind.database`。普通配置引用和历史 DeploymentSecretReference 继续保护密文。
- 任务槽与 Outbox 的一对一/二选一约束在 SQL 中实际落地；恢复 generation、租约、revision 和 ledgerVersion 都参与条件更新。
- 活卷/保留数据阻止 Environment/Project 删除，也阻止 Cluster 移除；不能用父级级联删除 PVC 台账。已确认销毁的 tombstone 才允许关系在删除父级时置空，原 targetJson/PVC UID/回执保留；CHECK/删除事务阻止活卷变为 detached 记录。
- DatabaseInstance 的 serviceId 可在服务删除后置空；数据卷及凭证仍被引用。删除原服务不能清掉初始化 fence 或凭证保护。

### 4.3 兼容 S3/S4 的迁移顺序

1. 做控制面一致性备份，保留匹配的主密钥；在隔离 schema 从真实 S4 迁移到 S5，验证旧 Service、Deployment、Domain、两类台账与秘密引用未改变。
2. 新表/索引/可空关联采用加法迁移。旧服务按应用 Deployment、无卷、无数据库依赖解释，不批量创建虚构 Volume，也不读取 Kubernetes 后猜测并认领外部 PVC。
3. 引入明确的配置/快照版本读取器。旧 `ServiceSnapshot.version=1`、DeploymentResult 和 Pod 观察仍可读取/重试；新快照带 `version=2`、`controller.kind`、卷/连接引用和固定模板身份。旧 JSON 保留原字节语义，不静默改历史数据。
4. published/观察使用 `controller: {kind:'Deployment'|'StatefulSet', uid, ...}` 的明确判别。旧字段在兼容读取器中转换，Console、日志、诊断与网络调用同时更新，不能用 StatefulSet UID 填充名为 `replicaSetUid` 的字段。
5. S4 的 HTTP Service/端口 UID 保持稳定；数据库继续只有 TCP ClusterIP。迁移前后回归 S3 普通镜像发布与 S4 域名，确认新数据功能没有改变旧任务含义。
6. 新版本出现 S5 写入后不承诺直接降级旧二进制。回退采用匹配版本的控制面备份和恢复只读对账；控制面元数据回退不能回滚业务卷内容。

## 5. Volume 创建、挂载与销毁

### 5.1 PVC/PV 的事实来源

独立创建 Volume 返回持久 Operation。模板保存可先分配 Volume 元数据与稳定名称，首次发布再在该 Deployment 的存储阶段创建 PVC；两条路径使用同一 Storage Implementation。

创建步骤为：固定目标和 StorageClass 身份 → 登记 PVC nonce → 核验命名空间/PVC 是否已有冲突 → 写入前持久意图 → POST → 保存 UID/版本回执。收到超时或回执丢失时，用固定名称 GET、原 nonce、目标和创建意图恢复确认；不因为相同标签就接管外部 PVC。

`WaitForFirstConsumer` 的 PVC 可以在 `Pending` 时完成“已创建”任务。不能先等 Bound 才创建首个消费者，否则会形成死锁。创建消费者后，再等待 PVC/PV 绑定、Pod 调度与应用健康分别成立。

绑定观察同时验证：PVC UID 未变、PVC.spec.volumeName、PV UID、PV.claimRef 的 Namespace/名称/UID、存储类与 provisioner，以及实际 nodeAffinity。绑定前节点为未知；绑定后记录完整约束及匹配 Node 身份，不能用第一个节点或服务期望节点代填。节点同名但 UID 变化时重新核对数据身份，不能自动认作原数据位置。

容量展示分为 `requestedBytes`、PV 报告的 `capacityBytes`、`hardQuotaSupport`、实际已用/节点可用空间与采集时间。local-path 的硬配额明确为 `unsupported`；没有独立采集时已用和可用空间为 `null`，不拿 Node allocatable 或 PVC 申请量推导剩余磁盘。

### 5.2 挂载及发布顺序

- 路径为受限的容器内绝对 POSIX 路径；限制字节数和挂载数量，拒绝 NUL、反斜线、`.`/`..` 段、根目录和重复/相互覆盖路径。`/proc`、`/sys`、`/dev`、平台 Secret 路径等不可覆盖。首版不提供 hostPath、任意 subPath 或脚本拼接。
- 保存挂载时锁定 Service 和涉及的 Volume，验证同环境同集群、可写唯一占用、数据库卷类型、资源上限；原子增加 Service revision/configRevision，并保留已发布引用。
- 发布受理时固定卷引用与已知 UID，获得 ServiceMutation 和相关 VolumeMutation；执行前再次核对。卷销毁、维护、身份未知或所需节点不在原身份上时拒绝应用。
- 普通可写卷应用先确认旧 Pod 已终止，再放行新实例健康。Deployment 使用 Recreate 和单副本，不能仍沿用 `maxSurge:1`。更新挂载会中断服务，预览必须说明。
- 同一服务的多个本地卷必须有可满足的节点约束交集；不能把不同节点上的卷“搬到一起”。镜像架构也要满足真实可调度节点。
- 去掉挂载只是草稿变化。成功发布去掉挂载的配置，并确认所有旧 Pod 不再引用该 PVC 后，才释放占用。stopped 服务仍保留其已发布挂载；仅保存草稿不能让恢复动作失去原数据。从未发布、没有创建/挂载意图的纯草稿引用，可在同一事务确认这些条件后直接解除。
- 真实 Pod 检查覆盖整个 Namespace 内所有 PVC 引用，不能只列平台标签匹配的 Pod。未授权、列表截断、失联、终止未确认或 VolumeAttachment 状态未知均不是“无人使用”。

### 5.3 维护与独立销毁

普通文件卷备份和新卷导入需要一个持久维护标记：先停止相应服务，任务核对零活动挂载后进入维护；所有普通发布、恢复和卷销毁统一尊重该标记。维护工具完成并移除自己的 helper Pod 后，再由显式退出动作核验并解除。Worker 中断或超时不能自动解除未知维护状态。此标记用于手工 runbook 的互斥，不等于已实现 S8 备份调度器。

独立销毁采用“预览 → 明确意图 → Worker 再验证 → UID/版本限定删除 → 观察回收结果”：

1. 预览列出具体 Volume/PVC/PV、原数据用途、申请容量、StorageClass/PV 实际回收策略、最近备份记录及观察时间。预览不授权跳过执行时检查。
2. 拒绝仍在草稿、当前已发布快照、在途任务或实际 Pod 中使用的卷；旧历史引用保留，但不能据此向已销毁卷重放任务。
3. S5 自动销毁限定为已验证 provisioner 且实际回收策略为 `Delete`。`Retain`、策略漂移或未知实现返回明确阻止原因，保留数据与记录，转人工处置；不悄悄把策略改为 Delete。
4. 删除 PVC 必须带已登记 UID/resourceVersion 前提，等待 PVC 和关联 PV 的资源结果。部分删除、provisioner 卡住或节点失联保留任务/回执，可重试同一意图。看到 404 只证明相应资源不存在，不能宣称存储介质已安全擦除。
5. 平台不执行任意节点目录 `rm -rf`，不删除 Namespace 代替 PVC 销毁，也不因 API 错误改用无条件强删。

从未尝试创建 PVC 且没有任何引用的 Volume 可撤销纯元数据，结果标记“无远端资源”。只要存在创建意图或身份不明，就不能用这个快捷路径跳过远端核对。

## 6. StatefulSet 与数据库保护

### 6.1 共用发布引擎

数据库通过现有 Service/Deployment 任务发布，使用一副本 StatefulSet、独立预创建 PVC 和稳定 ClusterIP Service。PVC 由 Volume 拥有，不使用自动生成后难以对账的 `volumeClaimTemplates`；StatefulSet 不给 PVC 设置会随工作负载删除的 ownerReference。

StatefulSet 另有固定的 headless governing Service，标记独立资源 role；应用连接使用稳定的普通 ClusterIP Service。普通 Service 名和输出键不因 Pod 重建改变。

观察需核对 StatefulSet UID、generation/observedGeneration、current/update revision、ready/updated replicas、Pod ownerReference 和模板；Pod 日志用此真实归属链校验。controller、PVC、认证探针都通过后才显示数据库可用。停止等待零活动 Pod，恢复使用原 published 快照；控制面不根据草稿重建数据库。

模板固定资源预算、startup/readiness、终止宽限、数据目录/UID/GID/权限处理。目录权限通过经过验证的镜像 entrypoint 或受控 fsGroup 处理，不开放 privileged、宿主根目录或 Docker socket。真实 A/B 验证前不假设不同发行版镜像的数据目录和 UID 一致。

### 6.2 初始化保护是单独的事实

数据库保护集中在 [protection.ts](../packages/control-plane/src/databases/protection.ts)：`establishDatabaseFence` 持久建立初始化保护，`assertDatabaseSnapshot` 校验候选快照，`assertDatabaseSecretMutation` 保护被数据引用的凭证。保存、发布和运行操作共用这些规则，不在各入口分别维护一份禁止变量名清单。

保护最迟在**首次 PVC 创建意图或首次可能写入数据库之前**持久建立；未知已有 PVC 一律按可能已有数据处理。即使第一次部署未 Ready、POST 回执丢失或 Worker 被杀，密码/主版本仍锁定。`initializedAt` 只有在受控认证检查证明当前引擎和目标可用后写入，不能反向清除 fence。

| 入口                  | 必须核对的候选内容                                         | 必须拒绝的绕过方式                                                                              |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 保存 Service/模板参数 | 新完整配置与现有数据身份，事务内检查后才保存新秘密引用     | 修改 PASSWORD/USER/DB/PGDATA、`*_FILE`、Redis ACL/AOF 路径、command/args 或把 kind 改为普通应用 |
| 发布受理              | 当前草稿、固定模板版本、卷/凭证、保护版本                  | 用 tag 字符串声称“同主版本”，或改用未知镜像/digest 绕过镜像族检查                               |
| Worker 执行/逐次写入  | 原快照、实际解析镜像、实时 fence、PVC UID、当前代次/租约   | 受理后数据初始化或卷身份变化，仍按旧判断继续写入                                                |
| 失败/取消重试         | 原不可变快照、原产物/目标与当前更严格的数据保护            | 重试时换当前草稿、重解析移动 tag、把未知初始化状态重置为新库                                    |
| stop/resume/restart   | 停止可保留数据；恢复/重启核对原 published 的数据身份与凭证 | 恢复时自动套用新密码、新主版本或重新创建丢失 PVC                                                |
| 重新接回保留数据      | 原 DatabaseInstance、原 PVC UID/凭证/布局                  | 删除 Service 后通过新服务重置保护，或用通用可写卷挂载绕过                                       |
| 后续回滚              | 历史镜像和完整基准配置仍须通过同一检查                     | 把镜像回滚当作数据库数据回滚或允许主版本降级                                                    |

引擎、主版本、凭证版本、用户名/库名、数据目录/布局与初始化参数在 fence 后受保护。S5 的同主版本修订仅允许固定目录中明确兼容的 patch 镜像；未知镜像、任意 shell/模块参数及数据布局变化都拒绝。`allowConfigurationRepair` 不放宽数据保护。

新 SecretReference 指向相同密码也不能自行视为轮换成功。主密钥重新加密只改变密文包装，不改变数据身份所固定的凭证语义。原数据库被人在外部改密码时如实显示认证失败，不通过保存新 Secret 宣称数据库已完成维护。

### 6.3 固定模板

| 模板 key         | 工作负载/数据                    | 参数与受保护配置                                                                                   |
| ---------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docker`         | 普通 Deployment，可选 Volume     | OCI 镜像、现有端口/资源/探针；有可写卷自动采用已说明的单副本 Recreate                              |
| `node-example`   | 预构建 Node.js 示例 Deployment   | 固定示例镜像与说明，进入统一镜像发布流程；不接受源码仓库冒充自动构建                               |
| `static-example` | 预构建静态站点 Deployment        | 固定示例镜像与 HTTP 端口，复用 S4 域名流程                                                         |
| `postgresql`     | 一副本 StatefulSet + 数据 Volume | 生成 `database` 凭证，固定镜像族/主版本、用户/库名/数据目录，私有 TCP Service                      |
| `redis`          | 一副本 StatefulSet + 数据 Volume | 生成认证凭证，固定 `appendonly yes`、`appendfsync everysec`、数据目录与 ACL 文件，私有 TCP Service |

模板目录是随版本发布的受控资产，带稳定 templateId/version、有限参数 schema、镜像 index/平台 digest、许可与来源、数据布局及资源默认值。精确 patch/digest 已固定在镜像资产表并完成 A/B 实际运行核验，见 [模板资产结果](acceptance/s5-template-assets-results.json)；镜像可用性与控制面镜像验证分别记录。模板保存只生成草稿、引用和待创建卷；发布仍需用户已有的明确动作。

PostgreSQL 使用有界的认证 SQL 检查数据库/用户/引擎版本。Redis 同时检查认证、引擎版本和 AOF 实际状态；AOF everysec 不是零数据丢失保证。认证探针使用固定命令和受控 Secret 输入，不允许把密码写进 CLI 参数、普通 URL、模板 JSON 或任务日志。Redis 的 ACL/配置由受控 Secret 文件提供，不能通过 shell 展开后把密码放到 `redis-server --requirepass ...` 的进程参数。

## 7. 同环境数据库连接注入

S5 的输出限于 PostgreSQL 的 host/port/database/user/password，以及 Redis 的 host/port/db/password；提供字段模式和受控连接串模式。连接串在 Worker 内生成并整体按秘密处理，普通预览只展示字段与引用。

流程为：选择已就绪提供方 → 预览消费者变量差异 → 保存 DatabaseBinding/草稿 → 消费者显式发布 → 固定输出和秘密版本 → Worker 注入不可变运行期 Secret。只按稳定 databaseInstanceId/输出键绑定，不保存易变显示名称作为身份。

- 提供方必须和消费者同项目、同环境、同集群，且有可信 published、当前 Service UID、数据身份与新鲜认证观察。未就绪、缺失或未知结果阻止相应消费者发布。
- 输出解析与保存快照发生在同一事务，保存 DeploymentDatabaseReference 及 DeploymentSecretReference；发布前再核验提供方身份。新输出不热更新已运行 Pod，只标记消费者有待发布变化。
- 注入的变量名与手工变量、其他绑定冲突时返回字段级错误，不暗定覆盖优先级。用户不能通过直接提交 `SecretKind.database` 的任意 secretRefId 绕过同环境检查。
- 删除数据库 Service 前检查当前草稿、当前 published、在途消费者的真实依赖；返回阻止的消费者身份。历史引用保留，原任务在提供方已移除或身份变化后不能重放到同名新实例。
- ClusterIP 和 Namespace 仅表明访问方式。S8 未验证 NetworkPolicy 前，不声称环境之间已被网络强隔离；S5 不为数据库自动创建 NodePort、LoadBalancer、Ingress 或公网 TCP。

## 8. 已实现的 HTTP Interface

精确路径、DTO、字段名和返回结构统一维护在 [S5 API 契约](api-contract-s5.md)，由 OpenAPI 生成客户端；本节不再维护实施前的另一份接口草案。

- 模板预览只计算配置；模板创建仍走 `POST /services`，保存草稿，不自动发布。
- 独立卷创建返回 `202` 和真实 `volumeId/Operation`；挂载与数据库绑定保存返回对应集合和 Service/config revision，修改草稿，不直接更改 Pod。
- Volume 读取区分申请容量、PV 容量、硬配额、实际用量、PVC/PV/Node 身份、期望/已发布/实际挂载、过期观察、维护和活动任务。未知用量保持 `null`。
- 数据库实例有独立稳定 ID，可在原服务删除后保留；数据库可用性与服务运行状态分别表达，普通响应不返回密码或完整连接串。
- 卷销毁先预览，再绑定 Volume/PVC UID、回收策略与摘要提交；Worker 执行前重新核对引用、实际挂载、维护与原数据位置。
- 手工记录固定归入源卷记录簿，备份与恢复共用不可变 backupId；响应标明 `operator_reported`。记录 API 不执行导入或上传。

字节数使用十进制字符串，备份位置使用脱敏显示标签。配置无效返回 `422`，当前状态冲突返回 `409`；异步失败保存在 Operation/Deployment。错误包含稳定 code 和可操作说明，不包含 Secret 内容、原始 SQL 或连接串。

## 9. 手工备份与新目标恢复

S5.07 已交付[操作手册和辅助工具](manual-data-recovery.md)，三类 A → B 新目标恢复的 [9 项真实检查](acceptance/s5-recovery-local-results.json)已通过。本节保留实现规则，支持范围、失败矩阵和本次小型数据样本的边界以手册及报告为准。工具只作用于产品解析出的固定目标，不接受任意集群覆盖或无界宿主路径。流程记录与数据文件分离，敏感认证不进入报告。

### 9.1 三种数据采用不同方法

| 数据类型   | 备份方法与一致性                                                                                             | 恢复到新目标的必要步骤                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | 与源主版本匹配的 `pg_dump` 自定义格式，一致性数据库快照；不导出角色密码/属主 ACL，不对运行中的 PGDATA 打 tar | 新服务/新卷/新空库，匹配主版本；`pg_restore --single-transaction --exit-on-error --no-owner --no-acl`；校验表、行、关键值和约束，失败不得开放消费者             |
| Redis      | 认证的 RDB 快照导出；记录快照标记/时间与格式。正常服务仍启用 AOF everysec                                    | 新卷在维护状态导入；先用受控临时实例以 AOF 关闭方式加载 RDB，再开启 AOF，等待首次 rewrite 成功并正常停止；随后由固定 AOF 模板启动，校验键/值/TTL和实际 AOF 状态 |
| 普通文件卷 | 先停止所有写入者并确认零活动挂载，在维护保护内以只读 helper 归档                                             | 校验归档条目/总大小/哈希，仅解压到新卷；阻止绝对路径、越界 `..`、逃逸链接和特殊设备；按模板验证 UID/GID/权限，再发布目标服务                                    |

不能把 RDB 文件放进一个已经运行且有旧 AOF 的 Redis 卷后宣布恢复成功，也不能只复制 Redis 多文件 AOF 目录中的某一个文件。若选择 AOF 归档路径，须正常停写并完整保留 manifest/base/incremental 集合，单独验证；S5 最小闭环优先采用上表的 RDB→新 AOF 流程。

数据库恢复在新卷的维护保护下使用受控临时实例，复用目标模板的数据布局和目标凭证。PostgreSQL 由该临时实例创建空库并接收逻辑导入；Redis 按上表转换持久化格式。正式 StatefulSet 在导入验证完成、临时实例正常停止并确认 helper Pod 已消失后才启动，不能一边导入一边允许正式服务发布或消费者写入。

恢复 PostgreSQL 到新空库可使用新生成的目标凭证，因为逻辑 dump 不恢复角色密码；这不是修改源数据库 PVC 的初始化凭证。普通文件归档不得用于绕过数据库专用恢复流程。

### 9.2 清单、记录与失败恢复

每份产物有不可覆盖的 backupId，记录源 installation/Cluster/kube-system/环境/Volume/PVC UID、数据库 engine/精确版本和布局、格式/工具版本、大小、SHA256、采集起止时间、可确认的数据时间点、停写要求、离机副本位置与校验结果。恢复记录包含新目标映射、原备份 ID、开始/完成时间、验证步骤与结果。

备份时间不能用文件 mtime 冒充一致性时间点；无法证明的时间标注范围或未知。验证至少包含 PostgreSQL 的固定事务/行标记、Redis 的键/值与 TTL、普通文件的内容/权限清单。Redis 记录绝对过期时间或可验证时间范围，扣除复制/恢复耗时，不能要求恢复后的剩余 TTL 等于备份前的数字。记录从开始恢复到数据验证完成的耗时及失败重试，不只记录 Pod 启动速度。

输出使用临时文件，全部校验后原子发布正式清单。中断或校验失败只留下明确的不完整产物；不覆盖历史备份。恢复失败的新目标保持维护/未就绪，保留诊断；原库和源卷不删除，不转流量。

`manual-data-records` 是操作者陈述及证据索引，响应明确 `verificationSource: 'operator_reported'`；请求不能自己设置 `platformVerified:true`。实际 S5 验收报告由受控工具的真实数据比较形成，分别保存命令版本、产物哈希和验证来源。S8 再通过平台执行任务产生平台已核验的 Backup 记录。

## 10. 实际 A/B 验证路径

使用[已有本地环境](local-lab.md)的 A/B 两个独立 K3s，不重装或替换它们。当前配置为 Ubuntu 24.04 ARM64、K3s 1.35.9、每台 2 CPU/2304 MiB/20 GiB；每次写入窗口前读取真实状态和可用磁盘。两台节点都叫 `ozz-node`，始终按 Cluster UID 与 Node UID 区分。真实 S5 操作使用持久状态和协调窗口；下表为验证映射，具体已通过范围只以验收报告为准。

测试新建明确标记的项目/环境/服务/卷，保存固定 ID 和幂等键。一次只运行本轮所需数据库负载，避免把 A/B 容量预算当作已测可承载数量。所有用例保留原失败记录，不使用全局 prune、删除测试 Namespace 或清库掩盖失败。

| 顺序 | 实际动作                                                                        | 必须记录的事实                                                                              |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A1   | 读取 A/B StorageClass、节点、权限与 provisioner；核对身份和余量                 | 当前支持能力/时间，local-path 无硬配额；观察不足明确阻止                                    |
| A2   | 在 A 创建独立 Volume，先不创建消费者，再通过浏览器挂载到普通应用                | WFFC Pending 且节点未知；创建任务可完成；发布后真实 PVC/PV/Node UID 和挂载一致              |
| A3   | 应用写文件，重建 Pod；再保存卸载草稿而不发布、停止、恢复                        | 文件校验仍一致；草稿卸载不释放旧占用，恢复保留原 published 挂载                             |
| A4   | 发布完整卸载，验证零挂载，再测试销毁；并尝试跨环境/跨集群/第二写入者            | 实际卸载后才释放占用；错误请求零远端副作用；销毁按真实 Delete 策略观察，不靠 Namespace 删除 |
| A5   | 用 PostgreSQL 模板建库并写入固定事务标记、行与索引；用 Redis 模板写入键和值/TTL | 两类服务均为实际 StatefulSet、私有 Service；凭证不出普通 API；Redis 实际 AOF 开启           |
| A6   | 分别重建两类 Pod，再停止/恢复；尝试密码、主版本、命令/数据路径变更和原失败重试  | 数据保持；首次意图后的各种入口共用同一保护；失败/取消不能重置初始化状态                     |
| A7   | 同环境示例应用连接两类数据库；另一环境/项目尝试自动绑定；提供方删除审查         | 应用实际读写成功；越界引用被拒；连接保存与应用发布分开；当前消费者依赖阻止删除              |
| A8   | 协调后受控暂停 A 的 K3s API，以独立看门狗保证恢复；观察 A 过期而 B 继续更新 | 验证 API 失联时 PVC/PV/Node 与数据库旧观察保留；此项不等于整机掉电或多节点重新调度验证。节点失联拒绝在协议用例验证，真实多节点 E13 在 S8 补验 |
| B1   | 从 A 导出 PostgreSQL、Redis、普通文件三份备份，复制到源 VM 外并核验哈希         | 源/副本独立位置、格式、版本、数据时间点与完整性；至少一个副本不在 A 数据盘                  |
| B2   | 在 B 的新项目/环境创建新服务/新卷，逐类恢复并执行数据比较                       | 新 Cluster/PVC/服务身份与明确映射；源 A 保持；行/键/TTL/文件权限验证通过，记录耗时          |
| B3   | 试损坏备份、非空目标、错误主版本、恢复中断及维护锁内普通发布                    | 拒绝覆盖与错误输入；中断目标保留/隔离，可审阅后按原意图继续或另建新目标；源数据和 DNS 不变  |
| AB4  | 完成五类模板浏览器流程和工程回归                                                | 真正的 Docker/Node 示例/静态/PostgreSQL/Redis 均运行；S3/S4 原服务、域名和任务仍正常        |

本地离机路径可用 A → macOS 受保护备份目录 → B：它证明备份离开源 VM 数据盘并可恢复到另一套集群。A/B/宿主仍共享一台物理机器，不能据此宣称物理异机容灾已通过；接入真实 VPS 后需把正式副本复制到独立机器/存储并另记验证。

## 11. 实施顺序、测试与退出条件

1. **S5.01–02：领域与存储。** 先落迁移、Volume/PVC 身份、只读观察、挂载草稿/占用、维护/销毁保护；完成隔离数据库测试和 Kubernetes 协议故障测试。重点验证 UID 同名替换、POST/DELETE 失回执、WFFC、外部 Pod 挂载、旧观察 CAS、恢复 generation 与取消。
2. **S5.03：发布引擎。** 引入版本化 controller 判别、StatefulSet、Recreate、PVC 固定引用、停止/恢复/日志/观察；先保住现有 Deployment 的 Interface 和 S3/S4 回归。
3. **S5.04–06：数据身份、模板与连接。** 固定并核验模板镜像/架构/目录，统一数据库变更保护，原子创建草稿与秘密，固定连接输出，接 Console。协议测试必须验证只靠换 tag、Secret、kind、命令、删除重建服务或重试不能绕过保护。
4. **S5.07：手工 runbook。** 实现受保护导出/复制/恢复工具和清单，分开验证三类数据及失败路径；保存明确的 operator record 与真实验收证据。
5. **S5.08：真实 A/B 与 UI。** 执行上表、检查中文输入/焦点/主题/390/1024/1440布局、任务与观察分离，以及真实响应中的秘密不可见；整理 `docs/acceptance/S5.md`、命令/版本、结果和仍未验收的真实 VPS/AMD64 项。

退出标准是 S5.01–S5.08 与 F18–F20/F22 的适用条款全部有对应证据。仅模板截图、PVC `Bound`、Pod `Running`、模拟数据库返回或手填“备份成功”均不足以完成这一阶段。
