# S5 Storage、Database 与 Templates API 契约

日期：2026-10-26。状态：**已实现接口契约**。字段已接入 API DTO/OpenAPI 与生成客户端；公共本地库升级、真实持久化、连接注入和删除保留已经验证，恢复与最终交付进度见 [S5 验收](acceptance/S5.md)。精确字段以本阶段领域 contracts、API DTO/OpenAPI 和生成客户端同时一致为准，不手工修改 generated api-client schema。

范围为 S5：独立卷、单实例数据库、五类基础模板、同环境有限连接引用，以及手工备份恢复的维护互斥与记录。Git 构建、通用变量引用、备份计划、自动导出/上传/下载、平台恢复任务和密码/主版本维护不在本契约中。

依据：[S5 领域方案](s5-storage-implementation.md)、[UI 实施说明](s5-ui-implementation-notes.md)、既有 S1–S4 契约。

## 1. 公共约定

- 下列路径均相对 `/api`。沿用会话 Cookie、严格 Origin/CSRF、Problem Details、审计和恢复只读保护。
- 单对象读取使用 `{ data: T }`。独立资源列表使用 `{ data: T[], page: { hasMore, nextCursor } }`，`limit` 默认 50、最大 100。`search/projectId/environmentId/clusterId` 等筛选在完整数据集合中执行。
- 修改请求的 `revision` 对应目标资源；挂载/数据库绑定修改中的 `revision` 对应 Service。请求需同时核对卷版本时使用 `volumeRevision`。
- 异步意图要求 `Idempotency-Key`，返回持久 Operation/Deployment。同键同请求返回原结果，同键不同请求返回 409。`POST /services` 的模板分支返回 201，但同样强制持久幂等，避免重复创建服务、卷、数据库身份或凭证。
- 只读 POST 预览不创建 Operation、不分配资源 ID、不生成密码。预览摘要不能代替提交与执行时的重新核验。
- 所有实际目标由 `Environment → Project → Cluster` 派生。客户端不能提交 Namespace、PVC 名、节点或替代 Cluster 覆盖这个目标。
- 字节数使用十进制字符串；未采集的容量/用量为 `null`。申请容量、PV 报告容量、实际用量、节点可用空间和硬配额能力分别展示。
- 时间为 ISO 8601 UTC。观察过期、记录未知、后台任务终态和资源实际状态分别表达。
- 请求失败保留草稿。字段错误、完整资源阻止原因与活动任务须可定位；读取失败或列表截断不能推导为“无引用/无人挂载”。
- 恢复只读锁禁止所有非 GET 请求，包括没有资源副作用的 POST 预览。

Console 的受控契约验收记录见 [S5 Console 受控验收](../apps/console/tests/artifacts/s5-interface/README.md)。该记录明确区分界面夹具检查与真实基础设施验收。

## 2. HTTP 路径与响应

### 2.1 存储能力、卷与维护

| 方法与路径                            | 输入/筛选                                                                  | 返回与副作用                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET `/clusters/:id/storage`           | —                                                                          | `ClusterStorageDto`；真实 StorageClass、支持限制与观察时效                    |
| GET `/volumes`                        | `limit/cursor/search/projectId/environmentId/clusterId/serviceId/retained` | `VolumeDto[]`；含保留卷，按完整集合筛选                                       |
| GET `/volumes/:id`                    | —                                                                          | `VolumeDto`；确认销毁后保留可读 tombstone                                     |
| POST `/volumes`                       | `environmentId, name, slug, storageClassName, requestedBytes`              | 202，`data: { volumeId, operation: OperationDto }`                            |
| POST `/volumes/:id/sync`              | `{ revision }`                                                             | 202，`OperationDto`；只读观察，不创建/修复 PVC                                |
| POST `/volumes/:id/deletion-preview`  | `{ revision }`                                                             | 200，`VolumeDeletionPreviewDto`；无远端写入                                   |
| DELETE `/volumes/:id`                 | `revision, confirmation`                                                   | 202，`OperationDto`；确认对象、UID、回收策略和预览摘要，执行时再检查          |
| POST `/volumes/:id/maintenance/enter` | `revision, purpose`                                                        | 202，`OperationDto`；建立独立持久维护记录，`purpose` 为 `backup` 或 `restore` |
| POST `/volumes/:id/maintenance/exit`  | `revision, maintenanceId`                                                  | 202，`OperationDto`；核对原维护记录、helper 已退出及实际挂载后解除            |

