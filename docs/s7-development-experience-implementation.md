# S7 开发体验实施方案（提案）

日期：2026-10-26。状态：**仅方案提案，S7 尚未实施、尚未验收**。本文确定拟采用的契约、复用边界、分工和验收路径；类型、接口、表及数值上限中标为“拟”的内容均不是现有产品能力。本次只新增本文，不修改源码、schema、迁移、环境文件或公共运行面。

依据：[PRD v1.5](prd.md) §4.3–4.4、F26–F32、F37/F39 及 UX01–UX08；[开发计划](development-plan.md) S7.01–S7.10、E21/E22/E28/E29；[技术方案](technical-plan.md)；[UI 覆盖清单](ui-coverage-inventory.md)；[Stitch 映射](../designs/console-v2/stitch-screen-map.md)与[需求矩阵](../designs/console-v2/coverage-matrix.md)。S5/S6 的实际基础分别见[存储方案](s5-storage-implementation.md)和[Git 构建方案](s6-git-build-implementation.md)。

S7 的实施入口仍是 **G-MVP 通过**。S6 正在验收，本文不代表 S6 或 G-MVP 已通过，也不把已有设计页面计为产品实现。已应用的 `202610260004_s6_git_build/migration.sql` 保持冻结，S7 只能新增迁移。

## 1. 范围、任务与固定业务规则

S7 关闭 F26–F32，交付 F37 的有界日志过滤/下载和 F39 的显式声明配置导入部分。F37 的集中保留、Loki/外部历史检索以及 F39/F40 的项目导出、复制、跨目标身份重映射属于 S8；容器文件浏览/上传与主机 Web SSH 分别属于 F43/F44。S7 的配置文件指声明式容器挂载，不是宿主机文件编辑。

| 任务  | 拟交付的完整路径                                                                        | PRD / Stitch                           | 依赖与主责                                       |
| ----- | --------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| S7.01 | 通用变量与稳定输出引用、依赖图、敏感传播、构建/运行阶段校验、消费者待发布提示与删除检查 | F26；C01/C04/B06                       | S3.02、S5.05、S6；A 领域/API，B 执行，C UI       |
| S7.02 | 文件内容/秘密引用、路径/权限、不可变版本、ConfigMap/Secret 挂载及卷冲突预览             | F27；C01/C03                           | S3.01、S5.01、S7.01；A 配置，B Workload，C UI    |
| S7.03 | 内置与自定义仓库的固定版本组合模板、资源预览、依赖排序、逐组件结果与局部重试            | F28；B06/C03/A03                       | S5.06、S7.01–02；A 编排/API，B 接入任务，C UI    |
| S7.04 | Monorepo root/context/Dockerfile/watch paths、共享文件触发与构建/启动配置               | F29；B03/B04/G04                       | S6.01–03；A 来源/事件契约，B Builder，C UI       |
| S7.05 | 版本化声明文件的显式解析、导入预览、来源/覆盖决策与 schema 迁移                         | F39 本阶段；C05/C03                    | S7.01、S7.04；A 配置/API，C UI                   |
| S7.06 | 固定成熟开源构建器、Node.js/静态站点识别、最终构建计划、Dockerfile 覆盖                 | F30；B04/G04                           | S6.04–06、S7.04–05；B Builder，A 契约，C UI      |
| S7.07 | 可信完整基准＋历史成功 digest 的差异预览、固定目标、新 Deployment 与回滚关联            | F31；F05/A05                           | S3.03–07、S5.04、S6.05；A 命令/API，B 发布，C UI |
| S7.08 | 指定服务/Pod UID/container 的一次性 argv 执行、stdout/stderr、可信退出结果与审计        | F32；F07                               | S3.08、S1.04；B transport，A 会话/API，C UI      |
| S7.09 | 实际交互 PTY、尺寸/心跳/关闭、新会话重连与并发限制                                      | F32；F07                               | S7.08；B transport，A 会话/API，C UI             |
| S7.10 | 连贯开发流程、有界日志过滤/下载、SSE 刷新、编辑器/终端懒加载与快捷键验收                | F37 本阶段、UX04/06/08；F06 及上述流程 | S7.01–09、S3.08；C UI，A/B 接口，root 集成验收   |

所有任务保留以下语义：

- 目标沿 `Cluster → Project → Environment → Service` 继承。模板、引用、声明文件、回滚和终端均不能另选服务目标；同一项目的不同环境也不自动共享依赖。
- 保存仅更新草稿。发布创建不可变 Deployment；失败重试创建 `retryOfId` 新记录，使用原固定输入与已知产物。重启/恢复使用当前完整已发布快照，不能替换为最近成功记录、当前草稿或待发布提交。
- stopped 服务的合法 Git 事件仍只记录待发布；恢复原版本。手工发布与回滚须带明确的 `deployAndStart`，组合模板也不隐式启动既有 stopped 组件。
- 运行变量、配置文件及显式 build secret 固定内容版本；SSH/Kubernetes/Git/Registry/Builder 的维护认证取当前有效版本并审计，固定资源身份不随凭证更新而改变。
- 部分应用、漂移、失联或未知不是完整配置。停止仍可请求；重启/恢复需要可信完整基准；回滚先对账。禁止从不同 Pod、最近成功记录和当前草稿拼装基准。
- 数据库初始化密码、引擎版本、数据目录和 PVC 保护覆盖普通保存、发布、重试与回滚。保留现有更严格的数据库版本/镜像约束，不借 S7 放宽为“只要主版本相同即可”。删除服务保留数据；局部失败不自动销毁 PVC。

## 2. 现有 Module 与拟扩展的 Interface

以下路径已存在；本节描述复用事实，后续各节才是 S7 提案。Module 以小 Interface 隐藏校验、版本固定及执行细节。Seam 只设在已有差异处：数据库/普通服务输出、Dockerfile/自动构建、Kubernetes 传输、配置文件导入/交互编辑；不新增平行的任务或发布引擎。

| 现有 Module / 位置                                                                                                                                                              | 已有 Interface 与实际能力                                                                               | S7 扩展点                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Services](../packages/control-plane/src/services/commands.ts)、[快照](../packages/control-plane/src/services/snapshots.ts)                                                     | `ServiceCommands.prepareDeployment`、保存/重试/动作；V1–V3 reader/helper；固定目标及数据库/卷校验       | 增加 V4 reader、配置解析入口、回滚候选生成；全部受理仍调用同一 `prepareDeployment`      |
| [Tasks](../packages/control-plane/src/tasks/repository.ts)                                                                                                                      | `enqueueDeployment/enqueue`、幂等、ServiceMutation/VolumeMutation、Outbox、租约、取消及 Build 结束门禁  | 组合模板只调度已有子任务；新任务种类扩展共用 registry，不复制消费者/重试循环            |
| [ServiceExecutor](../packages/control-plane/src/services/executor.ts)、[Workload](../packages/infrastructure/src/workload/contracts.ts)                                         | 统一应用/观察/部分失败、资源清单与所有权、Deployment/StatefulSet                                        | 将新文件和固定值编译入既有 apply plan，沿用写前意图、UID 回执、完整应用判定             |
| [Database bindings](../packages/control-plane/src/databases/persistence.ts)、[保护](../packages/control-plane/src/databases/protection.ts)                                      | 新鲜认证就绪、同项目/环境/集群、固定提供方 publication/Service UID/凭证版本；删除引用检查               | 提取可复用的数据库输出读取 Adapter；保留旧绑定、历史快照与严格身份校验                  |
| [Storage](../packages/control-plane/src/storage/validation.ts) / [persistence](../packages/control-plane/src/storage/persistence.ts)                                            | 绝对容器路径与覆盖检查、卷实际目标、可写占用及挂载快照                                                  | 同一位置合并文件/PVC/内部秘密文件的路径检查，不另建路径规则副本                         |
| [Templates](../packages/control-plane/src/templates/catalog.ts)                                                                                                                 | 固定内置目录、模板参数/预览；`ServiceCommands.create` 用 CommandReceipt 幂等创建单服务草稿              | 新增仓库与版本管理、组合计划；单组件继续使用原创建规则及数据保护                        |
| [Git](../packages/control-plane/src/git/commands.ts) / [webhooks](../packages/control-plane/src/git/webhooks.ts)                                                                | 固定提交预览、GitSourceRevision、两级事件去重、逐服务 Target、停止锁存                                  | 新增来源 V2、watch 决策证据与声明来源；原事件身份、目标和停止语义不变                   |
| [Builds](../packages/control-plane/src/builds/coordinator.ts)、[协议](../packages/infrastructure/src/build/contracts.ts)、[Builder](../apps/builder/src/manager.ts)             | 注册远端 run、固定配方、阶段凭证、产物/Registry 核验、结束证明与恢复                                    | 增加自动计划阶段及版本化能力协商；由同一 Builder 生命周期执行                           |
| [ServiceLogReader](../packages/control-plane/src/services/logs.ts)、[Kubernetes logs](../packages/infrastructure/src/kubernetes/logs.ts)                                        | 鉴权/归属/快照/当前凭证校验；每 API 进程每用户 4 连接、每次 60 秒/1 MiB；已知秘密脱敏，无原始文本持久化 | 同一路径加有界时间选择、过滤/下载；为终端复用访问检查，不复制一份长连接身份逻辑         |
| [Database Exec](../packages/infrastructure/src/kubernetes/database-exec.ts) / [AuthGuard](../apps/api/src/auth/auth.guard.ts) / [Audit](../packages/control-plane/src/audit.ts) | 固定数据库检查脚本及受限 TLS/WebSocket；Cookie 会话、Origin/CSRF、脱敏审计上下文                        | 从 transport 提取实际可变部分；数据库检查不直接开放为任意执行 API。新增容器会话产品契约 |

