# S6 GitHub 与 Dockerfile 隔离构建实施方案

日期：2026-10-26。状态：**实施中，尚未验收**。本文确定 S6 的 Implementation、共享 TypeScript 形状及文件所有权，具体可用能力以代码与验收记录为准。S5 已封存为 `s5-20261026T004406Z-5b4fee22`（源码归档 SHA256 `fb0d8402542cac614268789efe0ece0860d4bc1c25b7de51d59b8b969264e173`）；其 Linux ARM64 四镜像与 Compose 交付已通过，S6 继续在工作区开发。隔离数据库回归通过后，公共主库已应用 `202610260004_s6_git_build`；36 张原表、2,025 条原有记录的全部旧字段哈希一致，环境文件与主密钥保持不变，见[升级记录](acceptance/s6-upgrade-results.json)。该迁移现已冻结，后续数据库修复只能新增迁移。

依据：[PRD F21 与统一业务语义](prd.md)、[开发计划 S6.01–S6.08](development-plan.md)、[S5/S6 UI 说明](s5-ui-implementation-notes.md)、[已确认 Stitch 映射](../designs/console-v2/stitch-screen-map.md)。技术栈保持 TypeScript/Node 24、Nest/Fastify、Prisma/PostgreSQL、Redis/BullMQ、Vue 3/shadcn-vue/Tailwind 4，归属保持 `Cluster → Project → Environment → Service`。

**范围与固定决策。** P0 实现 GitHub fine-grained PAT 凭证授权、授权仓库/分支选择、固定 commit、显式 Dockerfile/context、独立 Builder、OCI 推送、统一发布、Webhook 和停止期间待发布提交。采用 V3 Git 快照，不使用占位镜像。保持三种产物状态：尚无产物、已生成 OCI 尚未推送、已推送 Registry。取消必须取得可信的远端结束证明后才完成。免 Dockerfile、watch paths、组合模板、通用变量引用、镜像回滚和交互终端不在 S6 实施。

| Module | 对调用方的 Interface | 内部 Implementation / 真实 Adapter |
| --- | --- | --- |
| Git 来源与收件 | 保存来源、预览固定提交、接收事件、查询/明确发布待办 | GitHub 授权、路径检查、原始体验签、两级去重、逐服务投递与停止规则 |
| Services / Tasks | 现有保存、发布、重试、停止/恢复/删除及持久任务查询 | 快照、固定目标、ServiceMutation、数据引用、Outbox、执行 fence 与终态 |
| 构建产物 | 为固定 Deployment 取得或验证原产物、查询构建观察 | 当前认证、远端 run 接管/取消、三种产物状态、Registry 核验与日志保留 |
| 隔离 Builder | 幂等接收 run、提供观察/事件、续租/接管、接收阶段凭证、取消 | 独立 Linux 上真实 git、rootless BuildKit、OCI uploader、进程与资源控制、持久 ledger |

GitHub 是外部 Seam，提供生产 HTTP Adapter 和受控 HTTP 协议测试 Adapter；Builder 是自有远端 Seam，提供生产 HTTPS Adapter 和可控故障 Adapter。本地端到端仍使用真正的 Builder 进程和工具。领域规则不复制到测试替身，不能以空 `build()` / `push()` Interface 代替真实执行。

**身份与凭证分开更新。** SSH/Kubernetes/Git/Registry/Builder 的维护认证在每次实际使用前读取当前有效版本并审计；它们不是构建或发布的内容输入。PAT、push/pull 密码、Builder mTLS 证书可轮换，来源快照不得带入旧管理密文。相反，Git repositoryId、固定 commit、来源 revision、产物 digest、目标 Cluster/Namespace、PVC/数据库身份不可被普通更新改成另一对象。

| 允许的更新 | 必须保持或重新验证的身份 |
| --- | --- |
| 替换 Git PAT | 同一 GitHub 账号/连接，重新验证所需仓库权限；失去权限明确失败，不换仓库 |
| GitHub 仓库改名 | 重新查询并核对同一个数字 repositoryId；历史 fullName 保留为显示证据，执行使用经验证的当前名称 |
| 替换 Registry push / pull 凭证 | 原 authority 与允许的 namespace/repository 范围不变；分别重验权限 |
| 更新 Builder 地址或 mTLS 认证 | 核对原 instanceId 与固定的身份签名公钥；不同实例新登记，不把旧 run 改投新机 |
| 修改 Git 构建配置 | 创建新的不可变 GitSourceRevision，并 CAS 更新当前指针；旧 Deployment/Target 保留原 revision |
| 更新运行秘密或显式 build secret 内容 | 新秘密引用/内容版本；已受理快照固定旧版本并由 FK 保留，不能冒充维护认证轮换 |

数据库初始化密码、主版本、数据目录和 PVC 身份继续遵守 S5 保护。Git 普通应用可以使用已批准的卷与数据库绑定，但不能用 Git 来源绕过数据库模板保护。

**共享类型草案。** 以下名称作为 A/B/C 的首批交接；运行时验证、SQL 约束和 DTO 必须与类型同时落地。`UUID`、`IsoDate`、Git SHA 和 digest 仍需验证；JSON 中的大序号用十进制字符串，避免 JavaScript 精度损失。类型使用既有 Service/Workload/Storage/Database 类型，Console 只使用生成客户端。

