# S1 后端协议验证与本地 API 基线

日期：2026-10-25（Asia/Shanghai）。对应 [后端评估](../backend-stack-evaluation.md) 的 B01、B02/B03 已实现部分，以及 B05 的 S1 分项测量。**当前 Nest/Fastify 协议探针 6/6 通过；本地元数据负载 64,647 次请求、0 错误，服务器侧 p95 为 10 ms。** 这份记录不代表 Oracle 容量验收，也不代表 Service/Deployment、Git、终端或 AI 功能已经完成。

## 1. 证据与变更文件

| 文件                                                                      | 用途                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [协议探针](../../tests/probes/http-protocols.mjs)                         | 在随机 loopback 端口启动独立 Nest/Fastify，使用真实 HTTP 与 WebSocket 连接                                           |
| [协议断言](../../tests/integration/http-protocols.test.ts)                | 版本、原始字节验签、增量输出、正常/异常断开与资源回收                                                                |
| [B01 结果](../../tests/probes/results/http-protocols.json)                | 19:11 的独立运行，6/6 通过；最终 [全量集成结果](integration-results.json) 58/58 包含同一组 6 条                      |
| [工程检查结果](check-results.json)                                        | 最终 `pnpm check` 退出码 0；Prisma 生成、workspace 构建/类型检查、ESLint、Prettier、后端 6 项和 Console 3 项单测通过 |
| [API 测量脚本](../../scripts/measure-api.mjs)                             | 创建临时 schema、应用真实迁移、启动生产 API、构造元数据、测量并清理                                                  |
| [进程采样](../../tests/probes/process-metrics.mjs)                        | 通过 Node import 与 IPC 采集 API 进程的 CPU、RSS、事件循环延迟；没有新增产品指标接口                                 |
| [成功测量](../../tests/probes/results/api-baseline-4b95ab9cffd3.json)     | 原始请求分布、延迟分位数、61 个资源样本、数据规模和清理结果                                                          |
| [首次失败记录](../../tests/probes/results/api-baseline-1df8aa9fca99.json) | Prisma CLI 入口解析失败，停在临时 schema 的迁移阶段；未发起负载请求，已清理                                          |

首次失败后修正了 Prisma CLI 的解析入口，再完成一次正式测量。失败记录保留，不与成功样本混合，也未通过忽略错误请求获得结果。

## 2. B01：已验证的 HTTP 能力

实际依赖：Node **24.22.1**、Nest **11.2.8**、Fastify **5.12.7**、`@fastify/websocket` **11.3.4**。测试从实际加载的模块读取版本并断言，使用 Node 原生 HTTP/fetch/WebSocket 客户端连接服务端。

| 场景               | 实际断言                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 原始请求体验签     | 带空格、换行和中文的 JSON 按原始字节计算 HMAC；原文通过，语义相同的重新序列化、字段篡改和错误签名长度均返回 401 |
| SSE                | 每次接收至少两条增量事件；连续三次客户端取消后，订阅和定时器均回到 0                                            |
| 流式 HTTP          | 按顺序收到三段 NDJSON；下游断开传递到上游异步生产者，生产者退出且监听器被释放                                   |
| WebSocket 正常关闭 | 消息往返成功；客户端正常关闭后，服务端连接计数与心跳定时器被清理                                                |
| WebSocket 异常关闭 | 真实 HTTP Upgrade 返回 101 后直接断开 TCP；服务端收到异常关闭，连接与心跳定时器被清理                           |
| 探针结束           | 所有协议的活动连接/订阅、定时器和 disposer 均为 0                                                               |

探针使用独立测试 Module，没有将 `__protocol_probe` 路由注册到产品 AppModule。它证明所选版本的适配器可以承载上述最小通路；没有验证公网代理缓冲、上传、大规模慢消费者、真实模型输出或 Kubernetes Exec。WebSocket 插件当前只作为测试依赖，产品终端仍按 S7/S9 实施。

产品 Cookie、Origin、CSRF、持久登录限速、密码验证并发门和日志脱敏另由 [安全集成测试](../../tests/integration/security.test.ts) 验证，最终全量结果中 **17/17 通过**。不能用不带产品鉴权的协议探针替代这些安全检查。

## 3. API 测量条件

测量区间为 **19:27:10.923–19:28:10.929**，请求窗口 **60.006 秒**，之前预热 **10 秒**。生产 API 运行在宿主 Node 进程，通过 loopback HTTP 访问；真实 PostgreSQL/Redis 在本机 Docker 环境运行。构建和 K3s 实验启动在采样结束后继续，避免这些重负载与采样混跑。