拟新增的领域目录为 `packages/control-plane/src/configuration/`、`references/`、`container-sessions/`，组合编排留在 `templates/`；Builder/自动计划留在 `builds/` 与现有独立 Builder。`configuration` 的 Interface 是 `validate/preview/capture`，输出固定的值、文件和引用证明；调用方不处理递归表达式、秘密传播或 K8s 文件布局。`references` 接受数据库/普通服务 `OutputProvider` Adapter，并集中承担依赖图与就绪证明。`container-sessions` 接受受限 Kubernetes Exec Adapter 与既有访问校验，业务调用方不直接管理 SDK socket。

这些 Interface 同时是测试入口：纯解析、真实 PostgreSQL 事务和可控传输故障分别验证相应行为；不为测试另写一套发布逻辑。通用 `Task`、`Workload`、`SecretCipher`、日志流和数据库保护保持单一 Implementation，以保证修改的 Locality。

## 3. 配置、快照与 API 契约

### 3.1 草稿、来源与受理

保留 `Service.revision` 的并发编辑 CAS 和 `configRevision` 的发布比较。任何变量绑定、文件当前版本、导入覆盖决策或输出定义变更与草稿在同一事务更新 `configRevision`；外部提供方输出变化单独标记 `dependencyChanges`，不伪装成用户编辑或直接改写运行值。

拟采用一个版本化配置输入 schema，将既有 `ServiceConfiguration/RuntimeConfiguration`、变量定义/绑定、配置文件版本选择和字段来源组合为明确的输入。普通 UI、模板参数和显式声明导入都调用同一 normalizer。旧 HTTP 形状经 Adapter 进入该 normalizer；未提供的新字段不能被旧客户端全量保存顺带清空，移除绑定/文件需要显式操作及 revision。

预览返回 `previewId`、目标、service/config/source/schema revision、选定 commit、逐字段来源、脱敏差异、依赖证明、问题代码/字段路径、`checkedAt/expiresAt`。提交在短事务内重新验证 revision/目标/依赖证据，并固定最终输入。预览不执行用户命令、不修改运行面；敏感值不出现在差异、错误或预览响应中。

### 3.2 V1–V3 保留，新增 V4

| 快照     | 现有语义                                                                     | S7 兼容规则                                                                      |
| -------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| V1       | `configuration` 含 image；默认 Deployment/RollingUpdate                      | 保留历史 JSON 字节；缺少的卷/绑定/文件按该版本语义读取为空，不补当前草稿默认值   |
| V2       | image＋controller、卷、数据库/绑定、模板                                     | 保留数据身份与原凭证；旧绑定经 Adapter 读取，不迁移成新 VariableBinding 后重解释 |
| V3       | runtime-only configuration＋固定 Git commit/source revision；无占位 image    | 保留 source revision V1 与原 recipeHash；只有验证产物后才内存合成 Workload image |
| V4（拟） | runtime-only configuration、来源、镜像选择、固定输出/文件/秘密版本与来源证据 | 新发布启用后写 V4；旧任务/旧发布的重试继续保留原版本；未知版本拒绝执行           |

拟议的关键形状如下，沿用现有 Target/Runtime/Storage/Database 类型，不展开重复定义：

```ts
type SecretVersion = {
  secretRefId: string;
  secretKey: string;
  contentRevision: number;
};

type FixedValue = { kind: 'literal'; value: string } | { kind: 'secret'; secret: SecretVersion };

type FixedOutputReference = {
  bindingId: string;
  consumerField: string;
  phase: 'build' | 'runtime';
  providerServiceId: string;
  outputKey: string;
  providerDeploymentId: string;
  providerServiceUid: string;
  providerTarget: ServiceTarget;
  outputVersion: string;
  sensitive: boolean;
  value: FixedValue; // 敏感结果只保存不可变秘密引用。
};

type ConfigFileSnapshot = {
  fileId: string;
  fileVersionId: string;
  path: string;
  mode: number;
  content: FixedValue;
  bytes: number;
};

type BuildInputSnapshot = {
  version: 1;
  buildArgs: Record<string, string>; // 只能含非敏感值。
  buildSecrets: FixedBuildSecret[];
  recipeHash: string; // 来源声明摘要＋本次固定输入/秘密版本的有效配方摘要。
};

type ServiceSnapshotV4 = {
  version: 4;
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  configRevision: number;
  configurationSchemaVersion: number;
  configuration: RuntimeConfiguration; // 环境值已固定为 literal 或现有 secretRef 形状。
  source:
    | { kind: 'image'; reference: string }
    | {
        kind: 'github';
        revision: GitSourceRevisionV1 | GitSourceRevisionV2;
        commitSha: string;
        buildInput: BuildInputSnapshot;
      };
  imageSelection:
    | { kind: 'source' }
    | {
        kind: 'historical';
        fromDeploymentId: string;
        baselineDeploymentId: string;
        image: ResolvedImage;
        registryIdentity: FixedRegistryIdentity;
      };
  controller: WorkloadControllerConfiguration;
  volumes: VolumeSnapshotReference[];
  database: DatabaseSnapshot | null;
  databaseBindings: DatabaseBindingSnapshot[]; // 保留 S5 语义。
  template: { id: string; version: string } | null;
  references: FixedOutputReference[];
  files: ConfigFileSnapshot[];
  outputs: PublishedOutputDefinition[]; // 本次固定的显式导出定义/值；不读取可变草稿。
  provenance: ConfigurationProvenance; // 非敏感字段来源/模板与导入版本。
  deployAndStart: boolean;
  allowConfigurationRepair: boolean;
};
```

`FixedRegistryIdentity` 固定 authority/repository、已有连接 ID 或可信基准对应的镜像访问身份，不含旧管理密文。`PublishedOutputDefinition` 固定输出键、类型/允许阶段、敏感性与 FixedValue；默认端点再结合该 publication 的受信资源证据产生。新类型仅为拟议契约；应通过 OpenAPI/客户端生成同步落地，不能仅增加 TypeScript union 而缺少运行时校验。

V4 的 `imageSelection` 是执行判别。正常 Git 走 Builder；回滚的历史 digest 直接验证 Registry 并发布，不因保留了基准 Git 来源信息而重新构建。UI 分别展示来源草稿、基准来源和实际镜像产物的历史来源，不能把旧镜像标成由基准的新 commit 构建。

V4 的合法组合仍由运行时 validator 限制：Git 仅用于普通 application/Deployment，不能因新增 union 就允许把已有数据库改成 Git 来源或改变 controller/数据身份。旧来源和旧 HTTP 客户端进入兼容 Adapter，不获得绕过这些保护的第二条入口。

兼容逻辑集中扩展 `readServiceSnapshot/snapshotRuntime/snapshotConfiguration/snapshotController/snapshotVolumes/snapshotDatabaseBindings`，另加文件、引用和镜像计划 helper。所有版本判断点（含 registry access、日志脱敏、结果版本、数据库校验、构建入口与重试）都经 helper 获取语义；不要在多处继续叠加 `version === 2/3`。`DeploymentResult` 相应支持 V4，但 `published/image/appliedAt` 仍仅在完整应用后形成；部分失败证据不冒充结果。

秘密拼接的展开结果只在内存出现。受理时为敏感派生值创建加密的不可变 SecretReference，保存输出来源与原秘密版本；快照只存派生引用，重试复用它。快照、DeploymentSecretReference、原始引用/文件版本 FK 及 Outbox 必须同事务写入。预览不提前持久化派生秘密。语义更新新建引用；主密钥重包不改变内容版本。摘要使用非敏感规范化值、版本 ID；禁止发布敏感内容的裸 SHA 摘要造成字典验证入口。

V4 发布使用的 runtime configuration 仍服从既有环境数量/展开后字节限制。文件正文存独立版本，不通过放大现有 24 KiB 普通配置上限容纳大文本。

### 3.3 拟议 API 增量

| Interface                                                               | 行为与并发约束                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 既有服务保存/发布、Git preview/deploy                                   | 委托同一配置 Module；新字段 CAS 保存，最终 Deployment 仍经 TaskRepository/prepareDeployment；Git 预览保留原固定提交语义 |
| `GET /services/:id/outputs`、`/dependencies`                            | 返回允许的稳定输出键、类型/阶段、脱敏版本、就绪/过期和消费者影响，不返回秘密值                                          |
| `POST /services/:id/configuration-preview`                              | 通用变量/文件/来源与卷冲突预览；Git preview 复用其领域函数，不重复解析                                                  |
| 文件/绑定草稿写接口                                                     | 带 serviceRevision 与文件/绑定 revision；由统一保存事务处理，不绕过数据库保护或 ServiceMutation                         |
| `POST /environments/:id/declaration-previews` 与 `/declaration-imports` | 显式解析/复核后按 previewId 原子更新所选草稿；幂等键＋expected revisions；导入不发布                                    |
| 模板仓库/版本读取、组合 `preview/instantiate`、实例 `publish/retry`     | 预览固定版本及 resource map；实例化只创建草稿；明确发布后启动依赖编排，逐组件返回 TaskRef                               |
| `POST /services/:id/rollback-previews` 与 `/rollbacks`                  | 固定历史成功记录、当前基准与 target；消费一次性预览、幂等创建新的 Deployment                                            |
| `POST /services/:id/container-sessions`、会话查询/关闭与专用流通道      | 明确 exec/pty、所选 Pod UID/container；受保护创建与单次绑定通道，不经自动重试 Outbox 重放命令                           |
| 既有日志读取＋有界下载接口                                              | 复用访问/秘密脱敏及上游限制；参数只能标识已验证资源，不能传服务器文件路径                                               |