```ts
type UUID = string;
type IsoDate = string;
type GitCommitSha = string; // 完整 40 位小写十六进制；不接受短 SHA 或 ref。
type Sha256Hex = string; // 64 位小写十六进制。
type OciDigest = `sha256:${string}`;
type Sequence = string; // PostgreSQL bigint 的十进制表示。

// ServiceConfiguration 和 ServiceConfigurationInput 保留原镜像语义。
type RuntimeConfiguration = Omit<ServiceConfiguration, 'image'>;
type RuntimeConfigurationInput =
  Partial<Omit<RuntimeConfiguration, 'environment'>> & {
    environment?: ServiceVariableInput[];
  };

interface FixedBuildSecret {
  mountId: string; // Dockerfile RUN --mount=type=secret,id=... 的受限 ID。
  secretRefId: UUID;
  secretKey: string;
  contentRevision: number;
}

interface GitRepositoryIdentity {
  repositoryId: UUID; // 平台 GitRepository ID。
  githubRepositoryId: string; // GitHub 数字 ID 的十进制字符串。
  fullNameAtCapture: string; // owner/name；显示证据，不是唯一身份。
}

interface FixedBuilderProfile {
  builderId: UUID;
  instanceId: UUID;
  profileRevision: number;
  buildkitVersion: string;
  frontendDigest: OciDigest;
}

interface FixedRegistryDestination {
  registryConnectionId: UUID;
  authority: string;
  repository: string;
  // 无 push/pull secret ID；按固定连接读取当前维护认证。
}

interface GitSourceRevision {
  version: 1;
  id: UUID;
  sourceId: UUID;
  revision: number;
  provider: 'github';
  githubConnectionId: UUID;
  repository: GitRepositoryIdentity;
  branchRef: `refs/heads/${string}`;
  dockerfilePath: string; // 相对 checkout 根目录的 POSIX 路径。
  contextPath: string; // '.' 或仓库内目录。
  buildArgs: Record<string, string>; // 仅显式非敏感值，有数量/字节上限。
  buildSecrets: FixedBuildSecret[];
  platforms: ImagePlatform[]; // 明确固定，不在重试时改成当前节点架构。
  builder: FixedBuilderProfile;
  destination: FixedRegistryDestination;
  recipeHash: Sha256Hex;
  createdAt: IsoDate;
}

interface GitSourceSnapshot {
  kind: 'github';
  revision: GitSourceRevision; // 保存不可变副本，同时保留 revision FK。
  commitSha: GitCommitSha;
}

interface ServiceSnapshotV3 {
  version: 3;
  serviceId: UUID;
  serviceName: string;
  serviceSlug: string;
  configRevision: number;
  configuration: RuntimeConfiguration; // 无 image，不回填占位镜像。
  source: GitSourceSnapshot;
  deployAndStart: boolean;
  allowConfigurationRepair: boolean;
  controller: WorkloadControllerConfiguration; // S6 Git 仅 application/Deployment。
  volumes: VolumeSnapshotReference[];
  database: null;
  databaseBindings: DatabaseBindingSnapshot[];
  template: null;
}

type ServiceSnapshot = ServiceSnapshotV1 | ServiceSnapshotV2 | ServiceSnapshotV3;

type GitCommitSelection =
  | { kind: 'reviewed_commit'; sourceRevisionId: UUID; commitSha: GitCommitSha }
  | { kind: 'pending_target'; webhookTargetId: UUID; sourceRevisionId: UUID;
      commitSha: GitCommitSha };

type ServiceSourceView =
  | { kind: 'image' }
  | { kind: 'github'; sourceId: UUID; currentRevision: GitSourceRevision;
      autoDeploy: boolean; policyRevision: number };
```

`autoDeploy` 是 GitSource 的触发策略，单独用 policyRevision/CAS 修改；它不改变已经受理的构建输入。Service.revision 对所有普通编辑做 CAS；configRevision 继续描述运行配置，来源版本单独比较。`hasUnpublishedChanges` 同时比较运行 configRevision 与已发布 sourceRevisionId。Git 的配置 DTO 不允许 `image`，image DTO 仍要求它；OpenAPI 用明确的来源判别表达，不能把所有字段变成可空来绕过验证。

V1/V2 历史 JSON 原样读取，不升级字节、不补当前草稿默认值。新增兼容 helper 集中取得运行配置、controller、卷和绑定；所有 `snapshot.version === 2` 的调用方均检查 V3。`DeploymentResult.version` 扩展为 `1 | 2 | 3`，仍只在资源完整应用后保存 published/image/appliedAt。解析出产物后，在内存合成 `{ ...snapshot.configuration, image: artifact.image.deployReference }` 给既有 Workload Implementation。

