# S1 Compose 部署与本地验收

本记录覆盖正式镜像、同源 HTTPS、数据库迁移、独立 Worker、故障恢复及控制面备份传输。用户尚无真实 VPS，本次目标是本机 Docker ARM64；公网 DNS、ACME 签发、Oracle 目标机及 AMD64 运行需在对应环境另行验收。

2026-10-25 本地真实验收 **14/14 通过**。可提交的无凭证记录见 [deployment-results.json](deployment-results.json)，原始记录保留在 `.local/ozz-s1-proof-944276e8/evidence.json`。该项目的全部服务已停止，容器、数据卷、密钥和备份均保留。

验证环境为 macOS 14.8、Docker Desktop 4.36.0 / Engine 27.3.1、Compose 2.30.3，Linux ARM64 容器，Docker 分配 8 CPU / 约 7.65 GiB 内存。完整脚本从 20:34:52 至 20:35:43（UTC+8）约 50.5 秒；其中 Compose 等待服务就绪 17.149 秒，测试库备份命令 0.412 秒，恢复命令 0.483 秒。命令耗时不等同于业务停机时间或生产 RPO/RTO。

| 检查               | 实际结果                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Linux 恢复密钥权限 | root 创建的 `0600` 新文件可由 `1000:1000` 和 `12345:12346` 读取；既有文件不变，非 root 错误 UID 被拒绝 |
| 数据库迁移         | 2 条迁移已完成，无未完成记录                                                                           |
| HTTPS              | 使用该部署的本地 CA，证书与主机名校验通过                                                              |
| 同源入口           | 首页、SPA 深链接及 `/api` 路由正常，未登录资源请求返回 401                                             |
| HTTP 跳转          | 返回 308，保留外部 HTTPS 端口                                                                          |
| 登录与管理元数据   | 安全 Cookie、集群和项目创建、默认 production 环境、凭证元数据通过                                      |
| 请求解析错误       | 415 / 413 返回稳定错误码，不反射测试标记                                                               |
| Worker 密钥检查    | 缺失或错误密钥退出 1，未创建额外心跳或开始分发                                                         |
| 独立 Worker        | 持久诊断成功执行，attempts 为 1                                                                        |
| Redis 中断         | API 继续返回 202，readiness 为 200，任务保持 queued；恢复后成功且只执行一次                            |
| Compose 备份恢复   | 新空库恢复锁开启、generation 为 1，旧待处理任务仍为 0；恢复会话失效，密钥字节匹配，源库保持可写        |
| 容器重启           | PostgreSQL、Redis、API、Worker、Caddy 重启后，项目、凭证、会话、任务结果及 TLS 仍有效                  |
| 转发地址限速       | 轮换伪造 X-Forwarded-For 和用户名仍命中真实来源的 429 限速                                             |
| 网络与资源         | 后端无宿主端口，backend 为 internal，内存/CPU 上限和日志轮转生效                                       |

本次实际镜像如下，完整 SHA256 与字节大小保存在 JSON 中：

| 镜像                | 镜像 ID 前 12 位 |
| ------------------- | ---------------- |
| `ozz/api:0.1.0`     | `4f556eb8d4b6`   |
| `ozz/worker:0.1.0`  | `2940817610cb`   |
| `ozz/migrate:0.1.0` | `782928807720`   |
| `ozz/console:0.1.0` | `1d6fb6c4f3c1`   |

功能检查后、停止前的一次 `docker stats --no-stream` 快照如下。五个常驻容器显示的内存使用合计约 158.1 MiB；该数值按 Docker stats 口径计算，不含 Docker 虚拟机及宿主系统开销，不是持续压测结果或 Oracle 容量承诺。

| 服务          | 内存使用 / 上限     | CPU   | PIDs |
| ------------- | ------------------- | ----- | ---- |
| PostgreSQL    | 34.65 MiB / 2 GiB   | 1.30% | 12   |
| Redis         | 4.305 MiB / 384 MiB | 1.87% | 6    |
| API           | 64.53 MiB / 512 MiB | 0.01% | 18   |
| Worker        | 44.04 MiB / 512 MiB | 3.93% | 15   |
| Console/Caddy | 10.56 MiB / 256 MiB | 0.00% | 8    |

## 部署构成