创建/导入/发布类命令统一使用 Idempotency-Key 与请求摘要；重放相同键返回原资源/TaskRef，异内容冲突。DTO 必须验证判别联合和未知字段，并用真实 HTTP 回归覆盖可选字段的运行时形状。

## 4. S7.01：通用引用与依赖解析

### 4.1 值与输出

变量的阶段必须显式为 `build` 或 `runtime`。拟支持有限表达式：literal、现有 SecretReference、同阶段本地变量、`{ serviceId, outputKey }` 和有界 concat；使用结构化 AST，不使用 JavaScript、shell 替换或通用模板执行器。UI 可以提供可读语法，但保存的是稳定 ID/输出键，改名不会改绑定。

提供方输出包括受控的私有 Service 主机/具名端口、数据库连接字段，以及用户明确导出的配置变量。端点从已发布资源与所有权记录产生，不读取任意 Pod 环境、日志或容器命令输出来发现输出。普通服务须有新鲜且完整的发布/Ready 观察；数据库进一步复用 S5 的认证与数据身份检查。

每种输出声明 `valueType/sensitive/availablePhases`。DNS、数据库密码及运行变量导出默认仅 runtime；仅经显式声明允许 build 的值可进入构建输入。构建参数只能接收非敏感值；敏感构建值只能成为显式 secret mount，不能降级为 ARG、普通 env、命令文本或构建计划中的值。运行秘密、平台 Kube/SSH/Registry 维护认证不会自动注入 Builder。API 预览和 Worker/Builder 入场都检查阶段，不依赖 Console 隐藏字段。

秘密属性沿本地引用、跨服务引用、concat、URL 派生和配置文件传播，任一输入敏感则整个结果敏感。`secret=false` 不能解除间接敏感性。数据库 URL 继续在既有数据库运行适配中编码并固定凭证；一般 concat 不承诺自动进行 URL 转义。

现有 DatabaseBinding 继续有效，变量名不能同时由手工变量、旧数据库绑定和新通用绑定占用。新通用数据库输出调用同一就绪/凭证保护函数，并记录 DeploymentDatabaseReference，不能绕过数据库删除与维护门禁；旧快照和旧 bindingId 不重写。

### 4.2 图、固定与更新

1. 保存/预览校验缺失 ID/键、同项目/环境/集群、重复变量以及变量级和服务级依赖环。输出导出中的间接依赖也加入图，不能只检查相邻服务。错误返回可点击的字段路径与依赖链，值保持脱敏。
2. 普通手动发布要求提供方已经就绪；组合模板可以保存已知但未就绪的图，在编排层等待后再受理消费者 Deployment。不要用空值、同名替代服务或占位密码补齐。
3. 图变更、删除检查和引用受理在同一环境的短事务 fence 下进行（拟用 Environment reference revision/锁），再按统一顺序取得 Service、Volume、Database 等既有锁。旧数据库绑定入口也纳入该顺序；网络观察和等待不持锁。防止两次并发编辑各自无环、合并后成环，以及“检查无引用后恰好新增”的删除竞态。
4. 受理固定提供方 ID/输出键、publication、Service UID、输出内容版本及 target；非敏感值直接固定，敏感值固定 SecretReference。构建期解析结果写入 BuildInputSnapshot，其 recipeHash 包含实际非敏感输入与秘密版本，不能只沿用未解析声明的摘要。V1 来源的旧 recipeHash 算法保持不变。
5. 执行前重验归属、资源身份、引用可用性与必要的就绪证明。失败重试读取原解析结果，不重新读取“最新值”；身份/固定版本无法验证时明确失败并引导创建新预览。数据库绑定继续执行现有完整快照比较。
6. 提供方完整发布后的语义输出变化通知反向索引，标记消费者 `hasUnpublishedDependencyChanges` 并列出来源。只改变提供方显示名称或重包密文不算值变化；禁止轮询直接修改消费者 Secret、ConfigMap 或重启 Pod。消费者下一次明确发布才解析新版本。
7. 删除提供方检查期望草稿、当前完整已发布消费者和 queued/running 任务；消费者只从草稿移除但尚未发布仍阻止删除。仅历史终态引用可保留脱敏身份墓碑和原版本，不因此永远禁止服务删除；以后重试缺失提供方时明确失败，不绑定新同名服务。

拟初始上限：沿用每服务 128 个运行变量、展开后运行环境 32 KiB；每表达式 32 个节点、最大引用深度 16；每环境图 256 服务/2,048 条边。上限失败须定位字段，不能截断后继续发布。具体压力结果记入 S7 验收，调整上限要有版本与容量证据。

## 5. S7.02：配置文件与挂载

文件使用稳定 fileId 和追加式 ConfigFileVersion。草稿引用当前版本；Deployment 固定 fileVersionId、路径、权限、展开结果/秘密版本及来源。编辑旧内容生成新版本；删除草稿文件只影响下次明确发布。非敏感文件可读取原文；含敏感片段/引用的文件整体作为秘密，只返回元数据与替换入口，草稿密文和最终派生秘密均不得进入浏览器存储。

拟首版只支持 UTF-8 文本，每服务 16 个文件、每文件展开后 64 KiB、合计 512 KiB；NUL、超限和无效编码拒绝。普通服务配置和文件分别计量。路径为容器内 POSIX 绝对文件路径：拒绝根路径、空段、重复分隔符、`.`/`..`、反斜杠、控制字符及系统/平台保留目录。复用现有 mountPath 规则，并加入内部 `/run/ozz/database` 文件目录的冲突保护。

允许显式选择受限权限（拟 `0400/0440/0444/0600/0640/0644`，API 存数值而不是含糊的十进制字符串），拒绝 executable/setuid/setgid/sticky 位。挂载统一只读，权限不承诺改变镜像的 UID/GID 或运行用户；文件可读性必须在实际样本中验证。

预览将文件目标与全部期望 PVC、现有尚未脱离的挂载、数据库内部文件放入同一冲突检查。相同路径、父子覆盖、PVC 目录之下的文件和文件路径之下的卷均阻止；错误同时指向两条配置。不同文件共用父目录允许。首版不提供任意 `hostPath`、用户可控 `subPath` 或“先写入 PVC 再覆盖”的隐式行为。

Workload 将非敏感内容放入不可变 ConfigMap、敏感内容放入不可变 Secret，资源名按 service/publication 固定。使用受控单文件 key/subPath 只读挂载，避免以整个父目录覆盖镜像内容。文件更新随新 publication 形成新资源及 Pod 模板，旧运行面不会因更新同名 ConfigMap/Secret 热变更。

`ManagedWorkloadKind`、manifest builder、库存/观察、spec fingerprint、写前意图/回执和清理路径都须新增 ConfigMap 支持；现有 `WorkloadSecretFile` 仅服务 S5 固定数据库目录，不直接改成未经验证的任意文件入口。每个 K8s 对象检查实际编码后的尺寸。Secret 内容不进入 fingerprint/日志。任何文件资源仅凭名称/标签而无所属 UID 记录时，不能覆盖或删除。

应用中途失败仍保留部分资源证据并标记配置不一致；所有 Secret/ConfigMap/Service/controller 完整应用后才移动 publishedDeploymentId。只清理已证明无当前 Pod、当前完整 publication 或在途任务使用的旧文件对象；历史密文/FK 保留以支持原输入重试。保留 S5 的本地卷单写者、Recreate 中断、旧 Pod 退出及节点失联处理规则。

## 6. S7.03：组合模板与仓库

内置固定模板作为一个实际 Provider 保留。拟增加 GitHub 模板仓库 Provider：复用已授权的 GitRepository/当前 Git 凭证，固定数字仓库 ID、完整 commit、manifest 路径和内容摘要。模板仓库与应用源码仓库分别展示。首版不把自定义仓库理解为任意 URL、任意 Helm/Kubernetes YAML 或执行仓库脚本的插件机制。

TemplateVersion 包含 schemaVersion、参数 schema、具名组件、资源需求、输出/依赖和固定镜像/应用来源。解析使用有界的声明数据（拟首版每实例最多 16 个组件、32 个卷），拒绝重复组件、无效路径、未知字段、秘密默认值与 target 覆盖。仓库同步只新增候选不可变版本；同名 tag 移动保留旧内容身份并显示新候选，不覆写已实例化版本或自动升级运行服务。

预览固定一个 Project/Environment 及继承的 Cluster，展示拟创建的服务/卷、连接映射、所需秘密、构建目标、容量及依赖顺序。引用已存在资源时显式选择其稳定 ID 并验证同环境/目标，不因 slug 相同自动采用。数据库密码只生成一次并加密，重复幂等请求返回原服务/卷身份，不返回生成密码。

拟议的实例编排契约：

```ts
type TemplateComponentState =
  | 'draft'
  | 'waiting_dependencies'
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'blocked'
  | 'cancelled';

type TemplateInstantiation = {
  id: string;
  versionId: string;
  target: { projectId: string; environmentId: string; clusterId: string };
  planHash: string;
  revision: number;
  components: Array<{
    key: string;
    serviceId: string;
    volumeIds: string[];
    dependsOn: string[];
    state: TemplateComponentState;
    deploymentId: string | null;
    acceptedInputRevision: number;
  }>;
};
```