```ts
type DeploymentKind = 'image_deploy' | 'git_deploy';

type DeploymentInitiator =
  | { kind: 'admin'; adminId: UUID; requestId?: string }
  | { kind: 'webhook'; webhookDeliveryId: UUID; webhookTargetId: UUID };

interface WebhookTarget {
  id: UUID;
  webhookDeliveryId: UUID;
  serviceId: UUID; // 固定原服务身份；唯一键使用此字段，不因删除置空。
  currentServiceId: UUID | null; // 单独的 Service FK，ON DELETE SET NULL。
  sourceRevisionId: UUID;
  commitSha: GitCommitSha;
  configRevisionAtReceipt: number;
  policyRevisionAtReceipt: number;
  target: ServiceTarget; // 当时的 Project/Environment/Cluster/Namespace 身份。
  receiptSequence: Sequence;
  manualRequired: boolean; // 只允许 false -> true；resume 不清除。
  disposition:
    | { state: 'waiting'; reason: 'ready' | 'service_busy' | 'queue_capacity' }
    | { state: 'pending'; reason: 'service_stopped' | 'configuration_changed'
        | 'source_changed' | 'policy_changed' | 'publication_confirmation_required' }
    | { state: 'ignored'; reason: 'auto_deploy_disabled' | 'branch_mismatch'
        | 'unsupported_event' | 'branch_deleted' }
    | { state: 'orphaned'; reason: 'service_deleted' | 'target_changed' }
    | { state: 'enqueued'; deploymentId: UUID; admittedAt: IsoDate };
  createdAt: IsoDate;
}

interface DeployGitRequest {
  revision: number; // Service CAS。
  source: GitCommitSelection;
  deployAndStart?: boolean;
  allowConfigurationRepair?: boolean;
}

interface GitPublicationPreview {
  serviceRevision: number;
  configRevision: number;
  source: GitSourceSnapshot;
  target: ServiceTarget;
  configuration: RuntimeConfiguration;
  desiredState: 'running' | 'stopped';
  issues: Array<{ code: string; field?: string; message: string }>;
  checkedAt: IsoDate;
}
```

GitHub HEAD 仅在预览阶段解析为完整 SHA；部署提交所审阅的 SHA 与 revision，受理及执行不能再切换 HEAD。构建检出用完整 commit 验证，tree SHA 可作为执行证据记录，不依赖 push payload 的不完整 commits/diff 列表。手工指定的 commit 也必须属于获授权仓库，不能把任意 clone URL 当输入。

**新增实体与加法迁移。** Prisma 只新增 S6 表/字段/关系；不得改动已应用的 `202610260003_s5_storage/migration.sql` 或其他历史 migration。新 migration 名在开工时按实际序号确定。

| 实体/变更 | 字段与数据库约束 |
| --- | --- |
| GitHubConnection / GitRepository | 当前 PAT FK、验证元数据；connectionId + githubRepositoryId 唯一；Webhook 注册 ID、当前/候选验签 secret FK、验证状态 |
| GitSource / GitSourceRevision | 一个活动 Service 对应一个来源；当前 revision 指针、触发策略；sourceId + revision 唯一；revision JSON/hash 不可原地修改 |
| GitSourceSecretReference | sourceRevisionId + mountId 唯一；secretRefId FK RESTRICT、secretKey、固定 contentRevision；快照与关联同事务写入 |
| Service.sourceKind | 默认 image；github 必须有合法 GitSource，不能与 DatabaseInstance 并存；原模板继续是 image 来源 |
| RegistryConnection | 固定 authority/namespace 身份；独立 push/pull FK、revision、分别验证的结果/时间；两种用途不得引用同一凭证 |
| Builder | instanceId、身份签名公钥、连接/当前 mTLS FK、profile、能力、资源/缓存策略和观察；使用中的实例身份不能原地替换 |
| WebhookDelivery | provider + externalDeliveryId 唯一；payloadHash、event、repo/ref/after、重复次数、接收/处理状态；禁止未验签请求占唯一 ID |
| WebhookTarget | deliveryId + 固定 serviceId 唯一；当前 Service FK 可空；固定目标/来源/commit、序号、状态、manualRequired、Deployment 关联 |
| BuildRun | deploymentId + runNumber 唯一；远端 runId、specHash、epoch、发送意图、当前阶段、结束证明、产物关联；同 Deployment 不得存在两个未确认结束的 run |
| BuildArtifact | 不可变来源/specHash、OCI descriptor/checksum/大小、位置、平台、Registry 记录；不可从已确定状态退回“无产物” |
| BuildLogChunk | runId + sequence 唯一；阶段/时间/脱敏内容、保留与截断元数据；独立 TTL/总量清理 |
| Deployment 扩展 | 来源 revision FK、源头产物/复用产物 FK、initiator 类型与身份；运行秘密/卷/数据库引用继续复用既有关系 |
| SecretKind | 保留 git/registry/generic，新增 webhook、builder，分别严格校验 HMAC secret 和 mTLS payload。generic 只可被显式选为 build secret，不自动借用运行/数据库秘密 |

数据库增加不可变 source/spec/artifact 保护，以及“可能执行的 run 未确认结束时，任务不得终态/放槽”的 deferred check。保留现有 ServiceMutation、VolumeMutation、Outbox 所有约束。Outbox 仍恰好关联一个 Deployment 或 Operation，WebhookTarget 是独立的持久收件待办，不增加第三种 Outbox owner。

source revision 和产物的历史引用用 FK 保留；Service 删除后，Target 保留原 serviceId/target，currentServiceId 置空并终止未受理投递。不能因 FK 置空丢失去重身份。升级测试验证旧快照、秘密、数据/网络关系不变；S6 写入后不宣称可以直接降级到旧 Worker。