`compose.yaml` 启动 PostgreSQL、Redis、一次性迁移、API、Worker 和 Console/Caddy。迁移成功且 API 健康后再启动 Worker 与入口。Caddy 提供静态 Console、SPA 深链接和 `/api` 反向代理；浏览器只使用一个 HTTPS 来源。

迁移启动器先在进程内生成连接配置，再真实启动 Prisma CLI 并传递退出状态与停止信号，确保 CommonJS 的主入口守卫会执行迁移。HTTP 入口显式返回 `308`，跳转目标保留 `APP_ORIGIN` 中的外部 HTTPS 端口。

仅 Caddy 发布 HTTP/HTTPS 端口。PostgreSQL、Redis、API 和 Worker 只加入 `internal` 后端网络，当前 S1 没有远端执行需求。进入 S2 时，需给连接 K3s API/SSH 的进程增加独立且不发布端口的出站网络，数据库和 Redis 继续只留在内部网络。

Caddy 默认重建转发地址，未配置对外部请求头的信任。API 的 `TRUSTED_PROXY_CIDRS=uniquelocal` 用于此专用后端网络，不能把任意不受信任的容器接入该网络。这里没有固定私网地址段，避免多套本地部署与现有 Docker 网络冲突；转发头限速边界由真实 HTTPS 检查验证。

API/Worker/Console 使用普通用户、只读根文件系统、受限临时目录、移除 capabilities 和 `no-new-privileges`。主密钥通过只读文件 secret 挂载，不进入镜像。构建上下文以允许列表排除环境文件、密钥、依赖缓存及本地输出。所有服务日志均按 `10m × 3` 轮转。

| 服务          | 内存上限 | CPU 上限 | 持久化                 |
| ------------- | -------- | -------- | ---------------------- |
| PostgreSQL    | 2 GiB    | 1        | 数据卷                 |
| Redis         | 384 MiB  | 0.5      | AOF 数据卷             |
| API           | 512 MiB  | 1        | PostgreSQL；文件主密钥 |
| Worker        | 512 MiB  | 0.5      | PostgreSQL；文件主密钥 |
| Console/Caddy | 256 MiB  | 0.5      | 证书及配置卷           |
| 迁移（短时）  | 512 MiB  | 1        | PostgreSQL             |

这些值是资源上限，不是实测占用或目标 VPS 容量结论。API readiness 依赖持久化数据库，Redis 暂停不会阻止持久任务接收；Worker 通过独立状态报告队列降级。恢复锁期间 Worker 执行 readiness 暂停，其容器存活检查仍可通过。

## 初始化与启动

在仓库根目录执行，初始化目录必须尚不存在。脚本生成随机数据库密码、Redis 密码、管理员初始密码和 AES 主密钥；目录为 `0700`，文件为 `0600`，终端只输出文件位置。

```sh
pnpm exec node infra/docker/setup-compose.mjs \
  --hostname localhost \
  --directory .local/production \
  --project ozz \
  --bind-address 127.0.0.1 \
  --http-port 38080 \
  --https-port 38443

pnpm exec node infra/docker/build-images.mjs \
  --env-file .local/production/.env

docker compose --env-file .local/production/.env -f compose.yaml \
  up -d --no-build --wait

docker compose --env-file .local/production/.env -f compose.yaml \
  run --rm=false --no-deps \
  --volume "$PWD/.local/production/secrets/admin-password:/run/secrets/bootstrap_password:ro" \
  api /app/dist/cli.js admin:init \
  --username admin --password-file /run/secrets/bootstrap_password
```

从受限的 `.local/production/secrets/admin-password` 文件读取初始密码。不要把密码作为 CLI 参数传递。重复初始化不会替换既有目录、密钥或管理员。

`localhost` 使用 Caddy 本地 CA。检查时显式信任该部署的公开根证书，无须安装到系统信任库或关闭 TLS 校验：

```sh
docker compose --env-file .local/production/.env -f compose.yaml \
  cp console:/data/caddy/pki/authorities/local/root.crt .local/production/caddy-root.crt

curl --cacert .local/production/caddy-root.crt \
  https://localhost:38443/api/health/ready
```

实际域名部署时将 `--hostname` 改为解析到主机的域名，使用公网入口对应的 `--bind-address`、80/443 端口，可设置 `--acme-email`。此分支使用 Caddy 自动 HTTPS，尚未在真实公网主机验证。