实例化在有界短事务中保存资源映射、参数秘密引用与草稿，复用 CommandReceipt 和既有创建校验；不在创建草稿时暗中发布。明确发布后，编排器按拓扑推进：先受理无依赖提供方的独立 Deployment；它完整发布且通过实际就绪检查后，解析消费者的固定输出并受理该消费者。`queued/任务成功` 单独都不能代替数据库认证就绪。

实例发布计划先固定每个组件的运行草稿 revision、文件版本、变量表达式、模板/来源 revision 和选定 Git commit；等待期间不能重新取 branch HEAD 或偷偷采用用户后来保存的配置。只有依赖提供方的实际输出/秘密版本在它就绪后解析；用户改了待受理组件时将其标记为需复核，不把未审阅变更混入旧实例计划。

编排器只保存计划/组件结果并调用统一命令，等待由持久状态与受限调度推进；不保持数据库事务或 Worker 线程等待整张图。不同分支失败隔离，受限并发服从现有全局/服务/Builder 槽位。接受一个子 Deployment 和记录组件关联须在同事务内完成，幂等作用域包含 instance/component/尝试身份，防止恢复时重复受理。

部分失败保留成功组件、卷及失败任务。默认暂停失败组件的后继，其余独立分支可继续；UI 显示等待的具体提供方和全部子 TaskRef。明确的“重试失败组件”对已有失败任务调用原重试契约；尚未受理的消费者按实例固定配置等待并解析新鲜提供方输出。前者不能重解释为当前草稿，后者不能提前存一个假 Deployment。用户改了组件配置/模板版本时，先复核新计划；不能用原重试按钮偷换输入。

取消实例停止受理新组件，并向在途子任务发送既有取消请求；待构建结束证明/任务终态再反映取消完成。它不是“回滚整个事务”，不自动删除服务或数据。整个实例只有所有必需组件真实就绪才显示成功。服务/实例删除分别说明保留对象，不能通过删 Namespace 清理保留 PVC。

## 7. S7.04：Monorepo 与变更触发

GitSourceRevision V2 增加 `rootDirectory`、构建模式、watch/shared paths 和明确的命令来源。为兼容 S6，`contextPath` 与 `dockerfilePath` 仍相对于 checkout 根；`rootDirectory` 是自动检测与自动构建命令的工作目录。UI 同时显示三个解析后的相对位置，例如 root=`apps/web`、context=`.`、Dockerfile=`apps/web/Dockerfile`，避免把两个“根目录”混为一谈。V1 在 reader 中具有 root=`.`、不启用路径过滤的既有语义，历史 JSON 不补写字段。

所有路径为仓库内受限 POSIX 相对路径，拒绝绝对路径、控制字符、空段/父目录及选项注入。API 检查语法及固定 commit 下的对象类型；Builder checkout 后核验真实路径、祖先 symlink 和 context/Dockerfile 的 containment。root 内部的命令也不能改变可信工具的执行目录或读取 checkout 外的宿主机文件。repo 文件只是构建输入，不能作为控制面 shell 参数拼接执行。

watch 采用受限、已固定语义的 glob 库：路径相对于仓库根，include/shared 取并集，exclude 只去除普通 include；空配置表示全部变更。Dockerfile、context 对应的 `.dockerignore`、已采用的声明文件及已识别的依赖锁文件等强制依赖不能被 exclude 隐藏。UI 必须列出实际生效的规则与来源。改规则创建新来源 revision，不修改旧 WebhookTarget 的解释。

只有 **已证明完整且与已发布输入可比较的 diff** 才能得到 `skip_unrelated`。拟保存 `before/after/base SHA`、比较来源、完整性、截断/权限原因、匹配路径/规则摘要及 source/policy revision；状态区分 `matched`、`unrelated`、`unknown`。列表中的少量路径只是展示样本，不能冒充已比较全部路径。

| 情况                                                                               | 决策                                                                          |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 完整 diff 仅改 `apps/other/**`，无本服务/强制共享依赖                              | 此服务 Target 明确 `ignored: paths_unrelated`；其他服务独立判定               |
| root、共享包、workspace 配置、锁文件、Dockerfile 或构建配置命中                    | 触发当前固定提交的正常受理流程                                                |
| 首次发布/首次分支推送、before 为零、无可比较的成功基准或来源 revision 已变         | 保守触发，显示首建/基准变化原因                                               |
| force push 非祖先、事件缺失、GitHub compare 文件列表截断/分页不完整、限流/权限失败 | `unknown`，保守构建或保留可重试待办；绝不能以空列表跳过                       |
| 删除/重命名/二进制文件                                                             | 按旧路径和新路径覆盖关系判断；不能只比较文本 patch                            |
| 多提交推送/事件合并                                                                | 比较完整 commit 范围；不能只读最后一个 commit 或 Webhook 的部分 commits/files |
| 已有相关失败/待发布提交，后续事件表面无关                                          | 保留未满足的相关变化；不能用“最新事件无关”清空旧待办                          |
| stopped 服务                                                                       | 仍验签、去重、保存解释与待办；无论 matched/unknown 均不自动构建或恢复         |
| 手动选定 commit 发布                                                               | 路径过滤不阻止用户明确发布；仍验证固定提交、目标和配方                        |

优先以同来源版本的当前实际发布 commit 到新 after SHA 作完整比较，覆盖遗漏的相关变更；无法证明该基准代表当前镜像（例如镜像回滚）则按 unknown/首建处理。GitHub Adapter 新增返回完整性证据的受限 compare Interface；其响应上限不能被调用方解释成“完整”。控制面不为补 diff 启动用户源码构建；无法完整比较时选择保守触发，沿用现有逐服务 Target/幂等/停止锁存。

自定义安装/构建命令归自动构建配方，在独立 Builder 的 rootDirectory 内执行；Dockerfile 模式以文件定义为准，冲突字段须说明并拒绝含糊组合。启动覆盖继续使用现有 runtime `command/args`，与自动构建器给镜像生成的默认入口分别显示，不能把 runtime 命令误作为控制面命令。

## 8. S7.05：声明文件、优先级与 schema 迁移

拟首版支持有界 JSON/YAML 的 `apiVersion: ozz.dev/v1` 声明输入，由固定 JSON Schema 和受限解析器验证，拒绝未知版本/字段、重复键、任意 tag/对象构造、过深嵌套和无界 YAML alias 展开。该文件只在用户明确“导入”时读取；Git 推送或仓库文件变化只提示源文件已变化，不能后台覆盖 UI 或直接发布。

S7 导入进入已选 Project/Environment 的草稿：先选择明确目标，再上传内容或选择已授权仓库的固定 commit/path。文件中的集群/Namespace/PVC 实体身份无写入权限；尝试覆盖 Project.clusterId、服务独立 target 或环境归属时返回字段错误。创建新项目仍先走已有项目创建与集群选择，然后导入其草稿。S8 的项目复制、导出和跨环境自动重映射不在本阶段冒充完成。

本地声明组件 key 必须在预览中映射到当前环境的明确服务 ID 或本次拟创建身份，映射失败阻止相应导入/发布；不能按名称自动命中生产数据库。嵌入的秘密使用占位/显式秘密引用，生成或填写秘密通过受保护输入单独完成。模板/声明文件不保存真实密码默认值。

| 层级                      | 拟议规则                                                                                   | UI 表达                                              |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 系统身份与受保护注入      | Cluster/Namespace/资源身份、数据库保护及平台保留名不可覆盖；冲突直接报错，不按顺序静默胜出 | “系统固定/数据库保护”，给出冲突字段                  |
| 用户明确的 UI 覆盖        | 高于该字段的已导入值；覆盖保留直到用户明确移除或在新导入预览接受替换                       | 显示当前值来源、被覆盖的来源与移除覆盖入口           |
| 当前已接受的声明导入版本  | 高于模板/schema 默认；再次导入必须明确合并或替换哪些字段                                   | 固定 importId、commit/path 或文件摘要、schemaVersion |
| 固定 TemplateVersion 默认 | 只填未声明/未覆盖字段，仓库有新版不改变现值                                                | 模板 ID/版本与默认来源                               |
| 固定 schema 默认          | 最低；由已选 schema 版本确定                                                               | 默认值及版本                                         |

引用不是可任意覆盖的最高优先级：一个最终变量名只能有一个有效定义。手工值、通用绑定和数据库注入重名时必须在预览中显式解决；受保护注入禁止覆盖。数组按稳定 ID/变量名/文件路径匹配并显式删除，不使用依赖对象遍历顺序的深层合并。

导入分为 parse → 规范化 → 来源/目标能力校验 → 逐字段 diff/冲突选择 → 原子保存草稿。previewId 绑定文件版本、schema、mapping、source/config revisions 和用户的覆盖选择；内容或草稿变化使预览失效。相同输入及相同选择得到相同有效非敏感配置和秘密版本集合，规范化摘要与 provenance 随发布固定。

声明 schema 与 Deployment snapshot 是两种独立版本。升级应用不能自动用新 schema 默认值重解释旧草稿/旧发布；需要纯转换函数、迁移预览、差异与显式采用动作。原文件/规范化版本保留，转换失败保留编辑内容并定位字段；不得以“升级成功”暗中改变启动参数、资源、秘密或目标。

拟交付独立配置 schema 说明与样本（实施时新增 `docs/configuration-schema.md`），覆盖普通变量、秘密占位、同环境输出、文件、monorepo 与构建/运行阶段。该文档与 OpenAPI/运行时 validator 保持一份字段语义来源。