独立卷创建是真实异步操作，不能用“保存挂载草稿”描述。创建受理后立即使用返回的 `volumeId` 导航并展示 Operation；不得由 UI 拼 UUID 或猜测 PVC 名。`WaitForFirstConsumer` 的 PVC 创建任务可成功而卷仍为 Pending，创建消费者不能以 Bound 为前置条件。

`confirmation` 绑定服务端返回的 `volumeId/pvcUid/reclaimPolicy/previewDigest`；可空 UID 仅用于后端已确认从未尝试远端创建的纯元数据撤销。用户同时输入完整卷名确认影响范围。预览过期、UID/回收策略变化、未知占用、维护中或新引用出现均须重新审阅。

### 2.2 挂载草稿

| 方法与路径                                    | 输入                                                      | 返回与副作用                                                                      |
| --------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------- |
| GET `/services/:id/volume-mounts`             | —                                                         | `{ data: VolumeMountDto[], serviceRevision, configRevision }`；服务相关集合上限 8 |
| POST `/services/:id/volume-mounts`            | `revision, volumeId, volumeRevision, mountPath, readOnly` | 200，更新后的有界集合及 Service/config revision；仅保存草稿                       |
| DELETE `/services/:id/volume-mounts/:mountId` | `{ revision }`                                            | 200，同上；标记草稿解除，不直接卸载 Pod                                           |

新建与挂载是两步。卷创建成功但保存挂载失败时，保留返回的卷身份和创建任务，只重新审阅/提交挂载，不能重新创建卷。草稿卸载、已发布引用、实际 Pod 占用分开显示；停止服务仍保留已发布挂载。实际卸载确认前保留占用和关联，不将从列表消失当作卸载成功。

可写本地卷应用限定单副本 Recreate，发布预览说明中断。数据库数据卷只能通过原数据库身份与受保护布局使用；通用挂载表单不能绕过数据库保护。

### 2.3 数据库与连接草稿

| 方法与路径                                          | 输入/筛选                                                                          | 返回与副作用                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET `/databases`                                    | 标准分页、`search/projectId/environmentId/clusterId/serviceId`；同环境连接候选筛选 | `DatabaseDto[]`；默认包含孤立保留实例                                                                                    |
| GET `/databases/:id`                                | —                                                                                  | `DatabaseDto`；ID 是 DatabaseInstance 的稳定身份                                                                         |
| GET `/services/:id/database`                        | —                                                                                  | 当前服务的 `DatabaseDto`；不作为保留实例的唯一入口                                                                       |
| GET `/services/:id/database-bindings`               | —                                                                                  | `{ data: DatabaseBindingDto[], serviceRevision, configRevision }`；最多 16 条草稿与历史发布的合并引用，期望绑定最多 8 条 |
| POST `/services/:id/database-bindings/preview`      | `revision, databaseInstanceId, profile, mapping`                                   | 200，`DatabaseBindingPreviewDto`；返回变量差异、引用与阻止原因，不返回秘密                                               |
| POST `/services/:id/database-bindings`              | 同一份已审阅的绑定输入                                                             | 200，更新后的有界集合及 Service/config revision；仅保存消费者草稿                                                        |
| DELETE `/services/:id/database-bindings/:bindingId` | `{ revision }`                                                                     | 200，同上；仅解除草稿中的依赖                                                                                            |
| POST `/services/:id/deletion-preview`               | `{ revision }`                                                                     | 200，`ServiceDeletionPreviewDto`；保留卷、数据库消费者与阻止原因                                                         |

候选筛选由后端以消费者的项目、环境、集群和提供方发布/认证事实核对。跨环境、不再有服务、未就绪、观察过期或身份变化的实例不能成为可连接提供方。搜索/分页不能静默遗漏仍有效的同环境候选。

`profile` 区分字段注入与受控 URI 注入；`mapping` 是固定输出键到变量名的映射。PostgreSQL 输出限于 host/port/database/user/password，Redis 限于 host/port/db/password；受控 URI 整体视为秘密。公开预览只包含输出键、变量名、脱敏引用和非敏感资料。变量冲突返回字段级错误，不自动覆盖手工变量。