**GitHub 认证和 Webhook 的具体实现。** PAT 使用选定仓库的 metadata/contents read；产品提供 Webhook 注册时另外要求该仓库 webhooks write。普通响应只给账号、授权仓库、检查时间和凭证引用，不能返回 token。生产 GitHub Adapter 实际实现仓库/分支分页、仓库身份和 commit/路径查询、Webhook 注册/查询，处理 401/403/404/429、超时、分页循环和响应上限。

测试允许在构造生产 HTTP Adapter 时注入受控 HTTPS origin/transport；产品请求不能修改 GitHub API 或 clone origin。测试仍经过相同的 HTTP 解析、错误分类和签名 Implementation，不通过“验签成功”开关。

当前 [AuthGuard](../apps/api/src/auth/auth.guard.ts) 的 `@Public` POST 仍验证 Origin。S6 新增仅供 Webhook 使用的认证 metadata/guard，免管理 session/Origin/CSRF，改为专用验签；其他匿名接口规则保持。改 [app.ts](../apps/api/src/app.ts) 获取解析前原始 Buffer，对 `X-Hub-Signature-256` 严格检查格式和长度，以 constant-time HMAC 比较后才解析 JSON。Webhook 设独立有界 body limit，拒绝未支持的 Content-Encoding，不放宽所有管理请求。

验签 secret 是独立随机秘密。轮换通过候选 secret、远端 hook 更新确认及有界过渡期完成，不能先删除唯一旧验签能力。无效签名写有界拒绝审计，不写权威 Delivery 唯一键；合法同 ID 同 hash 增加重复记录，同 ID 不同 hash 拒绝并审计。接收/查询均不记录完整敏感请求头或原始 body。

**从收件到发布的顺序。**

1. 验签后核对 event、稳定 repositoryId、完整 branch ref、after SHA；tag/删除分支/非目标分支/未启用自动发布分别说明原因。
2. 同事务写 Delivery 和当时匹配的全部 Target，按稳定服务 ID 顺序锁定相关服务。正常 Target 不预占 ServiceMutation；每个 Target 独立保存来源版本、commit、固定目标及当时 config/policy revision。
3. 收件时 stopped，或调度前发现 stopped，设置 `manualRequired=true`、pending。已停止后收到的记录，在 resume 后仍保持 pending。resume 只用原完整发布快照，不能调用构建或消费待办。
4. 独立 dispatcher 按服务的 receiptSequence FIFO 选择 waiting Target。受理事务再次锁 Service，检查固定目标、revision、策略和活动槽；忙碌/容量不足继续等待，配置/来源/策略变化转 pending，需要审阅，不悄悄用新草稿。
5. 进入 TaskRepository 的同一事务写 Deployment、快照/引用、ServiceMutation、Outbox 和 Target→Deployment 关联。Webhook 的稳定幂等作用域来自 targetId；createdById 为 null，审计使用 Webhook initiator，不伪造 Admin。
6. 手工发布 pending 使用 Admin initiator，但原子认领同一个 Target。可明确审阅原来源版本与当前运行配置；固定目标或仓库授权失效时拒绝。stopped 必须 deployAndStart；部分/未知配置仍要求原有完整修复确认。
7. Target 受理后保留任务链接；运行、失败、成功来自对应 Deployment，不复制一套可能失真的结果状态。publishedAt 只能来自完整应用回执，不能在排队或推送完成时填写。

暂不合并不同合法事件，不以相同 commit 擅自吞掉独立投递。多服务事件分别追踪，某个服务失败不回滚其他服务的记录。无效签名返回 401，合法接收 202，重复接收 200；数据库/恢复只读不可写返回 503，要求提供方重投/人工 redeliver。GitHub 的 2xx 只代表已持久接收。

dispatcher 不依赖 Redis 在线才保存/受理；真正受理的 Deployment 由既有 Outbox 补投 BullMQ。容量不足时保留 Target，不循环创建失败任务。接口区分等待服务、待审阅、已受理但 Redis 断开等原因。恢复只读继续走 `assertWritable`，不得为了收 Webhook 绕过恢复锁。

**构建请求、epoch 与可信结束证明。** spec 采用版本化 canonical JSON 算 sha256，禁止把维护凭证加入 specHash。BuildRun 必须先写“可能发送”的持久意图，再发远端 PUT；不能用缺少响应判断未执行。

