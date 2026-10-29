# 本地开发与验收

当前包含 S1 基础工程、S2 SSH/K3s 接入、S3 镜像服务、S4 默认域名/HTTPS、S5 数据库/持久卷，以及正在联合验收的 S6 Git 构建。Console 连接真实 API、PostgreSQL 和 Worker；应用发布使用独立的本地 Linux/K3s，源码构建使用独立 Builder。阶段结果与限制见 [S1](acceptance/S1.md)、[S2](acceptance/S2.md)、[S3](acceptance/S3.md)、[S4](acceptance/S4.md)、[S5](acceptance/S5.md)及 [S6](acceptance/S6.md)。真实 VPS 尚未准备，按[本地测试与 VPS 计划](local-test-and-vps-plan.md)继续开发。

下文是常规开发入口。当前持久验收环境使用独立 S6 HTTPS 入口 `https://127.0.0.1:51448` 和受控运行器，操作见 [S6 运行说明](acceptance/s6-github-product-runtime.md)；使用该环境时不要再启动第二套 API/Worker 或重新初始化管理员。

## 工具与首次启动

需要 pnpm 12.14.0、可用的 Docker Compose 和至少约 10 GB 本地余量。项目通过 `devEngines.runtime` 使用 Node 24.22.1，所有命令从根目录用 `pnpm` 执行；不必更换本机其他项目使用的全局 Node。`pnpm exec node --version` 应输出 `v24.22.1`。

```sh
pnpm install --frozen-lockfile
pnpm dev:setup
pnpm dev:infra
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm admin:init --username admin --password-file .secrets/admin-password
pnpm dev
```

打开 <http://127.0.0.1:5173>。管理员账号为上述初始化参数；随机密码只保存在 `.secrets/admin-password`，请在本机密码管理器保存，不提交到 Git 或聊天。没有通用默认密码和公开注册。`dev:setup` 只在显式执行时创建 `.env`、主密钥和密码文件，保留已有文件；API/Worker 启动时不会自动生成替代主密钥。

已初始化环境日常只需 `pnpm dev:infra` 和 `pnpm dev`；验证应用运行时另按下文启动 A/B 虚拟机。管理员初始化重复执行会失败并保留原账号；不需要重新初始化。数据库按序执行版本迁移，修改 schema 后新增迁移，不改已执行的 SQL，也不运行 `db push --force-reset`。

| 进程       | 本地地址/端口                 | 启动方式                                 |
| ---------- | ----------------------------- | ---------------------------------------- |
| Console    | `127.0.0.1:5173`              | `pnpm --filter @ozz/console dev`         |
| API        | `127.0.0.1:3000`              | 构建后 `pnpm --filter @ozz/api start`    |
| Worker     | 内部健康端口 `127.0.0.1:3001` | 构建后 `pnpm --filter @ozz/worker start` |
| PostgreSQL | `127.0.0.1:54320`             | `compose.dev.yaml`                       |
| Redis      | `127.0.0.1:56379`             | `compose.dev.yaml`                       |

Console 通过 Vite 的 `/api` 代理访问 API；使用 `127.0.0.1` 保持与 `APP_ORIGIN` 一致。`localhost`、不同端口或协议是不同 Origin，写请求会被拒绝。生产使用 [部署 Compose](../compose.yaml) 与 Caddy，数据库、Redis、API 和 Worker 不直接暴露宿主端口，操作说明见 [S1 部署验收](acceptance/S1-deployment.md)。

## 配置与数据

`.env.example` 给出字段，`pnpm dev:setup` 写入独立随机值。文件需保持 0600，`.secrets` 目录保持 0700。