保存连接草稿不发布、不重启消费者。发布时固定提供方身份、输出与凭证版本；新事实只产生待发布变化，不热更新运行中的 Pod。数据库删除审查列出仍被草稿、当前已发布快照和在途消费者使用的依赖。

### 2.4 模板与服务创建

| 方法与路径                    | 输入/筛选                                                  | 返回与副作用                                                          |
| ----------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| GET `/templates`              | 标准分页、`search/category`                                | `TemplateDto[]`；固定目录，恰好五类 S5 模板                           |
| GET `/templates/:id`          | 可选固定 `version`                                         | `TemplateDto`                                                         |
| POST `/templates/:id/preview` | `environmentId, version, parameters`                       | 200，`TemplatePreviewDto`；只读配置/影响预览                          |
| POST `/services`              | 公共服务资料及 `configuration` 或 `template`，两者严格互斥 | 201，`ServiceResponseDto`；模板分支强制 `Idempotency-Key`，不自动部署 |

模板输入使用单个嵌套字段：

```json
{
  "environmentId": "<environment-id>",
  "name": "应用数据库",
  "slug": "app-db",
  "template": {
    "id": "postgresql",
    "version": "<catalog-version>",
    "parameters": {}
  }
}
```

`configuration` 与 `template` 不能同时出现，也不能都缺失。既有镜像创建保留原 configuration 形状。模板分支由服务端依据固定目录解析参数并同事务生成 Service、Volume 意图、DatabaseInstance 与凭证引用；返回持久分配的真实 ID。预览不生成这些对象，客户端不能将预览中的计划说明当作真实引用回传。

固定模板 ID 为 `docker`、`node-example`、`static-example`、`postgresql`、`redis`，初始目录版本为 `1.0.0`。目录标准分页，当前最多五项。`TemplateParameters` 的允许键为 `image/port/requestedBytes/username/databaseName/redisDatabase`，每个模板只接收其声明的子集。目录返回有限参数 schema（name/label/description/type/required/defaultValue/minimum/maximum）、资源默认值、controller、persistent、notes，以及 image 的 reference/digest/version/platforms/verifiedAt；Docker 自选镜像的 image 元数据为 null。Node.js/静态模板使用已核验的预构建示例镜像，不宣称接入 Git 构建。数据库模板由后端生成凭证，不提供任意现有数据库 Secret 或任意镜像输入来绕过保护。

### 2.5 手工备份/恢复记录

| 方法与路径                              | 输入/筛选                                                                                    | 返回与副作用                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| GET `/volumes/:id/manual-data-records`  | `limit/cursor/type`                                                                          | `ManualDataRecordDto[]` 与标准 page                             |
| POST `/volumes/:id/manual-data-records` | 类型、稳定 backupId、源/新目标、格式/版本、大小/SHA256、数据时间点、位置标签、结果与证据引用 | 201，`ManualDataRecordDto`；保存有界元数据/审计，不执行数据操作 |

路径中的 `:id` 固定为 `source.volumeId`，备份和恢复记录统一保留在源卷记录簿。`type` 区分 `backup` 和 `restore`，backupId 为工具清单中稳定的 UUID；恢复记录选择源卷已登记的 backupId 及明确的新目标。恢复校验原清单的 engine/engineVersion/dataLayout/format/sizeBytes/sha256 不变，toolVersion 记录本次执行工具版本。`verificationSource` 固定返回 `operator_reported`，不能由请求设置 `platformVerified`。完整性验证、恢复数据验证、平台运行观察分别记录，手填“成功”不更改数据库的真实 ready 状态。

位置是脱敏显示标签，不是服务器要读写的任意路径。记录接口不上传/下载文件、不创建 BackupSchedule，也不执行 pg_dump、归档、导入、消费者发布或流量切换。S5 的 runbook 和受控辅助工具另行产出真实清单及验证报告。

## 3. 公开读取对象的必要字段

公开字段以 [Storage contracts](../packages/control-plane/src/storage/contracts.ts) 与 [Database/Template contracts](../packages/control-plane/src/databases/contracts.ts) 为准。下列 shape 已在领域层落盘；DTO/OpenAPI 生成后，Console 使用生成类型发请求。领域对象中的 `View` 对应下面的响应 DTO，标准 `Envelope`/`Page` 约定不变。

### `ServiceResponseDto` 增量