```ts
interface RunEpoch {
  generation: number; // ControlPlaneState generation。
  ownershipEpoch: number; // 此 run 每次接管单调递增，事务内分配。
}

interface BuildLimits {
  cpuMillis: number;
  memoryMiB: number;
  pids: number;
  diskBytes: string;
  timeoutSeconds: number;
}

interface BuildRunSpecBase {
  version: 1;
  installationId: UUID;
  runId: UUID;
  deploymentId: UUID;
  source: GitSourceSnapshot;
  builder: FixedBuilderProfile;
  destination: FixedRegistryDestination;
  limits: BuildLimits;
  deadlineAt: IsoDate; // 接管不得延长已接受的绝对执行期限。
}

type BuildRunSpec = BuildRunSpecBase & (
  | { action: 'build_and_push' }
  | { action: 'push_existing'; artifact: OciArtifact }
);

type BuildPhase = 'checkout' | 'building' | 'exporting' | 'pushing';
type EndDisposition =
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; phase: BuildPhase; code: string; exitCode: number | null }
  | { outcome: 'cancelled' }
  | { outcome: 'timed_out'; phase: BuildPhase };

interface BuildEndProofPayload {
  version: 1;
  installationId: UUID;
  builderInstanceId: UUID;
  runId: UUID;
  specHash: Sha256Hex;
  epoch: RunEpoch;
  ledgerRevision: Sequence;
  endedAt: IsoDate;
  disposition: EndDisposition;
  processes: {
    checkout: 'never_started' | 'terminated';
    solve: 'never_started' | 'terminated';
    uploader: 'never_started' | 'terminated';
  };
  executionClosed: true; // 同 run 永不重新启动任何执行阶段。
  cancelTombstone: boolean;
  terminationEvidence:
    | { kind: 'never_started' }
    | { kind: 'cgroup_empty'; executionGroupId: string; bootId: string }
    | { kind: 'host_rebooted'; executionBootId: string; observedBootId: string };
  artifactIdentityHash: Sha256Hex | null;
  pushReceipt: { destination: FixedRegistryDestination; rootDigest: OciDigest;
    confirmedAt: IsoDate } | null;
}

interface BuildEndProof {
  payload: BuildEndProofPayload;
  signature: { algorithm: 'Ed25519'; keyId: string; value: string };
}

interface BuildRun {
  id: UUID;
  deploymentId: UUID;
  runNumber: number;
  spec: BuildRunSpec;
  specHash: Sha256Hex;
  epoch: RunEpoch;
  submissionAttemptedAt: IsoDate | null;
  cancelRequestedAt: IsoDate | null;
  phase: BuildPhase;
  execution:
    | { state: 'prepared' }
    | { state: 'never_submitted'; closedAt: IsoDate; reason: 'cancelled_before_submission' }
    | { state: 'open'; remoteState: 'awaiting_credentials' | 'running' | 'cancelling' }
    | { state: 'ended'; proof: BuildEndProof };
  observation: {
    state: 'unobserved' | 'reachable' | 'unknown';
    lastObservedAt: IsoDate | null;
    lastErrorCode: string | null;
    ledgerRevision: Sequence | null;
  };
  artifact: ArtifactState;
}
```

结果与观察正交：Builder 失联写 observation.unknown，保留最后已知 execution；不能把 transport timeout 当成 `failed` 的进程结果。`ended` 只接受匹配实例、公钥签名、runId/specHash、有效 epoch 和不倒退 ledgerRevision 的证明。远端报告 PID 已退出还不够，须核对相应进程组/cgroup 无残余执行，或核对真实主机重启前后 boot ID，再持久写入 executionClosed。只读 GET 必须可重新取得同一终态证明。`never_submitted` 只能在 submissionAttemptedAt 仍为 null 的事务中产生，此后 SQL/发送路径禁止再设置发送意图。

远端按 installationId/runId 存持久 ledger、epoch 高水位和 cancel tombstone。同 ID/specHash 的 PUT 幂等返回原 run，不同 spec 冲突；较旧 epoch 拒绝续租、接管、凭证和取消变更。取消可先于 PUT 到达，先写墓碑，迟到 PUT 仍不启动。重启恢复 ledger 后先核对/清理残余执行，不能以空进程表或丢失临时目录假称成功。失去租约/超过绝对期限时由 Builder 自行终止整个执行组。

普通 Worker 接管不改变 spec、deadline 或产物；先读取远端 ledger，再分配可接受的新 epoch。旧控制面备份/旧 generation 不能覆盖远端高水位，恢复锁解除前必须对账，不自动重放。实例永久丢失且没有结束证据时，产品保留 unknown 和任务槽，不能凭“等待足够久”声明取消完成。

| Builder 路径（独立 HTTPS/mTLS，不是公开管理 API） | 行为 |
| --- | --- |
| `PUT /v1/runs/:runId` | `{ spec, specHash, epoch, leaseUntil }`；持久接收/幂等重放或接管，响应 run 观察 |
| `GET /v1/runs/:runId` | 读取 ledger、当前阶段/所需凭证、产物与最终证明；未知 ID 不等于旧 run 已结束 |
| `PUT /v1/runs/:runId/lease` | 有效 epoch 下续租，不能超过 spec.deadlineAt |
| `POST /v1/runs/:runId/credentials` | 有效 epoch、phase、nonce、到期时间和 write-only 阶段认证材料；内存/受保护临时材料，不写 ledger/log |
| `POST /v1/runs/:runId/cancel` | `{ specHash, epoch, reason }`；持久取消墓碑，返回 cancelling 或可信结束证明 |
| `GET /v1/runs/:runId/events?after=...` | 有界、有序、可重读的脱敏事件；显示截断/到期，不能无限积压 |

新增 `apps/builder` 实际运行 git、固定版本 rootless BuildKit/buildctl 和成熟 OCI uploader。checkout helper、solve、uploader 串行隔离：Git 认证只交受信 helper；显式 build secrets 经 BuildKit secret mount 进入 solve；push 认证只在 solve 已结束后交 uploader。runtime pull 认证只留给控制面 Registry 验证/Kubernetes 发布，不发送给 Builder。基础镜像认证如需支持，是另一个明确的只读身份，不能复用产物 push 凭证。

