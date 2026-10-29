# S2 接入 API 契约

实现中。沿用 `/api` 前缀、单管理员会话、CSRF、problem+json、分页及 revision；所有异步请求返回 `202 {data: OperationDto}`，请求必须带 `Idempotency-Key`。同键同请求返回原任务，改变请求返回 409。异步任务受理不等于远端成功。

| 方法与路径 | 请求体 | 响应 |
| --- | --- | --- |
| POST /servers/:id/discover-host-key | `{revision}` | Operation，kind=ssh_discover；认证前完成指纹发现 |
| POST /servers/:id/trust-host-key | `{revision,discoveryOperationId,fingerprint,source}` | 200 ServerEnvelope；source 为独立可信来源说明 |
| POST /servers/:id/preflight | `{revision}` | Operation，kind=server_preflight |
| POST /servers/:id/initialize | `{revision,clusterId,nodeName,apiEndpoint}` | Operation，kind=server_initialize；clusterId 为已有空白登记 |
| GET /servers/:id/nodes | 分页 limit/cursor | NodeList；包括关联 Cluster 摘要，不从历史任务推导归属 |
| POST /clusters/:id/connection-preview | `{revision,credentialRefId?,apiEndpoint?}` | 200 ConnectionPreviewEnvelope；本地严格解析，不执行远端连接 |
| POST /clusters/:id/connect | `{revision,credentialRefId?,apiEndpoint?,acceptedCaFingerprint?}` | Operation，kind=cluster_connect |
| POST /clusters/:id/sync | `{revision}` | Operation，kind=cluster_sync |
| GET /clusters/:id/nodes | 分页 limit/cursor | NodeList |
| GET /operations | 新增可选 serverId / clusterId | 既有 OperationList |

候选凭证先通过既有 `POST /secrets` 加密保存：SSH payload 为 `{privateKey,passphrase?}` 或 `{password}`；Kubernetes payload 为 `{kubeconfig:string}`。普通 API、任务输入/结果、队列和日志不返回明文凭证。

Server 详情新增 `initializationVersion`、`hostKey:{trustedFingerprint,trustedAt,trustSource,observedFingerprint,observedAlgorithm,observedAt,discoveryOperationId}`、`machineId`、`preflight:SshPreflight|null`、`preflightAt`、`lastAttemptAt`、`lastErrorCode`、`lastErrorMessage`、`lastOperationId`。未独立确认指纹前不能认证；预检保留机器身份，新的机器必须另行登记。初始化要求近期通过预检并固定 installationId、机器身份、Cluster、nodeName、API 地址；重试复用这些值。

Cluster 详情新增 `identity:{kubeSystemUid,caFingerprint}|null`、`observation:KubernetesInspection|null`、`observationStale`、`nodeCount`、`lastAttemptAt`、`lastErrorCode`、`lastErrorMessage`、`lastOperationId`。Node 列表条目为安全 KubernetesNodeSnapshot 加 `id,clusterId,serverId,present,lastObservedAt,cluster:{id,name,slug,connectionStatus,lastObservedAt}`。Node 用 clusterId + Kubernetes UID 标识；机器 ID 的唯一匹配才能关联 Server。

ConnectionPreview 为 `{apiEndpoint,caFingerprint,currentCaFingerprint,requiresCaConfirmation,credential:KubernetesCredentialSummary}`。已绑定 CA 变化时，界面显示旧、新摘要，管理员明确提交精确 `acceptedCaFingerprint`；Worker 仍验证 TLS/SAN 和原 kube-system UID。不同 UID 永远拒绝原地替换。

同一 Server/Cluster 同时最多一个 queued/running Operation，由 PostgreSQL 部分唯一索引保证。活动任务期间禁止改目标/移除登记；终态历史不永久阻止移除。认证在执行/重试时读取当前有效引用；连接验证请求使用明确的候选引用。候选验证失败不覆盖已生效的 Cluster 凭证。

观察在单独、有界并发的 Worker 循环中执行，不被长时间初始化阻塞；每集群有数据库租约和连接 revision/generation 发布校验。失联保留上次观察时间，指标未知保持 null，不能转换成 stopped 或零值。能力发现与真实 HTTPS/PVC 验收分开；工作负载仅只读摘要，远端标签不证明平台所有权。

取消等待 Worker 确认停止；已发生的安装和远端变更保留。恢复只读锁、租约失效或旧 generation 禁止提交结果和继续发起远端变更。真实云端网络/SSH/权限验收仍待用户准备 VPS。