| 条件     | 本次取值                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| 宿主     | Apple M1 Pro、8 逻辑 CPU、16 GiB、macOS/Darwin 23.6.0、ARM64                                                     |
| API      | `NODE_ENV=production`，`apps/api/dist/main.js`，Node 24.22.1，Nest 11.2.8，Fastify 5.12.7，info 级请求日志       |
| 数据库   | PostgreSQL 17.11、Prisma 6.19.3；随机隔离 schema，执行两条现有迁移                                               |
| 连接配置 | `connection_limit=5`，`pool_timeout=5` 秒；配置值不等于实际等待时间                                              |
| 初始数据 | 50 Project、100 Environment、5 Cluster、10 Server、10 加密凭证引用；无 Operation、Service 或 Deployment 历史样本 |
| 请求并发 | 5 个闭环客户端，每个最多 1 个在途请求，无思考时间                                                                |
| 查询分布 | 项目列表 20%、项目详情 20%、环境列表 20%、集群列表 10%、服务器列表 10%、凭证元数据列表 10%                       |
| 写入分布 | 带 revision 条件的项目 PATCH 10%；每个客户端使用自己的项目，避免将冲突恢复混入延迟测量                           |
| 鉴权     | 隔离 schema 内创建临时会话，每次请求经过真实鉴权；写入经过 Origin/CSRF 和持久审计。登录密码哈希耗时不在负载中    |

列表每页上限为 20；元数据中的集群地址为测试保留地址，脚本不连接 SSH 或 Kubernetes。初始 readiness 为 `ready/read_write`，队列观察为 `degraded`，因为这个隔离 schema 没有 Worker 心跳。这里没有注入 Redis 故障，也没有提交队列任务。

服务端延迟来自生产 `onResponse` 的 `reply.elapsedTime`，四舍五入为整数毫秒，通过合成 request ID 与请求一一对应；**64,647 条请求全部匹配服务端记录**。客户端延迟包括 loopback 传输、完整 JSON 响应解析与驱动调度。分位数按全部测量请求的 nearest rank 计算；预热不计入，无自动重试或失败样本排除。

## 4. 测量结果

所有请求均返回 HTTP 200，错误率 **0%**。吞吐为 **1,077.34 请求/秒**，表示上述小数据集与闭环客户端条件下的观测值，不是容量上限或真实管理员人数承诺。

| 路由           |     请求数 | 服务端 p50 / p95（ms） | 客户端 p50 / p95（ms） |
| -------------- | ---------: | ---------------------: | ---------------------: |
| 项目列表       |     12,928 |                  4 / 6 |            4.04 / 6.72 |
| 项目详情       |     12,930 |                  3 / 6 |            3.48 / 6.37 |
| 环境列表       |     12,929 |                  3 / 5 |            3.53 / 6.07 |
| 集群列表       |      6,465 |                  3 / 5 |            3.03 / 5.48 |
| 服务器列表     |      6,466 |                  3 / 5 |            3.04 / 5.38 |
| 凭证元数据列表 |      6,465 |                  3 / 4 |            2.98 / 5.16 |
| 项目 PATCH     |      6,464 |                 9 / 16 |           9.82 / 16.54 |
| **合计**       | **64,647** |             **3 / 10** |       **3.60 / 10.25** |

服务端最大延迟 **150 ms**，客户端最大延迟 **171.63 ms**。

| 资源观测         | 结果与口径                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| API 平均 CPU     | **151.53%**，约 **1.52 个核**；进程 user+system CPU 时间除以墙钟时间，100% 代表一个 CPU 核。不是整机百分比，也不表示 JavaScript 主线程能够并行执行 |
| API RSS          | 开始 **290.66 MiB**，结束 **321.78 MiB**，1 Hz 采样峰值 **341.72 MiB**                                                                             |
| 事件循环延迟     | 采样分辨率 20 ms；p50 **20.02 ms**、p95 **20.89 ms**、最大 **86.70 ms**。数值包含计时器采样周期，不能把约 20 ms 直接当作请求或业务阻塞时间         |
| 数据库连接快照   | 前后均为 17 个连接、0 个 active；是整个数据库的瞬时快照，包含其他空闲应用和采样驱动，不是 API 峰值连接数                                           |
| 临时 schema 大小 | 预热后 **1.00 MiB**，结束 **2.69 MiB**；按表的 total relation size 汇总，包含索引/TOAST 与测量写入产生的数据                                       |