Builder 管理进程与源码执行采用不同 OS 权限域，mTLS/签名私钥、ledger 和 credential-grant 材料不对源码 UID 可读。工具通过 argv 启动，不把仓库输入拼接 shell。git 禁系统/用户配置、hooks、隐式凭证 helper、递归 submodule；不承诺未实现的 LFS/submodule 支持。Dockerfile/context 在实际 checkout 后用真实文件身份和路径校验，拒绝绝对路径、NUL、反斜线、`..` 和 symlink 越界。

固定 frontend，不接受任意 `#syntax` 提升权限；禁止 host network、security.insecure、关闭进程隔离。执行环境不挂 Docker/BuildKit 管理 socket、宿主根目录或 Oracle 凭证；出站策略阻止管理地址、metadata 和未授权内部目标。安装与预检需验证 rootless/cgroup/网络隔离能力，缺失则 Builder 不可用，不能静默降为 rootful。

**Task 收敛需要修改的路径。** 现有 `enqueueDeployment`、`DeploymentLease`、task view/claim、Runtime dispatch、DTO 多处写死 `image_deploy`，统一扩展明确的 `git_deploy`。现有 queued cancel、过期 lease recovery、attempts exhausted、old generation 终态也必须检查 BuildRun。

只要 submissionAttemptedAt 已设置而 execution 尚未可信结束，`complete/fail/endUnclaimed/recoverTask/rejectOldGeneration/releaseMutationSlot` 都不能将任务终态或放槽。BuildReconciler 用独立有界观察/对账租约查询远端，保存真实结果后才允许 Task 收敛。增加 SQL deferred check 防止漏改某个代码入口。取消期间允许保存同任务的结束证明，即使普通工作 checkpoint 已因 cancelRequestedAt 禁止副作用。

未发送过远端请求的 prepared run 可在事务内标记未执行后取消；已发送但响应丢失则必须查相同 run。Builder 端失败/超时只有确认进程结束后才可失败；连接异常只表示 unknown。自动重试仍受原 Task maxAttempts/退避控制，每次实际新 run 前都要证明前一个已结束。原 ServiceMutation 与相关 VolumeMutation 在整个构建/发布过程中保留，resume 不执行 Git 构建。

**产物与复用形状。**

```ts
interface OciArtifact {
  id: UUID;
  producedByRunId: UUID;
  sourceRevisionId: UUID;
  commitSha: GitCommitSha;
  recipeHash: Sha256Hex;
  rootDigest: OciDigest;
  rootMediaType: RegistryMediaType;
  platforms: ResolvedImagePlatform[];
  archive: {
    builderId: UUID;
    builderInstanceId: UUID;
    handle: string; // 仅 Builder 解释，不是任意文件路径/URL。
    sha256: Sha256Hex;
    bytes: string;
    expiresAt: IsoDate;
  };
  producedAt: IsoDate;
}

type ArtifactState =
  | { state: 'none' }
  | { state: 'oci'; artifact: OciArtifact;
      availability: 'unknown' | 'available' | 'missing' | 'expired' }
  | { state: 'registry'; artifact: OciArtifact;
      destination: FixedRegistryDestination; image: ResolvedImage | null;
      pushedAt: IsoDate; lastVerifiedAt: IsoDate | null;
      availability: 'unknown' | 'available' | 'missing' };
```

| 原任务产物状态 | 重试规则 |
| --- | --- |
| none | 先查询旧远端 run，排除已完成但响应丢失；确无产物且旧 run 已结束，才按原 commit/recipe/平台/固定 build-secret 版本构建 |
| oci | 校验原 handle/归档 checksum 和 OCI descriptor，以当前 push 认证推送原 digest；缺失/到期明确 `BUILD_ARTIFACT_MISSING`，不重建 |
| registry | 用固定 Registry 连接当前 pull 认证调用现有 Registry.verify；若尚无 image 元数据则 resolve 原 digest，不能解析 tag。缺失明确失败，不静默从缓存重推 |

OCI 生成即持久登记，不能等 push 成功才承认有产物。上传使用真实、固定版本工具，例如 `skopeo copy --preserve-digests`；上传标签只用于回执找回，发布永远用 digest。推送响应丢失时查询同一目标 digest 或重复上传相同归档，不执行新 build。一旦取得可信 pushReceipt，先记录 registry 状态，即使控制面后续验证失败也不退回 oci；image 为 null 表示尚待独立核验。控制面用 Registry Adapter 重新核对 root manifest、平台实际 config 与目标节点架构，得到非空 image 后才进入原存储准备、apply、waiting_healthy。新节点架构不满足既有固定产物时明确失败，不借重试重建另一平台。

缓存与原产物分开保留。缓存按服务/仓库/配方/平台/工具版本隔离，build-secret 的内容版本变化影响缓存命名空间，防止 BuildKit 默认 secret 不参与 cache key 而沿用旧输出。Builder 及 run 均执行 CPU/内存/PID/磁盘/超时上限和有限并发；GC 只回收自己的非活动缓存，不能全局 prune 或删受引用产物。产物保留期限与到期状态可见，不把已删除产物重新标为 none。

构建输出独立持久化，初始限制为每 chunk 8 KiB、每 run 8 MiB、14 天，并设置安装级总量上限。分页响应设条数和字节上限；先跨 chunk 脱敏、过滤控制字符再写数据库。沿用现有 LogRedactor 的处理方式，保留截断/到期事件。现有 tasks/logs.ts 的 64 条/16 KiB 继续用于平台阶段事件，不能承载原始 BuildKit 输出。