| 配置                      | 用途                                                                   |
| ------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`            | PostgreSQL，显式连接池和超时；本地固定独立端口                         |
| `REDIS_URL`               | 有认证的 Redis；故障时任务可先持久保存在 PostgreSQL                    |
| `APP_ORIGIN`              | 浏览器精确来源；生产必须 HTTPS                                         |
| `MASTER_KEY_FILE`         | AES-256-GCM 版本化主密钥文件；恢复必须匹配历史版本                     |
| `SESSION_TTL_SECONDS`     | 会话寿命，默认 8 小时；Cookie HttpOnly、SameSite=Strict，生产加 Secure |
| `TRUSTED_PROXY_CIDRS`     | 默认空；只信任实际 Caddy 来源，不能随意信任转发头                      |
| `RESTORE_MODE`            | `true` 时只读，并持久启用恢复锁；关闭此变量不会自动解锁                |
| `TASK_LOG_RETENTION_DAYS` | 诊断日志默认保留 7 天                                                  |
| `TASK_LOG_MAX_BYTES`      | 单任务诊断日志默认最多 16 KiB                                          |

队列 job、诊断日志与活动任务均有上限。诊断和部署执行日志保存在各自有界 `logsJson`；Pod 日志使用独立的有界 SSE 通路，不写入 PostgreSQL。长期部署历史、审计保留与应用日志不能用当前诊断容量推算。

本地 PostgreSQL/Redis 使用 `ozz-dev` 专属 volumes。暂停依赖可执行：

```sh
docker compose --env-file .env -f compose.dev.yaml stop
```

该命令保留数据。恢复使用 `pnpm dev:infra`。不使用 `down -v` 或全局 prune 作为日常排错步骤。

## 检查与生成契约

```sh
pnpm check
pnpm test:integration
pnpm api:generate
pnpm audit --prod
```

`check` 从 Prisma 生成和 workspace 构建开始，随后检查类型、格式、ESLint 和后端/Console 单元测试。`test:integration` 需要已启动的 PostgreSQL/Redis：队列、安全、恢复测试分别创建临时 schema/数据库，元数据测试只清理自身生成的对象；不清空开发库。恢复脚本用已固定的 PostgreSQL Docker 镜像提供 `psql`、`pg_dump` 和 `pg_restore`，无需额外安装宿主客户端；镜像必须已在本地，默认不自动拉取。

`api:generate` 从真实 Nest 路由生成 `docs/openapi.json` 和 `packages/api-client/src/schema.ts`；需要数据库和主密钥可用。Console 的同源请求层消费生成类型并处理 CSRF、会话隔离与 Problem Details。契约变更后一起提交生成结果，CI 检查是否漂移。

生产构建的浏览器验收：先在三个终端运行 API、Worker 和 Console preview，再执行 E2E。preview 默认端口为 4173，所以这里显式使用与开发 Origin 相同的 5173：

```sh
pnpm build
pnpm --filter @ozz/api start
pnpm --filter @ozz/worker start
pnpm --filter @ozz/console preview --port 5173 --strictPort
```

```sh
pnpm --filter @ozz/console exec playwright install chromium
pnpm test:e2e
```

已有 Chrome 时可用 `PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`。根命令只在内存中将受保护的密码文件传给 Playwright；可通过 `E2E_PASSWORD_FILE` 指定另一文件，`E2E_USERNAME` 指定账号。不要在命令行直接填写密码。测试复用内存中的 HttpOnly 会话；连续反复运行仍受真实的 10 次/15 分钟登录限制，正常等待窗口恢复，不降低应用限速来通过测试。

浏览器报告在 `apps/console/tests/artifacts/`，不会导出 Cookie、CSRF 或 Playwright storage state。性能脚本只测生产预览，命令和测量条件以对应验收记录为准。

## 常见问题与恢复

- 数据库连接失败：检查 `docker compose --env-file .env -f compose.dev.yaml ps`，以及 54320 是否被占用。不要输出完整 `.env` 排错。
- 镜像下载超时：先核对当前 Docker 镜像源与网络。本轮本机曾有旧镜像代理超时；项目未修改全局镜像源。部署记录列出已验证的官方缓存和单次构建替代路径；本地 Docker 内存调整另记在[本地环境说明](local-lab.md)。
- API 报主密钥错误：停止写入，恢复匹配文件及所需历史版本，不能重新生成一把密钥替代。文件权限错误先核对 0600 与实际运行 UID。
- API 可用、任务排队：查看 Worker 健康与任务详情；Redis 故障不会把已经接收的命令丢掉。不要手工重复提交不同幂等键试图补救同一任务。
- 恢复后处于只读：按 [控制面备份恢复](control-plane-recovery.md)核对数据库、密钥、generation 和远端资源，再显式执行 `pnpm recovery:unlock --reconciled`；旧 generation 任务仍不能重放。
- 项目显示未验证集群：登记元数据不代表已经接入。在集群详情导入 kubeconfig，或从服务器接入流程完成指纹、预检和初始化。项目绑定目标保持不变；已验证连接后才执行实际发布。

本地测试与未来 VPS 规格见 [本地测试及服务器准备](local-test-and-vps-plan.md)。

SSH/Kubernetes 开发使用 [本地三集群环境](local-lab.md)。A/B 已通过导入路径，C 已通过产品初始化路径；日常按需启动并保留磁盘，不必重复安装。服务开发通常启动 A/B 即可：

```sh
pnpm exec node scripts/local-lab.mjs start a
pnpm exec node scripts/local-lab.mjs start b
pnpm exec node scripts/local-lab.mjs status
```

S3 产品流程脚本为 `pnpm exec node --env-file=.env tests/probes/s3-local-lab.mjs`，需要 API、Worker、A/B 和已有的 S2 登记。它使用 `.local/local-lab/service-product-state.json` 保留资源 ID、原请求、幂等键及阶段检查点；会真实创建和变更测试服务，不是只读检查。不要删除 state 后盲目重跑，也不要同时启动两个探针。已有失败任务和已应用资源保留，修复后按记录继续原意图。

需要复现 Worker 强制退出时，使用测试专用进程启动器；不要与 `pnpm dev` 或另外两个 API/Worker 终端同时运行：

```sh
pnpm exec node --env-file=.env tests/probes/local-runtime.mjs start
pnpm exec node --env-file=.env tests/probes/local-runtime.mjs status
pnpm exec node --env-file=.env tests/probes/s3-local-lab.mjs --worker-crash
```

启动器只监听 loopback，登记本项目的 API/Worker PID，日志放在 `.local/s3-api.log` 与 `.local/s3-worker.log`。已有端口被其他启动方式占用时拒绝，不接管未知进程。`--worker-crash` 只在没有其他活动任务且目标发布已经完整应用、正在等待健康时，对核对过 PID、命令及工作目录的本项目 Worker 发出 SIGKILL，并正常启动替代进程；该扩展在持久检查点完成后不会重复执行。结束后可用 `local-runtime.mjs stop` 停止两进程，保留数据库与 VM；有活动任务时停止命令会拒绝。

`--retry-failed-publication` 和 `--retry-repaired-publication` 仅用于本轮已记录的两次失败意图恢复，创建关联重试并保留原记录，不是通用清理或重新部署开关。

S3 的 API 大样本测量使用临时 schema 和独立生产 API 进程，创建 100 个服务元数据、1 万条明确标注的模拟历史和最多 100 条诊断任务接收样本；不会为这些样本启动应用或 Worker：

```sh
pnpm exec node --env-file=.env scripts/measure-api.mjs --scenario s3 --projects 20 --duration 600 --warmup 10 --output docs/acceptance/s3-api-load-available.json
pnpm exec node --env-file=.env scripts/measure-api.mjs --scenario s3 --projects 20 --duration 600 --warmup 10 --redis-mode unavailable --output docs/acceptance/s3-api-load-unavailable.json
```

第二条只给隔离 API 配置一个已验证拒绝连接的 loopback Redis 地址，不停止共享开发 Redis。完成后仅停止自己启动的 API、删除本次临时 schema，并在报告记录清理结果。该测量与前端双日志窗口性能、真实 K3s 功能验收分别留证，不包含公网延迟或 Oracle 实测。

Pod 日志通过 SSE 有界读取：最多 1,000 尾行、60 秒、1 MiB 原始输入及编码后输出，账号最多 4 个连接。断开、会话撤销、凭证/目标变化会停止上游；输出不持久写入 PostgreSQL。已知运行期秘密按该 Pod 的已验证快照脱敏，无法验证快照时拒绝读取。应用自行输出的未知秘密不属于通用过滤器的完整保护承诺。
