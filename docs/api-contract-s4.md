# S4 Networking API 契约

日期：2026-10-26。状态：已实现并接入本地 API/Worker，真实本地产品与浏览器流程通过；公网验收另见阶段报告。领域类型见 `packages/control-plane/src/networking/contracts.ts`；实际 OpenAPI 由 DTO 生成，不手工修改生成客户端。

继承 S1–S3 的 Cookie/CSRF、Problem Details、revision、恢复只读锁、审计与 cursor 分页。读取响应为 `{ data: T }`，列表为 `{ data: T[], page: { hasMore: boolean, nextCursor: string | null } }`。未初始化设置的 `revision = 0`、`updatedAt = null`；首次 PATCH 提交 revision 0，持久行从 1 起步。

| 方法与路径 | 请求 | `data` / 状态 |
| --- | --- | --- |
| GET `/platform-settings` | — | `PlatformSettingsDto` |
| PATCH `/platform-settings` | `revision, appsDomainSuffix, acmeEmail`，两个字段可为 null | `PlatformSettingsDto` / 200 |
| GET `/clusters/:id/networking` | — | `ClusterNetworkingDto` |
| PATCH `/clusters/:id/networking` | `revision, subdomain, entryAddresses, cnameTarget` | `ClusterNetworkingDto` / 200 |
| POST `/clusters/:id/networking/check` | `{ revision }` | `OperationDto` / 202 |
| POST `/clusters/:id/networking/install-cert-manager` | `{ revision }` | `OperationDto` / 202 |
| GET `/services/:id/networking` | — | `ServiceNetworkingDto` |
| POST `/services/:id/domains` | `{ revision: serviceRevision, portId }` | `OperationDto` / 202 |
| GET `/domains` | 标准 limit/cursor，search/projectId/environmentId/serviceId/clusterId | `DomainDto[]`，完整范围筛选 |
| GET `/domains/:id` | — | `DomainDto` |
| POST `/domains/:id/sync` | `{ revision: domainRevision }` | `OperationDto` / 202 |
| POST `/domains/:id/reconcile` | `{ revision: domainRevision }` | `OperationDto` / 202 |
| POST `/domains/:id/production` | `{ revision: domainRevision }` | `OperationDto` / 202 |
| DELETE `/domains/:id` | `{ revision: domainRevision }` | `OperationDto` / 202 |

以上异步请求均要求 `Idempotency-Key`，同键同请求返回原 Operation，同键不同请求返回 409。重试使用已有 `/operations/:id/retry`，取消使用 `/operations/:id/cancel`；未确认远端清理完成前不提前删除 Domain。创建 Operation 的 `input` 包含持久 `domainId`、`hostname` 和固定目标，可导航到刚分配的域名；不能只显示“HTTPS 已启用”。

DTO 字段以同名领域 View 为准：`PlatformSettingsDto → PlatformSettingsView`、`ClusterNetworkingDto → ClusterNetworkingView`、`ServiceNetworkingDto → ServiceNetworkingView`、`DomainDto → DomainView`。嵌套的 `EligibleHttpPortDto` 含稳定端口 `id`、name、HTTP 类型、已发布 containerPort/servicePort、publishedConfigRevision。当前草稿中的端口数字不作为绑定依据。

ServiceNetworking 的 `blockers` 是可显示的受控 code/message 列表，至少覆盖缺后缀、缺集群入口、未连接、未可信发布、无已发布 HTTP 端口、已绑定默认域名、删除中和在途服务操作。前端禁用按钮用于及时提示，提交时后端仍核对全部条件。每服务 S4 只有一个默认域名，自定义/多域名、Cloudflare 与公网 TCP 按 S8 扩展。

ClusterNetworking 的 `entryAddresses` 为明确的 IPv4/IPv6 列表，`cnameTarget` 可为 null；至少提供一种预期入口。`domainSuffix` 为后端计算的完整集群后缀，不由 UI 拼接作为请求目标。`ingressClassName` 固定为 traefik。已分配域名时，普通 PATCH 修改平台/集群后缀或入口被拒绝并列出影响，避免旧操作在新入口上重放；显式迁移另行实现。

Domain 的 `dns`、`route`、`certificate` 可各自为 null，表示尚无观察。每组都有 `state/observedAt/code/message`，只按该组真实数据渲染；`observationStale` 提示旧观察。`certificateEnvironment` 表示期望签发环境，证书观察中的 environment 表示本次观察对应的配置；staging_ready 永远不显示为公网可信 HTTPS。证书到期日期即便在旧观察中也应按当前时间判断过期。

`activeTask` 使用既有 `{ type, id, kind, status }`，打开正确的部署或操作任务。相同服务的发布、运行操作和域名写操作共享持久变更槽。失败后保留域名与原任务；错误视图提供刷新、任务与符合条件的重试入口。

域名详情/服务网络面板持续展示 project、environment、cluster 和 servicePort。域名解除绑定不会删除手工 DNS、共享 Namespace/Issuer 或其他服务资源。管理入口地址仍由部署环境配置提供，设置页只读展示，不能把应用域名后缀保存成控制台地址。

API 命名或状态在实现中如需改变，必须同时更新本文件、领域契约、DTO/生成客户端和 UI；本页不是另一份手写生成 schema。

`sync` 只读检查远端，既不改绑定目标，也不增加域名意图版本；服务漂移时仍能检查。`reconcile` 是独立的“重新应用绑定”：沿用 Domain ID、hostname 与 portId，以新的任务和域名版本固定当前可信已发布配置及 Service UID，保留现有证书环境。旧失败任务仍不能改用新服务版本重试。只有明确 reconcile 才允许在具名确认旧受管资源已经不存在后登记新 nonce 重建；同名新 UID、外部归属仍拒绝覆盖。

生产签发任务的 `stagingVerification` 持久保留首次通过门槛的证书观察时间、证书到期时间和 DNS 观察时间，重试沿用原证据。接受生产动作前核对两组观察均新鲜、证书未过期且已生效；执行生产写入前还会重新检查 DNS。恢复只读状态不执行网络写入，观察可以保存带代次和资源版本保护的读取结果。