**公开 API 路径。** 下表是实施目标，不是已存在的接口。统一 `/api` 前缀、DTO/OpenAPI、Problem Details、cursor 分页、revision/CAS；管理写入沿用 CSRF，幂等操作要求 Idempotency-Key。验证接口有界执行只读协议检查，长时间验证/远端 hook 安装返回持久 Operation，不在 API 等待 rollout/build。

| 路径 | 输入/结果与所有者 |
| --- | --- |
| `GET/POST /integrations/github`；`GET/PATCH /integrations/github/:id` | PAT 引用、稳定账号、脱敏授权状态；A |
| `POST /integrations/github/:id/verify` | 检查当前认证/权限，分别记录时间和失败原因；A |
| `GET /integrations/github/:id/repositories` | 仅授权仓库，cursor 分页；A |
| `GET /integrations/github/:id/repositories/:repositoryId/branches` | 已登记仓库的授权分支分页；A |
| `POST /integrations/github/:id/repositories/:repositoryId/webhook` | 明确注册/更新平台所拥有的 hook，保存 hook ID；不能修改任意既存 hook；A |
| `GET/POST /integrations/registries`；`GET/PATCH /integrations/registries/:id` | 固定 Registry 身份和独立 push/pull 引用；A |
| `POST /integrations/registries/:id/verify` | 区分 pull 验证和显式 push 探针；探针限定平台自己的 repository/tag，返回各自事实；A/B |
| `GET/POST /integrations/builders`；`GET/PATCH /integrations/builders/:id` | 固定 Builder 身份、当前 mTLS 引用、能力/profile/观察；A |
| `POST /integrations/builders/:id/verify` | 校验身份及隔离/架构/配额能力，不以 HTTP 200 冒充构建成功；A/B |
| `POST /services` | 增加明确 Git 来源输入 + RuntimeConfigurationInput，保留旧 image/template 输入；仅保存草稿；A |
| `GET/PUT /services/:id/git-source` | 读取/保存新的不可变来源 revision，返回 Service/Source CAS；A |
| `PATCH /services/:id/git-source/policy` | 修改 autoDeploy，携带 Service/policy revision；A |
| `POST /services/:id/git-source/preview` | 返回 GitPublicationPreview，显示完整 commit、来源、运行配置和继承目标；A |
| `POST /services/:id/deployments` | 保留现有发布路径，接受 image 输入或 DeployGitRequest；统一持久 Deployment；A/B |
| `GET /services/:id/pending-commits` | Target 分页、commit、来源、原因、可执行动作/阻止原因；A |
| `POST /webhooks/github/:repositoryId/:callbackId` | 唯一独立验签接收路径；不能把 path ID 当认证；A |
| `GET /webhook-deliveries`；`GET /webhook-deliveries/:id` | 接收结果及每服务 Target；A |
| `GET /webhook-rejections` | 有界拒绝审计，不返回原始秘密/请求体；A |
| `GET /deployments/:id` | 增加 source、BuildRun/Artifact 摘要、复用来源；A/B |
| `GET /deployments/:id/build-logs` | run/attempt + cursor、有界输出、available/truncated/retention 状态；A/B |
| `POST /deployments/:id/retry`；`POST /deployments/:id/cancel` | 保留原目标/来源/产物；取消可能长时间等待结束证明；A/B |

GitHub hook 注册和 Registry push 探针属于明确的外部写操作，UI 动作与幂等审计必须说明实际行为。不能在“保存 PAT/连接配置”时隐式修改仓库。新增 Operation 种类须显式定义，不能借 diagnostic 执行远端副作用。

**Console 交付。** G04 分别显示 GitHub、Registry push/pull、Builder 的配置、检查时间和失败；B03 只列授权仓库/分支，保存来源后接现有运行配置与 C03 发布审阅。ServicePage 展示来源、运行草稿、已发布 commit/digest、pending；并列“恢复原已发布版本”和“审阅所选提交”。DeploymentPage/F01/F06 按来源显示构建、推送、发布、健康阶段及各自日志；F04 保留停止期记录和明确启动动作。复用 S4 域名独立观察，不以 push 成功代表应用可访问。

ServiceCreatePage 增加 Git 路由分支；ConfigurationReview 增加 commit/sourceRevision/产物复用差异；现有运行资源、变量、端口/探针、卷与数据库绑定继续复用。删除写死的“镜像发布/构建不适用”仅限 Git 展示分支，image 路径仍不显示假构建。新 query keys、仓库/分支切换清理、未保存保护、离页取消与迟到响应按现有模式实现。所有状态取正式 API，受控 UI fixture 只进入测试。

**真实验收及证据分层。**

| 关口 | 通过条件 | 不能替代的部分 |
| --- | --- | --- |
| 数据/协议/故障测试 | 空库和 S5 升级；真实 PG/Redis 事务/并发/Outbox；生产 GitHub HTTP 解析与受控服务；Builder 协议与取消/接管故障 | 不证明公网 GitHub、真实源码构建或 K3s 运行 |
| 本地真实构建交付 | 本地 bare Git 的真实 commit/fetch → 独立 Linux 的真实 rootless BuildKit → 真实 OCI Registry → 已登记 K3s → S4 本地 TLS 页面对应 commit | 本地 GitHub 协议端点/签名投递明确标为受控；本地 CA 不冒充公网证书 |
| GitHub 公网 | 真实授权仓库实际 push → GitHub 自身投递到公网 Webhook → 独立 Builder → 目标集群拉取 Registry digest → 健康与 HTTPS 页面 | 完成这一关后才可记 S6.08 和 S6 真正通过 |