## 镜像与下载来源

四个镜像使用最终业务源码，并在部署入口和打包修复后分别复用缓存重建；实际镜像 ID 以本次运行证据为准。实际运行时固定 Node `24.22.1`、pnpm `12.14.0`、Fastify `5.12.7` 和 Caddy `2.11.7`。生成的 Linux Prisma 客户端复制到部署后模块实际解析的位置，替换 pnpm 嵌套依赖中的占位客户端；构建会真实构造客户端验证。ARM64 可选原生依赖在构建阶段编译，Python 和编译器不进入 API、Worker 或 Console 运行层。

默认基础镜像为 `node:24.22.1-bookworm-slim`。本机 Docker 镜像代理无法完成 BuildKit 的远端解析时，可使用已经缓存的基础层和进程级兼容构建：

```sh
pnpm exec node infra/docker/build-images.mjs \
  --legacy --bootstrap-image node:22.21.1-bookworm-slim \
  --debian-mirror https://mirrors.tuna.tsinghua.edu.cn
```

这里 Node 22 只用于引导下载。构建下载官方 Node 24.22.1、核验 SHA256、替换执行路径并移除旧 Node/npm 工具；运行镜像必须通过真实版本检查。`--legacy` 只给该次 Docker 子进程设置 `DOCKER_BUILDKIT=0`，不修改全局 Docker 配置。镜像中不包含本机主密钥或环境文件。

`--debian-mirror` 仅替换该次构建中编译工具的下载镜像，仍由 APT 验证 Debian 签名，未关闭任何认证。本机官方 Debian CDN 大文件传输缓慢，兼容命令选用清华 Debian 镜像；省略该选项保持官方默认源。它不更改宿主机或全局 Docker 的软件源。

构建使用 `--rm=true` 自动移除成功步骤的临时构建容器；失败步骤仍留供诊断。Compose 验收容器与数据卷单独保留。构建前检查 Docker 自身数据盘可用空间，宿主机剩余空间不代表 Docker 虚拟数据盘仍有空间。

Node 压缩包的哈希来自官方 `SHASUMS256.txt`。Caddy 使用其[官方安装文档](https://caddyserver.com/docs/install)指向的 Cloudsmith stable Debian 软件源，哈希来自该源 `Packages` 索引；只解包二进制，不执行 Debian 安装脚本。

| 下载                      | ARM64 SHA256                                                       | AMD64 SHA256                                                       |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Node 24.22.1 Linux tar.gz | `33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3` | `eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c` |
| Caddy 2.11.7 Linux deb    | `ca8ae5a50439642d7672344b4ec64e47cbddf81beb5da302420a78522eb5a47e` | `a22b914ffd1958da42bc7ab13b7b62c6100634e0798ab594891d2d61d53ba749` |

PostgreSQL `17.11` 与 Redis `7.4.9` 使用 Compose 中固定的镜像摘要。这里记录 AMD64 下载锁定值，不代表已完成 AMD64 构建或运行。

## 验收复现与保留数据

构建镜像后执行：

```sh
pnpm exec node tests/deployment/compose-smoke.mjs
```

脚本创建唯一的 `.local/ozz-s1-proof-<ID>` 目录和 Compose 项目，动态选择两个回环端口，使用独立数据库、Redis、密钥和证书卷。HTTPS 客户端核验该项目的本地 CA，不跳过证书或主机名校验。证据与故障诊断写入受限目录；结束时仅停止该测试项目，保留容器、卷、备份和密钥供复核，不操作开发环境服务。

检查范围包括迁移、同源静态页面与 API、HTTPS Cookie、管理元数据、加密凭证、安全解析错误、错误主密钥拒绝启动、真实任务执行、Redis 中断恢复、正式 Compose 备份传输、空库恢复锁与代次、会话撤销、容器重启持久化、伪造转发头登录限速、实际运行版本、内部网络与资源限制。

控制面备份和新目标恢复的完整操作见 [备份与恢复](../control-plane-recovery.md)。数据库和密钥保存在分离目录；本地备份目录不等于异机备份。Caddy 证书卷、部署环境文件及所用镜像版本应独立保留，数据库备份脚本不备份这些文件。

日常暂停部署使用 `docker compose --env-file .local/production/.env -f compose.yaml stop`。当前验收不删除任何测试容器或卷。
