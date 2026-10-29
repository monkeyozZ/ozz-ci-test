# S2 Kubernetes Adapter 与 B04 SDK 验证

验证日期：2026-10-25。环境：项目 Node 24.22.1、`@kubernetes/client-node` 2.0.1、两套 Lima VZ / Ubuntu 24.04 ARM64 / K3s v1.35.9+k3s1。此记录证明本地真实运行面的连接与 SDK 协议行为；真实 VPS、Oracle 容量、公网入口、持久卷和 S3 日志产品尚未由本记录验收。

[Adapter 入口](../../packages/infrastructure/src/kubernetes.ts)仅公开安全解析、连接检查与具名结果。[契约](../../packages/infrastructure/src/kubernetes/contracts.ts)不依赖 Prisma、Nest 或框架请求对象。API/Worker 的事务、身份更新确认、任务租约和观察结果持久化由控制面负责。

## 已实现的连接能力

`parseKubeconfig(raw, { endpointOverride? })` 接受直接 HTTPS API 与嵌入式 CA、客户端证书/私钥或 Token。拒绝插件、文件引用、代理、身份冒充、用户名密码、跳过 TLS、重复 YAML 键、别名及未支持字段，未使用的上下文同样检查。控制台地址替换仍须通过新地址的真实 CA/SAN 校验；当前不接受带路径前缀的 API 代理地址。

解析结果可以安全序列化。PEM、私钥和 Token 留在 Module 私有 WeakMap，不能通过结果对象或异常展开；另一个进程必须重新解析解密后的原始凭证。返回 CA 摘要、客户端证书有效期及 Token 的声明到期时间。JWT 的 `exp`/`nbf` 是未经签名验证的提示，认证以 Kubernetes API 为准：实际探针曾遇到新 Token 的 `nbf` 稍晚于 Mac 时钟，本地提前拒绝会误判，现已移除该判断并增加回归。X.509 与 CA 仍严格验证时间、链和主机名。

`inspect(connection, { signal, expectedIdentity })` 每次创建独立官方 SDK Configuration 和受限 HTTPS transport，不读取默认 kubeconfig，不共享凭证或全局认证缓存。请求不跟随重定向、不使用环境代理、不解压任意响应；默认单请求 15 秒、整次检查 60 秒、单响应 4 MiB、整次响应 16 MiB、每次检查的 Agent 最多 4 个连接，结束或取消销毁所拥有的 sockets。

普通连接检查同时校验已记录的 `kube-system` UID 与 CA。上层经过明确确认的 CA 更新可只指定原 UID，随后仍通过新 CA 的实际 TLS 验证；不同 UID 始终不能覆盖原集群。检查不自动安装软件或写入工作负载。

观察结果包括：

- Node UID、架构、Ready/压力条件、capacity/allocatable 与真实 Metrics。数量有上限且分页一致；缺失、过旧或与 Node 身份不符的指标为 `null/unknown`。磁盘容量不表示使用率。
- 实际请求与 SelfSubjectAccessReview 的权限记录。`clusterWideAdmin=true` 表示广泛权限，不能宣传为最小权限。
- IngressClass、固定 `kube-system/traefik` Deployment 的 generation/副本就绪结果，以及默认 StorageClass、provisioner、绑定和回收策略。发现配置不等于已验证公网路由或 PVC 读写；403、404 与未知分别记录。
- Deployment、StatefulSet、DaemonSet、Job、CronJob、Pod 的只读预览，每类最多 100 项。未读到的集合数量为 `null`；截断预览不冒充总数。不返回原始规格、环境变量、日志或 Secret。`managedBy` 只表示观察到的标签，真实平台归属必须与数据库核对。
- Kubernetes 标准 API 无法证明集群静态加密，结果保留 `unknown`，由独立 SSH 安装/维护证据补充。

## 验证证据