本地 Builder 使用专用 Linux 实例，不能把 [C 上的 rootful Docker 产品打包 fixture](../infra/local-lab/linux-build-c.py) 当用户源码 Builder。开工后先核对宿主资源，与 S5 打包/性能采样错开。现有 B Registry 的 Basic/htpasswd 验证也不能证明权限分离：S6 配置真实 repository scope token issuer 或具备 ACL 的 Registry，验证 runtime pull 身份实际无法 push。安装资产应固定版本/来源/SHA256，产物与日志使用本项目独立保留目录。

最小故障矩阵：原始 JSON 字节变化/伪造签名不占 deliveryId；重复和多服务投递；非目标分支；stopped 收件无 BuildRun；resume 保持原 digest；显式 pending 发布；等待期间来源/运行配置变化；Git/Registry/Builder 维护认证轮换；非法路径/未授权仓库；构建非零退出；push 失败后复用 OCI；已推送 digest 删除；取消早于 start；启动/推送响应丢失；Worker/Builder 重启；失联不放槽；OOM/超时/磁盘/日志上限；源码无法读取管理认证或 socket。再回归 S3–S5 的镜像发布、数据引用、停止恢复、删除留卷与域名入口。

**实施顺序与文件所有权。**

| 顺序 | 具体交接 | 退出条件 |
| --- | --- | --- |
| 0 | 根代理冻结 S5，保存 migration checksum 和验收基线；A/B/C 确认本文共享形状 | 根代理明确开工；没有 S5 并发改动冲突 |
| 1 | A 提交 schema/新增 migration 草案、Git/V3/initiator/DTO；B 交 BuildRun/Artifact/proof 和 Task 扩展具体签名 | 类型、SQL 不变量、请求/结果字段一致；不留空执行方法 |
| 2 | A 实现真实 PAT/来源/Webhook/dispatcher；B 实现实际 Builder、产物复用和 Task 结束 gate；C 对正式生成客户端实现 UI | 各自跨 Module Interface 的集成测试通过 |
| 3 | A/B 合并统一发布，C 完成停止/pending/重试/取消完整流程 | S3–S5 回归和 S6 受控故障矩阵通过 |
| 4 | B 建立隔离本地构建链路，A 验证 API/持久结果，C 跑真实浏览器流程 | commit/产物/Pod/HTTPS 证据一致；本地来源明确标记 |
| 5 | 根代理安排真正 GitHub 公网关口和联合验收 | S6.08、验收文档和剩余限制如实记录 |

| 所有者 | 独占文件 | 给其他人的交接 |
| --- | --- | --- |
| A：schema/来源/Webhook/API | `packages/database/prisma/schema.prisma`、仅新增 S6 migration；新增 `packages/control-plane/src/git/**`、集成配置 Module；新增 `packages/infrastructure/src/github/**`；`services/{contracts,commands,persistence,validation,snapshots,views,index}.ts`；全部 S6 `apps/api/src/modules/**` DTO/controller/service、`app.ts`、认证 metadata/guard；OpenAPI/生成客户端；公共 package manifests/lock；来源/Webhook 测试 | 首先冻结 V3/来源/Target/initiator/公开 DTO；A 不修改 B 的 Task/Executor 文件，向 B 提供受理 callback 需要的形状 |
| B：Builder/执行可靠性 | 新增 `apps/builder/**`、`packages/infrastructure/src/build/**`、`packages/control-plane/src/builds/**`；`tasks/**`；`services/{executor,observer}.ts`；`apps/worker/src/main.ts`；构建配置/纯日志工具；Builder 资产锁/安装与生命周期 fixture、S6 真实本地探针；Task/Builder 故障测试 | 提供有 Implementation 的 Task 受理/终态 gate、构建产物 Interface；向 A 交 schema/DTO 所需字段，不直接改 schema/API |
| C：Console | S6 涉及的 `apps/console/src/**` 页面/面板、路由、query keys/类型；`apps/console/tests/**` 受控和真实 S6 流程；Stitch 对照与浏览器证据 | 只从生成客户端取契约；API 缺失交 A，不自行读 Prisma 或补假状态 |
| 根代理 | S5 冻结/开工、A/B 共享契约整合、真实环境编排、最终验收与 `docs/acceptance/S6.md` | 公共 manifest/lock 变更由 A 统一落盘；跨所有权修改先交对应所有者 |

实施时重点复用 [ServiceCommands](../packages/control-plane/src/services/commands.ts)、[ServiceExecutor](../packages/control-plane/src/services/executor.ts)、[TaskRepository](../packages/control-plane/src/tasks/repository.ts)、[TaskRuntime](../packages/control-plane/src/tasks/runtime.ts)、[Registry Adapter](../packages/infrastructure/src/registry/adapter.ts) 和现有 Service/Storage/Database 引用。不得另造 Git 部署引擎；不得先放松 S5 不变量再补测试。文档中的代码是待落地的共同契约，全部实际行为仍须以实现和对应层级的验证为准。