配置本体仍为既有 image/replicas/ports/environment 等字段。小量只读 metadata 增加：

```ts
controller: { kind: 'Deployment' | 'StatefulSet'; strategy: string };
template: { id: string; version: string } | null;
databaseInstanceId: string | null;
```

详细挂载/绑定由独立有界 GET 返回，不把大量卷和数据库观察塞进服务列表。v2 snapshot 固定卷、数据库引用及 controller 判别；旧 Deployment 读取兼容。StatefulSet UID 不能写入名为 replicaSetUid 的字段，日志与运行界面按实际 controller 判别。

### `ClusterStorageDto`

- `clusterId/capabilities/storageClasses/observedAt/stale/lastAttemptAt/errorCode`；capabilities 为 null 或实际观察对象，包含 `truncated/provisioner/permissions/issues`。
- `storageClasses`：name、UID、provisioner、bindingMode、reclaimPolicy、支持状态和具体原因。
- local-path 的 `hardQuotaSupport` 为 `unsupported`；真实节点可用空间没有采集时为 `null`，不由 Node allocatable 或卷申请量推算。
- 能力与支持范围来自目标集群观察；存在名为 local-path 的 StorageClass 不直接等于可安全创建/销毁。

### `VolumeDto`

- `id/name/slug/revision`，`project/environment/cluster` 为可空 `{ id, name, slug }`，`namespace` 固定归属；`desiredState` 为 `active/destroying/destroyed`，另有 `retained/destroyedAt/createdAt/updatedAt`。
- `requestedBytes/hardQuotaSupport`；pvc 的固定 name/UID/phase，pv 的 name/UID/capacityBytes/reclaimPolicy/nodeAffinity，storageClass 的固定身份及真实属性。
- `nodes` 与明确 locality 状态；等待首次消费者、已核对节点、节点不可达与观察未知不能混为一种空数组。
- `usage`：usedBytes、nodeAvailableBytes、observedAt；未采集值为 null。
- `mounts`：desired/published/actual 分组，稳定 mount/service/Pod 身份、路径、读写性及完整性/truncated。后端完整检查结果不能由 UI 从局部列表推导。
- `observation`：state/observedAt/stale/code/message；“创建任务已完成”和“PVC 已绑定/数据库可用”分开。
- `maintenance` 为 null 或独立记录：`id/purpose/state/revision/enteredAt/expiresAt/releasedAt/overdue/lastErrorCode/exitBlockers`。state 为 `entering/active/exiting/failed/closed`；overdue 独立标记，超时不自动解锁，activeTask 结束不自动清除此记录。
- `activeTask/deletionBlockers/lastManualBackupRecord/lastAttemptAt/lastErrorCode/lastErrorMessage`；`retainedDatabase` 为 null 或 `{ id, serviceId, engine, majorVersion, initializedAt, initializationFenceAt }`。
- `manualDataIdentity` 为 null 或真实 `{ installationId, clusterId, kubeSystemUid, environmentId, volumeId, pvcUid }`，仅目标完整且 PVC UID 已知时返回；手工记录源/新目标由此取值，UI 不要求操作者抄写内部身份。

### `VolumeMountDto`

包含稳定 `id/serviceId/volumeId`、`mountPath/readOnly/desired`、`lastPublishedDeploymentId/detachedAt` 及显示所需卷/服务摘要。解除草稿不删除待实际卸载的记录。服务集合返回的 `serviceRevision/configRevision` 是下一次草稿操作依据。

### `DatabaseDto`

