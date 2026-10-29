# S3 服务、发布和运行 API

实施契约，2026-10-26。本文件描述已实现的服务与镜像 API，完整验收状态以 S3 验收记录为准。认证、同源 CSRF、错误格式和游标分页沿用 S1/S2。资源编辑与服务变更使用 `revision`，异步创建/重试使用 `Idempotency-Key` 并返回 `202`，不会等待远端网络操作。

## 服务与配置

- `GET /services?projectId=&environmentId=&clusterId=&search=&cursor=&limit=`：`{ data: ServiceView[], page }`。
- `POST /services`：`{ environmentId, projectId?, name, slug, description?, registryCredentialRefId?, configuration }`，返回 `201 {data: ServiceView}`。
- `GET /services/:id`：`{data: ServiceView}`。
- `PATCH /services/:id`：`{revision, name?, description?, environmentId?, projectId?, registryCredentialRefId?, configuration?}`，返回更新后的视图。
- `POST /services/parse-env`：`{text}`，返回 `{data:{variables:[{name,value,secret,line}],issues:[{line,code,message}]}}`。只解析本次提交的文本，不保存、不展开 shell 或变量引用。

服务始终由 Environment→Project 继承 Cluster，不接收独立 clusterId。已有远端资源后不可通过 PATCH 移动环境；此前只允许移动到同项目环境。名称与 URL slug 分开，slug 创建后固定。

`configuration` 字段：

```ts
{
  image: string;                        // tag 或 sha256 digest；最终发布固定 digest
  replicas: number;                     // 1..20；停止不把配置副本改成 0
  command: string[];
  args: string[];
  ports: {name: string; protocol: 'http'|'tcp'; containerPort: number; servicePort: number}[];
  resources: {requests: {cpuMillis: number; memoryMiB: number}; limits: {cpuMillis: number; memoryMiB: number}};
  environment: ({name: string; value: string; secret?: boolean} |
                {name: string; secretRefId: string; secretKey: string})[];
  readiness: Probe | null;
  startup: Probe | null;
  healthTimeoutSeconds: number;         // 10..900，默认 300
}
type Probe = {type:'http'|'tcp'; port:string; path?:string; initialDelaySeconds:number;
              periodSeconds:number; timeoutSeconds:number; failureThreshold:number};
```

配置输入允许省略 image 之外的字段，服务保存后返回完整默认值。最多 16 个具名端口、128 个变量、64 项命令/参数；配置和解密后变量各有 24 KiB 上限。端口、探针、资源限制的服务端验证是权威。HTTP 探针引用具名端口与容器内绝对路径，TCP 探针没有 path。

命令/参数单项最多 4 KiB UTF-8，变量单值最多 16 KiB；秘密转为引用后再次检查保存配置的 24 KiB 上限。端口名可由数字开头，但必须含字母且不能有连续连字符；内部 Service 端口唯一，不同名称可指向相同容器端口。

`secret:true` 的明文只在写入请求中出现，事务内生成加密的 generic SecretReference；响应仅有 secretRefId/secretKey。草稿和历史 Deployment 的运行期秘密都有外键保护，历史配置固定原秘密版本。Registry/Kubernetes 认证使用当前有效引用，不能从旧配置恢复旧认证。

ServiceView 类型位于 `packages/control-plane/src/services/contracts.ts`，包含固定项目/环境/集群摘要、configuration 草稿、configRevision、published 完整应用快照、lastSuccessfulDeploymentId、desiredState、configurationState、runtimeState、activeTask、真实 observation 与时效。`published` 可能属于健康等待失败的部署；不能以最近成功版本替代。观察失联保留快照，过期时 runtimeState 为 unknown。

## 发布与操作

- `POST /services/:id/deployments`：`{revision, deployAndStart?, allowConfigurationRepair?}` → `202 {data: DeploymentView}`。
- `GET /deployments?serviceId=&projectId=&environmentId=&clusterId=&status=&cursor=&limit=`、`GET /deployments/:id`：历史与详情。详情含固定 target、snapshot、resolvedImage、stages、appliedAt，以及错误和重试来源。
- `GET /deployments/:id/logs?cursor=&limit=`：持久任务日志。镜像发布没有构建日志，明确标为不适用。
- `POST /deployments/:id/cancel` → 当前 Deployment；`POST /deployments/:id/retry {revision,deployAndStart?,allowConfigurationRepair?}` → 新 Deployment。
- `POST /services/:id/restart|stop|resume {revision}`、`DELETE /services/:id {revision}` → `202 {data: OperationView}`。
- Operation 沿用 `/operations/:id`、`/logs`、`/cancel`、`/retry`；任务类型为 `service_restart|stop|resume|delete`，输入明确固定 Service/项目/环境/Cluster/Namespace。

服务变更共用一个持久槽位，发布与操作不能并行覆盖。草稿保存不写 Kubernetes。停止归零并保留完整配置；恢复只使用可信 published 模板及其副本数，不应用草稿。部分应用或外部漂移时允许停止，拒绝重启/恢复，需明确完整重新发布或完成可信对账。停止服务的发布必须 `deployAndStart:true`，修复不一致配置必须 `allowConfigurationRepair:true`；控制台在差异预览中明确确认。

重试只允许失败/取消的原记录，保留原配置、目标和已解析 digest；后续变更已取代原任务时拒绝从旧任务直接重放。原产物不存在会失败，不重新解释移动的 tag。任务终态不会随应用后续健康变化改写。

Deployment 顶层 `failureObservation` 为失败当次的历史证据或 `null`，包含 attempt、errorCode、capturedAt/observedAt、配置一致性、最多 128 条差异/64 条资源/32 个 Pod 身份与各自截断标记。它不包含原始容器配置、环境变量或事件消息，后续 Service 观察不会覆盖。`result` 仅在完整应用后返回 published/image/appliedAt 等结果；应用前失败可以有 failureObservation，但 result 和 appliedAt 仍为 null。服务删除后，任务继续保留原始 target 与历史结果。

## 运行观察与日志

- `GET /services/:id/pods`：当前服务观察内的受管 Pod、容器、UID、快照、状态与重启/OOM；附 observedAt、stale、truncated。
- `GET /services/:id/metrics`：真实当前 CPU/内存及来源时间；不可用保持 unknown/null。
- `GET /services/:id/logs?podUid=&container=&previous=&tailLines=&follow=`：受控 Pod 日志 SSE；不接收任意 Namespace/Pod 名称。默认 previous=false、follow=false、tailLines=200，tailLines 最多 1000。

流事件为 `event: log`、`data: {"text":"..."}`，结束为 `event: end`、`data: {"reason":"...","message":"..."}`。结束原因是 eof、duration_limit、byte_limit、source_error 或 access_changed。每次最多持续 60 秒，原始输入和编码后 SSE 分别最多 1 MiB，同账号最多 4 个连接；HTTP 下游另有 65 秒截止时间。

连接建立前后都核验 Pod UID、所属 ReplicaSet 与快照，避免名称复用；已知运行期秘密按该 Pod 的固定快照跨分片脱敏，无法验证快照时拒绝读取。每 5 秒检查会话、凭证 revision、目标与恢复 generation；切换、注销、断开或截止会回收上游和背压等待。公网域名/HTTPS、PVC/数据库、Git 构建、回滚与终端分别在后续阶段验收。