## 9. S7.06：成熟开源自动构建

S7 初始范围限定 Node.js Web 服务和静态站点。拟首选 **Railpack** 进入小规模实际评估，保持 Dockerfile 为明确可选覆盖；最终固定版本、二进制/镜像 digest 和能力表由评估证据决定，当前没有安装、接入或验证任何自动构建器。

本次只读核查的上游事实：

| 候选                                          | 官方资料及取舍                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railpack                                      | [上游 README 固定提交](https://github.com/railwayapp/railpack/blob/9d1a4eafeef14c6f2902dd53352917f9158a85e0/README.md)说明其继承 Nixpacks 的生产经验并使用 BuildKit；[官方文档](https://railpack.com/)为集成依据。与现有独立 BuildKit 路径接近，拟作为首选；真实隔离、secret、ARM64/AMD64 和静态站点能力仍待验证 |
| Nixpacks                                      | [上游 README 固定提交](https://github.com/railwayapp/nixpacks/blob/144b4f9ab1c3943af4dfe76d3c79d91263f5b465/README.md)已明确 maintenance mode 并推荐 Railpack；保留为经验参照，不作为新默认依赖                                                                                                                  |
| Cloud Native Buildpacks / pack（可配 Paketo） | [pack README 固定提交](https://github.com/buildpacks/pack/blob/9b483c2428d832957efc7fe3d96bbef1395ca001/README.md)说明其实现 CNB Platform Interface；是成熟替代候选。评估其 builder/lifecycle、构建存储及 daemon 接入对现有隔离/产物链路的改动，不能直接假定符合现有 Builder 证明                                |

先用两个真实无 Dockerfile 样本验证选择：带锁文件、明确监听端口与 HTTP 健康检查的 Node.js 服务；带构建产物目录与静态服务器的站点。记录依赖管理器/Node 版本、入口/静态目录识别、离线/网络失败、secret mount、缓存隔离、取消后结束证明、平台支持和资源成本。候选不满足 S6 隔离或秘密边界时切换成熟候选，不通过控制面直接运行工具或自制通用构建系统绕过。

B04 的两类信息必须分开：

1. **初步识别/草稿计划**：固定 commit、root 与受限仓库元数据产生的识别结果，显示 Node/包管理器、安装/构建/启动配置及静态目录；标记“未执行”。用户“采用计划并保存草稿”只保存声明输入。Stitch 原型本身写明“方案预览/本页不会执行源码”，不是 Builder 证明。
2. **实际构建计划**：同一个已受理 Deployment 的 Builder 在 checkout 后运行固定开源构建器生成最终计划，先持久化有界、脱敏的计划及身份摘要，再进入 solve/export/push。记录 plan schema、工具 release/digest、Builder profile、commit、root/context、有效 recipeHash、依赖锁/基础镜像信息和最终入口，关联 BuildRun/BuildArtifact。计划生成失败显示实际阶段错误，不能跳成部署成功。

commit/root/context/模式/命令/构建器版本任一输入变化，都使旧初步识别/采用预览失效并要求重新计算/复核；历史实际计划始终属于原 BuildRun，不能显示成当前草稿的计划。

无需为 S7 另建预发布构建任务系统。预览无法确定的自动识别项显示未知；完整计划在现有 Deployment 的 `planning` 阶段产生并可在详情查看。如果最终计划不满足已采用的模式/平台/显式约束，编译前失败，用户修正草稿再发起新发布。

GitSourceRevision V2 固定构建模式、根路径、命令声明及构建器版本；BuildInputSnapshot 固定本次 build phase 变量和 secret 版本。`recipeHash` 的声明摘要与解析后的有效配方摘要分别命名/校验，后者进入 BuildRunSpec 和产物身份；V1 旧算法不改写。最终计划的摘要在开始 solve 前固定并进入 run/产物证明，取得计划后重试复用原计划；原计划/已知 OCI 产物丢失明确失败，尚未生成计划时才按原 commit/工具版本生成，不能重识别当前分支。

Builder 协议新增版本/能力声明及 `planning` 阶段；规划进程与 git/solve/uploader 一样受执行组、超时、内存/PID/磁盘限制和终止证明约束。取消/失联时 planner 不能成为未登记后台进程。生产依然经独立 Builder → 外部 Registry → 同一 ServiceExecutor；API/Worker 不编译用户源码，也不把源码里的安装/构建命令当控制面 shell 执行。

Dockerfile 覆盖是显式模式选择，继续使用现有固定 Dockerfile/context 路径。向仓库新增 Dockerfile 不自动切换已采用模式；UI 提示可选覆盖。无受支持 Node/静态入口、锁文件/包管理器冲突或静态目录不存在时返回明确的 unsupported/修正路径，允许用户提供 Dockerfile。不承诺全语言识别、任意框架或跨版本位级可重现；实际发布身份始终以验证后的 digest 为准。

## 10. S7.07：历史镜像回滚

回滚是一个新的部署命令，不能复用“重试旧 Deployment”按钮的输入语义。拟新增 `image_rollback` Deployment kind（仍由同一 executor 执行），以及 `rollbackOfId`/`baselineDeploymentId` 的不可变关联；`retryOfId` 仅表示失败尝试的重试。

预览必须同时取得两份不同证据：历史候选是同一服务真实 `succeeded`、完整记录且有可验证 digest 的 Deployment；基准是 **Service.publishedDeploymentId 指向的当前完整已发布快照**，它可能与 lastSuccessfulDeploymentId 不同。基准须与当前 target/管理资源/controller/配置状态一致，并具有新鲜观察。不能因为当前健康失败就退回最近成功配置，也不能因为某个 Pod 看起来健康就宣称部分应用已完整。

候选必须属于同一原 service/project/environment/cluster/installation 身份；不接受其他服务的任务 ID、同名服务或迁移后旧集群记录。预览固定 baseline ID、历史记录、目标、service/mutation revision、观察证明和过期时间，受理时重新核对。配置 partial/drifted/unknown 时，先按既有完整重新发布/对账流程形成可信基准，然后重做回滚预览；不能用 rollback 的 repair 标记直接绕过。

新快照保留基准的运行变量及秘密版本、文件版本、端口、命令、资源、探针、controller、卷/数据身份、引用及目标，仅把镜像选择改为历史成功 digest。草稿和待发布 Git 提交保持原样，仍可提示未发布。基准非敏感字段与新快照的差异应只有镜像选择及必要的 Deployment/操作关联；不得从历史候选恢复它的旧环境变量或配置文件。

Registry 用固定 authority/repository 和当前有效 pull 凭证校验 manifest/digest/平台可获得性。历史镜像被清理或权限丢失明确失败；不重解 tag、重新拉分支构建或用其他 digest 替代。已知 Git 产物仅引用原登记产物与验证结果，不创建新的 BuildRun 来“实现回滚”。

数据库基准、候选有效镜像、卷与固定引用仍经过现有 `assertDatabaseSnapshot/assertDatabaseConfiguration` 等共用保护。不能通过只保留 DatabaseSnapshot 却改变实际 image 的方式绕过校验；密码、主版本及现有更严格的受保护镜像/版本不匹配时拒绝，独立维护路径仍为 F48。

stopped 服务必须明确选择“回滚并启动”；发布沿用 ServiceMutation/VolumeMutation、Recreate/StatefulSet 与健康等待。失败记录永久保留其尝试结果；失败回滚的重试复用该回滚快照和 digest，基准/目标已变则重新预览，不退回普通最新草稿发布。界面明确镜像回滚不会恢复数据库内容、卷、应用迁移脚本结果或外部数据。

## 11. S7.08–S7.09：容器 Exec 与 PTY

### 11.1 会话准入与 transport

拟用一个 ContainerSessions Module 提供一次性 `exec` 和交互 `pty` 两种模式，持久化 TerminalSession 元数据与 AuditEvent，实时字节只在受限通道内存中存在。它复用身份/目标/审计规则，但不是可自动重投的 Deployment/Outbox；断线、HTTP 重放或 API 重启绝不自动再次执行命令。

创建会话必须经过当前 Cookie 会话、Origin/CSRF、安装 generation/恢复状态、服务归属、当前 cluster/凭证 revision 与 `pods/exec` 权限检查。先从已验证 Workload 观察与 ManagedResource 所有权链得到 Pod UID、名称、owner、container 和关联 publication，再构造固定 Kubernetes API 路径；浏览器不能传任意 namespace、主机、Kube API URL 或 SSH 目标。

WebSocket upgrade 也要校验当前 Cookie/Origin 与会话所有权。创建接口返回短期、一次性绑定 ticket（拟 30 秒），ticket 仅用于绑定已创建的用户/session/target，不能替代 Cookie 身份；以首个有界认证帧交换，不放 URL、日志或 localStorage。认证完成前不打开上游 Exec；超时/二次使用关闭。SSE exec 输出同样绑定创建会话，读取不触发命令重执行。

打开前、连接后以及存活期间检查 session/credential/generation/目标变化并监看所选 Pod UID。Kubernetes exec 的目标寻址本身是 Pod name，没有原子的 UID precondition：需在接入前后核对 UID，replacement 竞态结果明确为 target_changed/unknown，不能宣称具有 API 不提供的原子 UID fencing。检测到更换立即关通道，不自动跟随新同名 Pod。

提取现有受限 Kubernetes transport 的 TLS、固定 origin/path、无重定向、握手/帧大小限制，继续用官方 SDK 的 Exec 编码/状态通道；不要把固定数据库验证脚本改为用户脚本入口。S2 已确认 SDK Writable 背压不足（见[技术栈评估](backend-stack-evaluation.md)），S7 必须实际处理 socket pause/resume、有限队列、超限关闭与上下游取消传播。

### 11.2 一次性命令与可信结果

输入为非空 `argv: string[]`，拟最多 64 项、合计 16 KiB，拒绝 NUL/非法字节；默认不经 shell。用户明确填写 `sh -c ...` 才由容器内 shell 解释，不把字符串拼到 API/Worker/宿主机 shell。首版无任意工作目录/环境注入选项，使用容器自身执行环境；无 shell 镜像仍可运行存在的普通可执行文件。

stdout/stderr 分流、标记序号，保留被截断标记；exitCode 只来自 Kubernetes status 通道的实际退出证明，不用 transport 关闭映射为 0。拟结果形状：

```ts
type ContainerSessionOutcome = {
  sessionId: string;
  channelState: 'open' | 'closed';
  reason:
    | 'exited'
    | 'not_started'
    | 'timeout'
    | 'output_limit'
    | 'client_closed'
    | 'access_changed'
    | 'target_changed'
    | 'transport_lost';
  remoteOutcome: 'exited' | 'not_started' | 'unknown';
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  startedAt: string | null;
  finishedAt: string | null;
};
```

超时、取消、断联和超限只证明平台通道已关闭；没有 exit status 就保持 `remoteOutcome=unknown`。找不到可执行文件、目标已消失与鉴权拒绝各有清晰代码；不把所有非零退出都归成“缺少命令”。重试由用户明确创建新 session，并提示原命令结果可能未知。

### 11.3 PTY 生命周期与限制

交互模式实际申请 `tty=true`，stdin、PTY 输出、resize 与 heartbeat 经过有界协议；TTY 下 stderr 可能合并，UI 不声称还能精确分流。默认选择 `/bin/sh`，可明确选择镜像存在的 shell；不存在时显示“镜像未提供所选 shell”，不安装 shell、不退回主机 SSH。

首版断开立即关闭上游通道；“重新连接”创建新 session/new shell，旧终端不透明续接，不重放 stdin，也不暗中启动 tmux/screen。session 过期/注销、权限或当前凭证/目标变更、API shutdown 均关闭通道并记录真实原因。API 崩溃后记录为 lost/unknown，启动恢复只回收本地会话占用，不重开命令。

| 资源      | 拟初始上限与行为                                                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exec      | 默认 15 秒，用户可选但不超过 60 秒；stdout＋stderr 合计 1 MiB，超限关闭并保留截断结果                                                                                         |
| PTY       | 最长 15 分钟、无用户输入 2 分钟关闭（heartbeat 不延长交互空闲期限）；单帧 32 KiB，socket 待发缓冲 256 KiB，总输出 8 MiB，超限关闭                                             |
| 心跳/尺寸 | 15 秒 heartbeat、45 秒未应答关闭；尺寸整数且有界（拟 1–500 列/行），resize 合并节流                                                                                           |
| 并发      | 每用户 4 个容器会话，其中 PTY 最多 2 个；同 Pod/container PTY 最多 1 个；全安装 8 个。准入原子计数，不能只靠进程 Map                                                          |
| 展示/审计 | 前端 scrollback 有界；记录 actor/session、目标 UID/container、模式、脱敏命令摘要、时间、字节/退出结果/关闭原因，记录当前认证版本，不记录私钥、ticket、stdin 或原始 transcript |

上述为产品初始限制提案，须在 Node 24/真实 K3s/慢客户端上验证后固定。会话记录中只保存可审计的 executable 名与参数数量/脱敏摘要，默认不保存任意参数原文；一次性幂等比较若涉及秘密使用不可公开验证的摘要。页面内命令草稿只存内存，历史查询不恢复秘密参数。

输出使用所选 publication 的固定秘密集合（含间接引用/文件源秘密）进行有界已知值脱敏；审计不能因 PTY 控制字节或分帧而写入原始秘密。交互通道不能直接套用会保留长尾的日志缓冲而卡住提示符：需验证小输出、无换行、跨帧秘密与 ANSI 序列的延迟/脱敏策略；不完整秘密前缀若到刷新期限应遮蔽而不是原样冲刷。终端以 xterm 解析字节，不渲染用户输出为 HTML，不自动执行链接或剪贴板控制序列。未知的应用秘密不声称可自动识别。

Exec/PTY 不修改保存的草稿或已发布快照；命令对容器临时文件、PVC 或数据库的实际影响不自动变成声明配置，也不在关闭会话时自动撤销。

## 12. S7.10：轻量日志与完整 UI 流程

继续使用 ServiceLogReader → KubernetesPodLogs → API SSE → ServiceLogViewer。已有后端每读 60 秒/1 MiB、每用户连接限制；Console 另有 200,000 字符/10,000 行展示缓冲及独立传输读取保护，这些层级分别显示/验证，不能混称“保留日志容量”。部署任务日志、Builder 日志和容器日志保留各自来源与保留期。

关键词过滤首版为有界文本匹配（拟长度不超过 256 字符、明确大小写规则，不开放任意正则）。默认仅过滤当前缓冲，显示“当前已加载的 N 行/服务/部署/Pod/container/previous 状态”；可另行发起有界 `sinceTime/tailLines/follow=false` 读取。先按固定秘密集合脱敏，再匹配/展示/下载，避免通过查询有无匹配侧信道验证秘密。搜索结果不能宣称覆盖已轮转或已删除 Pod 的历史。

下载分为“导出当前显示缓冲”和“读取所选来源的一次有界日志”。前者使用脱敏缓冲，不夹 UI 装饰字符；后者复用 ServiceLogReader 和相同时间/字节限制，文件附带来源、采集时间、截断/缺口说明与安全文件名。不得接受控制面日志磁盘路径、无界时间范围或把所有文本写进 PostgreSQL。达到上限明确提示，不为了凑齐下载在后台无限重连。

SSE 刷新使用现有受鉴权流与 scope/session fencing。每次读取结束、Pod 切换/重建、previous 切换及重连都标明边界；使用 sinceTime 的有限重叠不保证严格 exactly-once，不能用文本去重抹掉真实重复日志。任务/资源通知只使查询失效并重新读取持久状态；遗漏通知或事件窗口过期则完整 refetch，不由 SSE 事件直接推断部署成功。

Console 复用以下实际 Module：

| 流程           | 复用位置（相对 `apps/console/src`）                                                                                                                                                                                    | S7 必补部分                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 变量/文件/预览 | `components/services/ServiceVariablesEditor.vue`、`ServiceConfigurationEditor.vue`、`ConfigurationReview.vue`；`components/storage/ServiceDatabaseBindings.vue`、`ServiceVolumeMounts.vue`、`ServiceStorageReview.vue` | 当前 reference 仅为 secretRef，不是服务输出。新增阶段/依赖、文件编辑与版本，错误链接到原字段                   |
| 模板           | `pages/TemplateCreatePage.vue`、`components/storage/TemplateGallery.vue`、`TemplateParameterEditor.vue`、`TemplateConfigurationPreview.vue`                                                                            | 当前只创建单服务；补组合拓扑、仓库版本、逐组件任务与局部重试                                                   |
| Git/自动构建   | `components/git/GitSourceEditor.vue`、`ServiceGitSource.vue`、`GitSourceSummary.vue`、`BuildSummary.vue`、`BuildLogs.vue`                                                                                              | root/watch/diff 证据、初步识别与真实最终计划分别展示                                                           |
| 回滚/任务      | `pages/DeploymentPage.vue`、`ConfigurationReview.vue`、`DeploymentFailureObservation.vue`                                                                                                                              | 独立 rollback preview/submit、双记录来源、配置不一致/数据保护及 stopped 门禁                                   |
| 日志/容器      | `ServiceLogViewer.vue`、`VirtualServiceLog.vue`、`lib/service-log-stream.ts`、`ServiceRuntimePanel.vue`                                                                                                                | 有界过滤/下载与实际 Exec/PTY，不能仅添终端按钮                                                                 |
| 生命周期/导航  | `useDirtyForm.ts`、`useViewScope.ts`、`lib/api.ts` 的 sessionEpoch/AbortSignal；`useActiveTabVisibility.ts` 仅辅助活动页签在导航中可见                                                                                 | 编辑秘密不持久化；流显式连接到 session/视图及 unmount 生命周期，晚到响应不覆盖新目标；导航 hook 不承担连接状态 |

路由已有动态 import，`ServicePage.vue` 已用 `v-if` 按 tab 挂载/销毁组件，现有日志切走也会断开；但所有 tab 仍静态导入，`v-if` 不负责代码拆包。拟对编辑器与终端面板使用异步组件，面板激活后才加载 CodeMirror 6 / `@xterm/xterm` 及 fit addon，实际会话由明确连接动作创建；切 tab/路由销毁时关闭通道并保留适当非敏感视图状态。依赖版本实施时锁定，不预装完整 IDE。

`AppShell.vue` 的全局 Cmd/Ctrl+K 目前只检查部分 IME 状态；S7 应尊重 defaultPrevented、完整 composition 状态及 composedPath 中编辑器/终端的快捷键归属。终端 Ctrl+C/D/L/K、编辑器保存/查找与中文组词 Enter/Esc 属于当前交互区；关闭弹层或会话正确归还焦点。CommandPalette 自身的 IME 防护不能替代 shell 层修复。

连贯验收顺序为组合模板 → 同环境输出/文件配置 → 预览与发布 → Monorepo/自动构建 → 日志/终端定位 → 历史镜像回滚。始终保留项目/环境/继承集群上下文，区分未保存、已保存未发布、完整已发布及局部失败；检查明暗主题、键盘/读屏抽检、1440/1024/390 CSS px、200% 缩放和减少动效。持续日志不夺滚动/焦点，不阻塞输入；秘密不进入 URL 或浏览器持久存储。

## 13. Stitch 精确映射

项目为 [10685771573457769661](https://stitch.withgoogle.com/projects/10685771573457769661)。下表的 A/B/C/F/G 是**屏幕代码**，与 PRD 的 F26/F32 等需求编号不是同一命名空间。映射仅为设计依据，不能作为实现/联网验收证据。

| 屏幕                     | 固定 screen ID / 在线预览                                                                                       | S7 使用范围                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A03 项目概览             | [17451124849340747292](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=17451124849340747292) | 组合依赖图、逐组件结果与项目上下文                      |
| A05 服务详情             | [17451124849340746506](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=17451124849340746506) | 运行/配置状态、回滚返回路径                             |
| B03 GitHub/Dockerfile    | [13659930229779220661](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=13659930229779220661) | S7.04 root/context/路径与来源                           |
| B04 自动构建计划         | [13659930229779220916](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=13659930229779220916) | S7.04/06 初步识别与采用草稿；区别最终 Builder 计划      |
| B06 组合模板与仓库       | [13659930229779221426](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=13659930229779221426) | S7.01/03 参数、资源/引用、版本、部分失败                |
| C01 变量/引用/文件       | [13659930229779221681](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=13659930229779221681) | S7.01/02 变量阶段、依赖、文件和秘密来源                 |
| C02 运行配置             | [10460690044834303453](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=10460690044834303453) | 既有运行参数与 S7 预览衔接                              |
| C03 变更预览             | [10460690044834301172](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=10460690044834301172) | 文件/引用/模板/import 差异、目标及发布门禁              |
| C04 环境管理             | [10460690044834302987](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=10460690044834302987) | S7 引用的环境范围；环境复制部分留 S8                    |
| C05 项目声明配置         | [10460690044834300706](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=10460690044834300706) | S7.05 显式版本化导入与来源/冲突                         |
| F02 发布任务/失败        | [15518668817694542137](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=15518668817694542137) | 组合子任务、部分应用与连续排障                          |
| F05 历史镜像回滚         | [15518668817694543494](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=15518668817694543494) | S7.07 基准/候选、差异和新部署关联                       |
| F06 服务日志             | [15518668817694542581](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=15518668817694542581) | S7.10 过滤/下载/有界 SSE 与范围                         |
| F07 容器终端             | [12429259751516655300](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=12429259751516655300) | S7.08/09 实际 exec/PTY 与 session 状态                  |
| G04 Git/Registry/Builder | [12429259751516655016](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=12429259751516655016) | S7.04/06 工具能力、版本、当前认证/固定身份              |
| C06 项目设置与复制       | [10460690044834302521](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=10460690044834302521) | F39 的复制/导出在 S8.08，本阶段只复用固定项目目标上下文 |
| G05 外部集成与观测       | [12429259751516654945](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=12429259751516654945) | F37 的集中日志在 S8.06，不能标为 S7 已支持              |

主流程沿 FLOW07（B06→C01→C02→C03→A03）、FLOW08（F02→同服务 F06/F07→配置复核→F05 新回滚部署）和 FLOW03 的 Git 来源/任务衔接验收。FLOW09 只交付 C05 显式声明导入部分，不将 C04/C06 的环境/项目复制算入 S7。对应关键场景为 UI04.05/06、UI05.06/07/08、UI06.08、UI07.04/05 和 UI03.07。

## 14. 拟新增迁移与升级方式

**以下仅为迁移设计，没有创建 SQL 文件、修改 Prisma schema 或应用迁移。** 实施时由 A 集中维护 schema/迁移，B 核对 Build/Workload 字段，root 负责已授权的升级窗口。迁移编号届时按实际顺序分配，不能编辑已经应用的 S6 迁移来容纳 S7。

| 拟迁移组                             | 表/字段与约束                                                                                                                                                                                  | 与历史数据的关系                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<next>_s7_configuration_references` | VariableBinding（消费字段/阶段/AST/revision）、引用边反向索引、ServiceOutput 定义；Environment reference revision；ConfigFile/ConfigFileVersion；版本到秘密及 Deployment 到文件/提供方的引用表 | 当前 Service.configJson 与 DatabaseBinding 保留。输出实际值来自完整 publication，不由可变草稿或未验证缓存冒充。文件版本/固定边追加不可变；唯一变量目标/路径、同环境/目标和图事务校验配合生效 |
| `<next>_s7_configuration_imports`    | 不可变 ConfigurationImport、输入 schema/来源、mapping/override/provenance；有界 ConfigurationPreview 及到固定秘密/文件版本的引用                                                               | 默认无导入来源，旧草稿语义不变；预览过期清理只释放自身引用，不删除仍被草稿/发布持有的版本                                                                                                    |
| `<next>_s7_composite_templates`      | TemplateRepository、Template、TemplateVersion、TemplateInstantiation、Component 与逐尝试 TaskRef 关联、参数秘密引用                                                                            | 现有五类模板仍是固定目录 Adapter，不伪称已有数据库 Template 表。内置身份映射是新增数据，不改旧 Service.templateId/version 或历史快照                                                         |
| `<next>_s7_source_and_build_plan`    | GitSourceRevision V2 读取支持；WebhookTarget 的不可变路径判定证据；BuildPlanVersion、BuildRun/Artifact 的 plan 关联；协议/能力版本字段                                                         | 不更新/删除 S6 的 GitSourceRevision/GitSourceSecretReference 行，不改原 recipeHash/commit/target。新增字段对旧行为空或明确 legacy 语义；计划/证明版本分别读取                                |
| `<next>_s7_rollback`                 | Deployment.rollbackOfId/baselineDeploymentId、类型注册与自引用 FK；回滚预览的基准/目标/过期/已消费约束                                                                                         | retryOfId 保留原义；旧行新增关联为空。数据库检查约束与领域门禁都禁止跨服务/目标候选及覆盖受保护数据身份                                                                                      |
| `<next>_s7_container_sessions`       | TerminalSession：模式、actor/session、固定目标/Pod UID/container、创建/连接/关闭状态、owner lease、ticket 摘要/消费标记、计数/结果；必要唯一/活动槽位及 AuditEvent 索引                        | 不存 argv 秘密原文、ticket 明文、stdin/transcript；会话过期仅关闭/释放占用，remoteOutcome 不改写成 exited。恢复不创建新通道                                                                  |

DeploymentSecretReference/ServiceSecretReference 继续承担历史/草稿秘密保留，新增文件、导入、模板与输出的秘密引用进入同一语义更新/删除保护。只增加 FK 而未扩展 SecretReference 的不可变内容校验不算完成。JSON 与关系索引在同一事务写入，并用数据库约束/集成测试证明没有“快照有秘密引用而 FK 缺失”的路径。

提供方历史引用保留 originalProviderServiceId、target 与版本证明；可删除 Service 的活动 FK 采用受控墓碑/置空，不把所有历史发布永久连成无法删除的服务。另一方面，仍被当前发布/在途任务使用的文件、秘密、数据身份不可提前删除。模板组件关联必须保留所有失败尝试，不能覆盖最后一次 taskId 后丢失历史。

升级顺序为新增 schema/兼容 reader → API/Worker/Builder 能力验证 → Console/生成客户端 → 开启 V4/新来源 writer。旧 V1–V3 queued/running/retry 路径与新路径同时验证；不支持 V4 或 Build 协议 V2 的 Worker/Builder 不接收相应任务，不向旧协议悄悄降级。writer 开启后不承诺旧二进制可直接回退读取 V4；暂停新写入并按可读版本恢复，而不是删除新增表或重写快照。

迁移先在隔离 PostgreSQL schema 中测试。升级前后比较既有业务表旧字段/历史 JSON 的行数与摘要，验证密码密文/主密钥语义和 S6 append-only/FK/结束门禁不变；新字段默认值不能改变旧发布行为。公共库升级、备份、API/Worker/Builder 切换由 root 串行安排，本设计不触发这些动作。

## 15. 所有权、实施顺序与交接

下表是后续实施的拟议文件所有权，不授权本轮设计任务修改这些文件。共享契约先定稿，单个共享文件同一时刻由一个人编辑；跨边界用小补丁交接，避免 A/B 同时扩展快照 union、Task registry 或 Prisma schema。

| 负责人 | 主责                                                                                                                                              | 交接/复核                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A      | `configuration/references/templates` 领域与对应 API/DTO；快照/来源契约与 schema/迁移；回滚候选、会话元数据/审计、声明导入；文档与隔离 DB/API 验证 | `services/contracts.ts`、`git/contracts.ts`、数据库 schema 为 A 统一编辑；任何执行语义变更交 B review |
| B      | 现有 Worker/Tasks/ServiceExecutor、Workload ConfigMap/文件、Builder 协议与自动计划、Kubernetes Exec/PTY Adapter/结束与恢复行为                    | 与 A 确定捕获/执行 Interface 后修改共享执行文件；不新增另一套任务/Workload controller                 |
| C      | `apps/console`、按需编辑器/终端、各预览/错误/状态、Stitch 对应与浏览器验收                                                                        | 以生成的 `packages/api-client` 为契约；不在 UI 自建后台业务规则或用 mock 结果显示成功                 |
| root   | G-MVP 入口、范围裁决、公共迁移/运行面编排、资源窗口、最终检查与验收/封存                                                                          | 控制一次一个重型进程；整合 A/B/C 证据，决定实际通过/未通过，不用设计状态代替运行结果                  |

实施顺序建议：

1. 固定 V4/来源 V2/值与文件 schema、来源优先级和迁移计划；先增加兼容 reader 与黄金历史样本，证明既有 S3/S5/S6 行为可继续。
2. A/B 合作完成 S7.01–02 和原发布路径的接线；C 可并行实现对应表单/预览，遇未实现接口显示明确状态。
3. 在引用/文件可发布后完成 S7.03；同时基于已固定来源契约推进 S7.04–05。B 的成熟构建器短评估可早做，但生产接入以固定来源/阶段/秘密契约为前提。
4. S7.06 接入同一 Builder/产物链；S7.07 依赖 V4 与可信基准校验。S7.08 的 transport/access 可以独立推进，S7.09 在一次性真实 Exec 验证后接 PTY。
5. C 汇合 S7.10 流程与懒加载/焦点，A/B 补齐故障验证；root 串行完成真实 Builder、K3s、生产构建浏览器与 P0 回归，再写 `docs/acceptance/S7.md`。

具体版本/能力和初始上限是需要实验定稿的工程决策：Railpack release/digest、支持的包管理器/Node/平台组合、最终计划 schema、PTY 与网络代理的协议能力、文本文件权限与运行用户兼容性。默认按本文保守契约实施，测试失败则记录限制并修正方案；不以“等用户确认”代替可独立完成的评估，也不提前宣称完整支持。

## 16. 验收矩阵与退出条件

下列全部为 **待实施/待验证**。本次只完成方案和资料核查，没有运行本表测试。单元/协议替身、隔离数据库、真实本地运行面、外部服务和真实浏览器的证据分别记录；通过某一层不能代表另一层通过。

| 编号 / 任务          | 必须验证的行为                                                                                                                                        | 验证层与证据                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S7-A01 / 公共兼容    | V1/V2/V3 原 JSON/来源/hash 不变；旧发布重试、重启/恢复、旧数据库绑定仍正确；V4 未知版本拒绝；Git 无产物不注入占位 image                               | 快照 Interface 样本＋隔离 PG/真实 HTTP，升级前后旧字段摘要                                                                                                   |
| S7-A02 / 01、E21     | 缺失输出、自引用、变量/服务间接环、并发成环、跨环境/集群、过深/过大图均发布前失败并定位；重命名保留稳定引用                                           | 纯图/解析测试＋带并发事务的 PG/API 测试                                                                                                                      |
| S7-A03 / 01、E21     | 秘密经 concat/URL/文件/跨服务传播；敏感值不能进入 build ARG/普通字段；runtime 值不自动进入 Builder；所有固定引用 FK 齐全                              | API 负向测试、Worker/Builder 协议检查、秘密 canary 检查响应/队列/日志/计划                                                                                   |
| S7-A04 / 01          | 提供方真实就绪后才接受消费者；输出变化仅显示待发布，旧 Pod/Secret 值不热变；草稿移除但未发布仍阻止删除；重试不取新值                                  | 真实 K3s＋数据库认证证据、Pod UID/资源版本与快照前后比较                                                                                                     |
| S7-A05 / 02、E21     | 文件重复/父子/系统目录/超限/NUL/权限/PVC 冲突可定位；两个同目录文件不覆盖镜像目录；正确文本/秘密/模式在容器可读；重建后保持版本                       | 解析测试＋K3s 实际 ConfigMap/Secret/mount 观察与容器读取                                                                                                     |
| S7-A06 / 02/07、E28  | Secret/ConfigMap/Service/controller 任一步部分失败都不产出假完整基准；停止允许，恢复/重启/回滚按规则阻止/先对账；不采混合 Pod 配置                    | Workload 故障 Adapter＋真实资源回执/状态及动作 API 验证                                                                                                      |
| S7-A07 / 03          | 组合 app＋数据库从参数预览到实际连接；提供方认证就绪后才有消费者 Deployment；相同幂等请求资源与子任务不重复；所有组件固定同一 target                  | PG 并发/故障测试＋真实 K3s 数据写读与任务时间线                                                                                                              |
| S7-A08 / 03          | 中间组件失败、控制面重启/取消、等待期间草稿改变、仓库 tag 移动；只重试选择的失败组件并保留原输入，成功组件/PVC 不被补偿删除                           | 领域/PG 编排测试＋局部失败真实演示、全部 TaskRef/volume ID                                                                                                   |
| S7-A09 / 04          | 无关路径跳过、共享路径触发、首次推送/多 commit/删除重命名/force push/不完整 diff 保守处理；stopped 保持零构建；symlink 越界被拒                       | GitHub 协议样本＋真实 monorepo commit/BuildRun 计数与路径判定记录                                                                                            |
| S7-A10 / 05          | 显式导入与冲突选择同输入确定；系统/目标不能覆盖；schema 升级不静默改运行参数；文件更新不后台覆盖 UI；导入不创建 Deployment                            | schema/规范化测试＋PG/HTTP revision 并发及 Console 预览                                                                                                      |
| S7-A11 / 06          | Node Web＋静态样本无 Dockerfile 真实构建、推送/校验 digest、发布与 HTTP 响应；实际 root/context、固定工具/计划与源码一致                              | 独立 Builder 真正执行＋Registry＋K3s＋产品请求，保存 run/plan/artifact/Deployment 关联                                                                       |
| S7-A12 / 06          | Dockerfile 显式覆盖；unsupported/锁文件冲突/静态目录缺失可处理；工具/plan/profile 变化使旧预览失效或任务拒绝；planner 取消/失联无遗留进程             | 真实 Builder 与可控故障/结束证明，非 UI 示例计划                                                                                                             |
| S7-A13 / 07          | 历史成功 digest＋当前完整但可能健康失败的基准；新 Deployment 除镜像外配置固定，草稿/待办不变；不是历史失败重试；关联可追踪                            | PG/HTTP 差异断言＋K3s 前后 digest/环境/文件/卷版本证据                                                                                                       |
| S7-A14 / 07、E28/E29 | 镜像丢失/不可拉、preview 过期、目标/基准改变、跨服务候选拒绝；stopped 要明确启动；数据库密码/主版本/受保护 image 均不能借回滚绕过                     | 负向 API＋Registry 故障＋真实数据库保护，数据内容不被回滚                                                                                                    |
| S7-A15 / 08、E22     | 实际 argv/stdout/stderr/非零退出；无命令/无权限/Pod 消失可定位；超时/断联/超限/重放不假设远端退出或重复执行；无 argv/输出秘密落审计                   | Kubernetes 协议/背压故障＋真实容器命令与 HTTP 会话生命周期                                                                                                   |
| S7-A16 / 09、E22     | 浏览器实际输入/PTY resize/退出；无 shell 可诊断；并发/ticket 重用/跨 session/Origin 拒绝；logout/过期关闭；新会话重连、UID replacement 与未知结果正确 | 真实 K3s＋真实浏览器＋慢消费者/代理断链；协议和会话记录                                                                                                      |
| S7-A17 / 10、F37     | 关键词/下载范围与实际 source 一致，脱敏后检索，轮转/Pod 删除/previous/SSE 中断/超限提示；无界限下载和 PostgreSQL 原文累积不存在                       | API/SSE 限额测试＋浏览器下载内容/大小/来源、服务端内存/连接清理                                                                                              |
| S7-A18 / 10、UX      | 完整模板→配置→Git→日志/终端→回滚链；IME Enter/Esc、终端 Ctrl 键、focus return、隐藏 tab/注销清理；明暗/窄屏/缩放与日志稳定                            | 生产构建产物清单＋浏览器资源/通道记录：初始服务页没有 CodeMirror/xterm 请求，首次激活才加载，明确连接仅创建一个 session，切目标不混入晚到输出；键盘/读屏抽检 |
| S7-A19 / 升级        | 新迁移能在 S6 基线上应用；引用/版本约束、tombstone/清理和回退限制正确；既有业务字段/密文/目标不被改写                                                 | 隔离 PostgreSQL 升级/非法 SQL 检查，按约定窗口的实际升级记录                                                                                                 |
| S7-A20 / 退出        | S3/S5/S6 与 G-MVP 的既有边界继续通过；没有未知执行被误标取消、旧任务改投目标、数据保护回退或假在线 UI                                                 | 对改动相关回归一次完整复验；最终阶段记录通过项、失败项与未测集成                                                                                             |

测试按调用方 Interface 写有意义的成功/失败/竞态验证，优先覆盖版本兼容、秘密保留、依赖/删除竞态、部分应用、产物/目标身份和真实命令结果，不为每个 UI 包装函数复制实现断言。隔离数据库测试不接触公共 schema；真实运行面与浏览器动作由 root 授权窗口统一调度，使用项目约定的 Node 24（`pnpm exec node`）与 `NODE_OPTIONS=--max-old-space-size=1536`，保持一次一个重型进程。

S7 退出要求为 S7.01–S7.10 各有真实产品路径和上述对应证据，F26–F32 均完成，F37/F39 清楚记录本阶段完成范围。拟交付 `docs/configuration-schema.md`、`docs/acceptance/S7.md` 及有时间/版本/资源身份的结果文件；未执行的实验、静态 Stitch、单元替身或受控外部 API fixture 不能记成真实外部集成成功。**截至本文提交，S7 仍仅为方案，以上实现与验收均未完成。**