- 稳定 DatabaseInstance `id/revision`，`service: { id, name, slug } | null` 与不可空 `originalService: { id, name, slug }` 分开；`projectId/environmentId/clusterId` 保留精确归属，不能从原服务名称反推关系。
- `dataVolume: { id, name, namespace, pvcName, pvcUid, requestedBytes, destroyedAt }`；`engine/majorVersion/exactVersion/template` 固定数据库资料。
- `protection: { active, revision, fencedAt, lockedFields, reason }` 与 `initialization: { state, initializedAt, pvcUid }` 分开；initializedAt 只说明曾确认初始化，保护版本、fence 时间、受保护字段和阻止原因决定是否允许候选修改。
- 保护最迟在首次 PVC 创建意图或可能写入数据库前建立；未知、首次发布失败、取消、服务删除均不能回到无保护的新库状态。
- `databaseReady/observationStale` 与 Service runtimeState 分开；`observation` 为 null 或 `{ state: ready|failed|unknown, authenticated, engineVersion, persistence: postgres_wal|redis_aof_everysec|unknown, podUid, pvcUid, observedAt, code, message }`。存储、认证/引擎验证及 Redis AOF 观察有各自时间和状态。
- `connection: { host, port, username, database, redisDatabase, visibility: cluster_private }` 和 `credential: { refId, contentRevision }` 只含非敏感资料；`consumers` 每项有 `serviceId/name/desired/published/inFlight`，`consumersTruncated` 明示截断。不返回密码、含密码 URI 或原始认证诊断。
- 孤立保留实例仍可读取保护资料，但没有可用提供方时不得显示可连接状态。默认私有不等于已验证环境间 NetworkPolicy 强隔离。

### `DatabaseBindingDto` / `DatabaseBindingPreviewDto`

绑定包含 `id/databaseInstanceId/profile/mapping/revision/desired/published/issues`；`provider: { serviceId: string|null, name, engine, ready }`。预览精确返回 `databaseInstanceId/profile/mapping/variables/issues/serviceRevision`，variables 每项为 `{ name, output, secret, change: add|replace }`。issues 每项为 `{ code, message, field: string|null, blocks: save|deploy|both|none }`。连接值不作为可复制的明文连接串出现。

### 删除预览

`VolumeDeletionPreviewDto` 返回具体 Volume/PVC/PV、数据用途、实际回收策略、观察时间、最近手工记录、blockers 和 previewDigest。S5 自动销毁仅支持已验证 provisioner 与实际 Delete 策略；Retain、策略漂移和未知结果明确阻止。404 只证明资源对象不存在，不证明物理安全擦除。

`ServiceDeletionPreviewDto` 返回 `serviceId/revision/retainedVolumes/databaseConsumers/blockers/dataRetentionMessage`。retainedVolumes 每项为 `{ id, name, pvcUid, databaseInstanceId }`；databaseConsumers 每项为 `{ serviceId, name, desired, published, inFlight }`。服务停止/删除保留 PVC/PV，不因 PV 策略为 Delete 就在服务删除时删除 PVC；这与独立卷销毁的实际回收策略是两件事。

### `ManualDataRecordDto`

请求字段精确为 `type/backupId/source/target/engine/engineVersion/dataLayout/format/toolVersion/sizeBytes/sha256/startedAt/completedAt/dataTime/offHostLocationLabel/integrity/verificationSteps/result/evidenceReferences`。source/target 使用 `ManualDataIdentity`；backup 的 target 为 null，restore 明确新目标。dataTime 为 `{ from: string|null, to: string|null, description }`；integrity 为 `passed/failed/unknown`；result 为 `passed/failed/incomplete`。响应额外包含 `id/volumeId/actorId/createdAt/verificationSource/durationMs`，verificationSource 固定 `operator_reported`。

不存在的时间、用量或验证结果为明确未知。Redis TTL 验证记录绝对到期时间或可验证范围；手工记录表单不要求恢复后的剩余秒数等于备份前的数字。

## 4. UI 与任务语义

- templates/create → 保存草稿 → 统一发布；独立 volume/create → 观察创建任务 → 保存挂载草稿 → 统一发布。发布前再次核验版本、能力、占用、数据身份和维护状态。
- 只读预览的 issues 应区分字段错误及阻止保存/发布/具体动作的原因，避免未知能力阻止所有仍合法的元数据编辑。
- StatefulSet、PVC/PV 和认证检查分别展示；不把 Pod Ready、TCP 可达或 PVC Bound 单独显示为“数据库健康”。
- 维护中/未知时保持阻止相关发布、恢复、销毁；显式退出需要原维护记录和实际 helper 清理确认。S5 的数据维护互斥与 F48 密码轮换/主版本升级使用不同文案和入口。
- S5 页面提供手工指引、记录和源/新目标核对；不把 E04 的平台备份中心、E05/E06 的自动恢复/切换操作接入未实现接口。
- 新 API 名称或状态变更须同时对齐本文、领域 contracts、DTO/OpenAPI、生成客户端和 Console，不用本地 UUID、模拟成功或前端推断补齐缺失事实。