CPU/RSS 来自 5 并发、无思考时间的闭环满速负载，不能当作闲置或正常人工使用的资源需求。它们只统计隔离 API 进程，不包含驱动、PostgreSQL、Redis、Worker、Console 或 Docker。CPU 采样窗口约 60.209 秒，包含请求结束后用于接收日志的短暂收尾时间。60 秒 RSS 观测不能证明长期无内存泄漏；连接池等待、逐条 SQL 延迟与队列等待尚未采样。

这次负载测量早于密码验证并发门的补充修复，没有重跑负载；上述数值仍对应当时不含登录哈希计算的元数据请求。新增的连接池耗尽与密码验证用例验证故障处理和资源准入，不代替持续负载或容器 OOM 验证。

## 5. 数据访问、恢复与后续边界

[最终全量集成记录](integration-results.json)包含元数据 **9/9**、安全 **17/17**、任务 **18/18**、控制面恢复 **8/8**、协议 **6/6**，共 **58/58 通过、0 失败、0 跳过**，耗时 **31.81 秒**。B02/B03 的 S1 证据覆盖真实 PostgreSQL 事务/约束、审计失败回滚、Operation/Outbox 原子性、revision 竞争、Redis 中断与重投、Worker 租约、取消竞争、generation fence，以及备份恢复锁和恢复中断回滚。

安全回归新增两类资源边界。连接池用例将 `connection_limit=1`、`pool_timeout=1`，用真实 PostgreSQL 查询占用唯一连接，确认 API 返回不泄漏连接信息的 `503 DATABASE_BUSY`，释放连接后恢复 200。密码验证保持 Argon2id 的 64 MiB、3 次迭代和原有 IP/账号限速；启动时等待未知账号使用的哈希生成，每个 API 进程同时只验证一次密码，无等待队列，繁忙时返回 `503 AUTH_BUSY` 且不创建会话。真实 API/数据库配合受控密码验证函数的用例覆盖已知与未知账号、验证异常后释放以及启动哈希拒绝；这里没有实测或宣称触发过 OOM。

Linux root 的 Compose 恢复还修正了密钥文件属主：只为本次新建的 `0600` 主密钥设置目标运行 UID/GID，非 root 的 UID 不匹配在导入前拒绝。Linux ARM64/Node 24.22.1 权限分项已经验证默认 UID 1000 与自定义 UID 12345 可读取、既有文件未改和错 UID 拒绝。后续整套 Compose 的 14 项部署检查也已通过，包括匹配密钥的空库恢复、恢复锁与重启；独立证据见 [部署报告](deployment-results.json)和[部署记录](S1-deployment.md)。

这些结果只证明当前诊断任务与元数据的行为。pgvector、持续负载下的连接池容量与等待延迟分布、复杂人工等待工作流、真实发布副作用和旧备份与 Kubernetes 的对账仍须在相应阶段验证。B04 需要两套真实 API 的凭证/观察隔离与日志/Exec 探针。

B05 的正式条件保持不变：目标控制面上 **100 个服务元数据、1 万条部署历史、5 个并发管理请求、2 个有界日志窗口持续 10 分钟**，分别测正常、单集群超时和 Redis 不可用场景。S1 还没有 Service/Deployment 历史模型，本次分项结果不能填补该验收。HTTPS、公网 RTT、SSH、构建、rollout、真实模型提供方与 Oracle/x86_64 也没有在这次负载中验证。

## 6. 重现与清理

先按 [开发说明](../development.md)安装依赖、生成 `.env`/主密钥、启动本地 PostgreSQL/Redis，并完成 `pnpm db:generate` 与 `pnpm build`。不需要使用或导出管理员密码。协议测试命令为：

```sh
pnpm exec node --env-file=.env node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts tests/integration/http-protocols.test.ts --reporter=default --reporter=json --outputFile=tests/probes/results/http-protocols.json
```

在没有其他构建/集群重负载时测量：

```sh
pnpm exec node --env-file=.env scripts/measure-api.mjs --duration=60 --warmup=10 --concurrency=5 --projects=50
```

脚本只接受 loopback 数据库地址，使用当前用户创建并迁移随机 `ozz_baseline_*` schema，因此需要本地数据库的相应权限。它独立启动临时生产 API 并监听随机 loopback 端口；结束或受控取消时先停止 API，再删除本次创建的 schema。不要对生产数据环境运行该测量。

成功报告保存到独立 run ID 文件。终端和报告不输出数据库连接密码、主密钥、会话、CSRF、凭证明文或未脱敏的 API 日志。两次运行均记录 `schemaDropped=true`、`apiStopped=true`；结束后另外用 PostgreSQL 只读查询确认两个 schema 均不存在，并确认成功运行的 API PID 已退出。原开发库、共享 Redis 和管理员账号未被清理。