| 证据                                                                                                                                 | 结果与适用范围                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [TLS/协议边界测试](../../tests/infrastructure/kubernetes.test.ts)、[机器报告](../../tests/probes/results/kubernetes-boundaries.json) | 17/17 通过。实际本地 TLS/mTLS 服务验证 CA/SAN、同名凭证隔离、替换、重定向拒绝、取消/超时关闭、body/分页上限、权限/指标缺失、工作负载脱敏；429/410/503 等由协议 fixture 注入，不声称是集群自然限流 |
| [真实 SDK 探针](../../tests/probes/kubernetes-sdk.mjs)、[机器报告](../../tests/probes/results/kubernetes-sdk.json)                   | 11 项完成。两套真实 API 的同名 Node/Namespace 对应不同 UID/CA；真实 ServiceAccount 删除撤销旧 Token 后更新恢复；Watch 断开后补收遗漏修改；实际 API 返回 410 后重新 list 成功                      |
| 日志与 Exec                                                                                                                          | 原生有限日志慢消费者完成；受控 HTTPS/pipeline 取消后 source/sink 关闭；Exec 实际传输 2 MiB，正常流与主动断开时均低于探针 256 KiB 缓冲上限，并关闭 WebSocket；单消息大小和握手时间也有显式上限     |
| 清理                                                                                                                                 | 本轮 Pod、ServiceAccount、ClusterRole、ClusterRoleBinding 和两套同名 Namespace 均用创建时 UID 作为删除前置条件，删除后读取 404 确认。未停止 A/B 虚拟机，未清理既有用户资源                        |

具体采样时间、缓冲峰值和耗时见机器报告。完整探针耗时包含凭证撤销传播与资源清理，不是控制面容量基准。流测试复用本地已经运行的 Traefik 镜像固定 digest，只执行隔离 Pod 内的 shell；它不验证外部镜像拉取。首次 BusyBox 测试 Pod 未在期限内就绪，未用该次尝试宣称镜像部署通过。

## 已确认的 SDK 限制与后续实现约束

原生 `Log.log(..., { follow: true })` 的上游 Readable 没有完整的错误传播。探针在独立子进程中先建立真实日志连接，再取消；确认出现未处理的 AbortError，进程退出码为 1。报告的 `passed: true` 表示探针完成了包括缺陷确认在内的断言，**不表示原生 live Log helper 满足生产要求**。

S3 的持续日志必须采用拥有 source/request/consumer 生命周期的受限 transport：字节/时间上限、pipeline 或等效错误与背压传播、消费者断开向上游传播、明确取消状态。探针已验证 HTTPS + pipeline 方案，仍须集成到实际日志接口并完成服务鉴权和浏览器流程。不要捕获并吞掉进程级 `uncaughtException` 来掩盖库缺陷。

原生 Exec 的标准流处理忽略 `Writable.write(false)`。探针在 SDK WebSocket 连接上按消费缓冲执行 pause/resume，并约束最大缓冲；同时使用每会话自己的 stdin/stdout/stderr，处理 v5 channel-close，避免使用进程标准流。探针使用 2.0.1 发布包的 `dist/web-socket-handler.js`，升级前须复核此路径及行为。S7 终端产品还需会话鉴权、命令风险、审计、超时及前端完整交互，不能由本探针代替。

SDK 的 REST/Watch 认证会创建 undici Dispatcher，原生 WebSocket 配置也持有 Agent。检查 Adapter 已使用自己拥有的 HTTPS transport；流探针通过 SDK 扩展点登记和销毁其资源。后续 watch/reconnect 必须有明确所有者、关闭传播、退避和 410 重新 list 逻辑，不能把 SDK `done` 当成自动恢复承诺。429 的 Retry-After 安全分类已有 fixture 证据，实际集群 APF 自然限流不在本次实测范围。

这些结果支持继续使用 TypeScript/Node.js 主栈，并把库的资源与流处理差异封装在 Adapter 内；不构成无限并发、任意集群规模或 Oracle 性能保证。

## 复现

先按[本地运行面说明](../local-lab.md)启动已有 A/B 实例，保持 kubeconfig 为 0600。以下命令不打印凭证：

```sh
pnpm --filter @ozz/infrastructure build
pnpm exec vitest run tests/infrastructure/kubernetes.test.ts --reporter=json --outputFile tests/probes/results/kubernetes-boundaries.json
pnpm exec node tests/probes/kubernetes-sdk.mjs
```

只读检查可使用 `pnpm exec node tests/probes/kubernetes-sdk.mjs --inspect-only`。完整探针会创建带本次随机标记的独有 Namespace、只读测试身份和测试 Pod，最后按 UID 删除并确认；任何必要检查失败都会退出非零并保存未通过报告。
