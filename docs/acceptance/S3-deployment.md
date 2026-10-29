# S3 Linux 镜像与 Compose 验收

2026-10-26（UTC+8），C 上最终四个 Linux ARM64 镜像 **4/4 构建通过，Compose 16/16 通过**，HTTP 边界真实 TCP 单测 **2/2 通过**。无凭证结果与完整摘要见 [s3-deployment-results.json](s3-deployment-results.json)。最终 Compose 项目为 `ozz-s1-proof-a0e2aff7`，运行约 **47.605 秒**；所有测试容器、数据卷、数据库、密钥、备份和失败记录均保留。

构建来源是独立 S3 快照 `s3-http413-20261025T193554Z-b9c3411e`，SHA256 为 `b29ff98a295c999c7e92c22aad31ea4a746269f53e5242bb7aeaa17960003fb0`，共 279 个文件。它只在原快照 `577495678a125ca8c8ce0a600c80756f7971ce51b0071e14c7305d9c2ed7e633` 上覆盖 `apps/api/src/app.ts`、`tests/deployment/compose-smoke.mjs`，并新增 `apps/api/src/common/body-limit.ts`、`tests/unit/body-limit.test.ts`；其他源码字节逐一核验相同。构建、真实 Compose 和最终核验均使用该快照，未包含 S4 源码。

C 使用 Lima 2.2.1 / Apple Virtualization、Ubuntu 24.04、2 CPU、2304 MiB 内存。为保留全部失败镜像并给导出临时层留足空间，其专用虚拟盘经授权由 20 GiB 原位扩至 28 GiB，CPU/RAM、VM 持久身份、machine-id、K3s namespace/node UID 与配置哈希不变；A/B 的配置与持久身份也未改变。Docker 28.5.2、Compose 2.40.3、containerd 1.7.28 安装在项目专有目录，没有执行系统包安装钩子或替换全局二进制。

镜像前缀为 `ozz-s3-http413-final`，标签为 `0.1.0`；以下 ID 是经典 Docker 镜像库的 config digest。完整 ID、rootfs diff ID 和字节数在 JSON 中。

| 镜像      | ID 前 12 位    | Docker 逻辑大小 |
| --------- | -------------- | --------------- |
| `api`     | `0788834a1597` | 876.6 MiB       |
| `worker`  | `3a7710812029` | 851.7 MiB       |
| `migrate` | `32f5ee94d7c8` | 2361.0 MiB      |
| `console` | `fc4cb2b019eb` | 555.8 MiB       |

实际运行版本为 Node 24.22.1、pnpm 12.14.0、Fastify 5.12.7、Caddy 2.11.7。6 条数据库迁移全部完成，无未完成迁移。Docker 逻辑镜像大小包含共享层，不能直接相加视为实际磁盘占用。

| 验收范围          | 实际结果                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Linux 密钥权限    | root 恢复的密钥可由预期普通 UID 读取，错误 UID 被拒绝                                                    |
| 启动与同源入口    | 迁移、CA/主机名严格校验的 HTTPS、SPA 深链、`/api` 与保留外部端口的 308 跳转通过                          |
| 认证与管理元数据  | 安全 Cookie、登录、集群/项目/默认环境及加密凭证元数据通过                                                |
| HTTP 解析边界     | 415 正常；Content-Length、chunked 各 8 次超大请求均返回结构化 413，不反射输入                            |
| Worker 与持久队列 | 错误/缺失密钥启动被拒绝，正常任务一次执行成功；Redis 中断时接收任务并在恢复后只执行一次                  |
| 备份恢复          | 新空库恢复锁开启、generation 递增、旧任务代次保留、恢复会话撤销、密钥一致且源库仍可写                    |
| 重启与限速        | 数据库/Redis/API/Worker/Caddy 重启后状态保持；伪造 X-Forwarded-For 不能绕过来源限速                      |
| 资源与端口        | CPU/内存上限和日志轮转生效；后端服务无宿主发布端口，Console 仅用本次回环端口                             |
| 出站连通          | API、Worker 各完成 SSH banner、Kubernetes 风格 HTTPS `/version`、registry HTTPS `/v2/` challenge，共 6/6 |
| 数据层隔离        | 共享 PostgreSQL/Redis 网络命名空间的只读探针均无法建立相同连接，共 6/6，错误为 ENETUNREACH               |

出站证明使用独立目标桥接网络，三个临时端口仅绑定在本次 egress gateway `172.29.5.1`，HTTPS 使用专有 CA 和 SAN 严格核验，未发送真实远端凭证。API/Worker 加入 `backend + egress`；PostgreSQL/Redis 只在 `internal` 的 backend。该证明覆盖实际 Linux 路由及协议边界；真实私有 registry/凭证生命周期另见 [S3-private-registry.md](S3-private-registry.md)。

首次真实 Compose 保留了一个产品失败：API 已生成 413，但 Fastify 在代理尚未传完请求体时强制关闭连接，Caddy 收到 TCP reset 后返回 502。独立 Linux Caddy/Fastify 对照中，baseline 与仅 resume 的 Content-Length 各出现 2/8 次 502；移除强制 close 并丢弃输入的方案在两种 framing 共 16/16 返回 413。正式补丁只处理 `FST_ERR_CTP_BODY_TOO_LARGE`，不缓存被拒绝的输入，使用既有 15 秒 requestTimeout 作硬截止，并在 end/close 释放计时器。真实 TCP 单测还验证了上传完成后连接跨越截止时间仍可复用，以及未完成上传按时关闭。原始失败项目 `ozz-s1-proof-c14b12f1`、对照全部 48 次结果和修复后的测试结果均保留。

执行器还保留了几项环境失败：最初 Docker bridge/bip 配置冲突、C 对 Docker Hub 的拒绝连接与 Debian HTTP 超时、扩容前的空间阈值停止，以及派生解包时 umask 把目录缩为 0700 导致迁移 UID 无法读取 Prisma。最后一项通过显式恢复源码目录为 0755 修复，279 个文件的字节/文件模式及快照 SHA 未变；原失败镜像标签与日志未被覆盖。最终 migrate 镜像在普通用户下真实运行 Prisma CLI 检查通过。

离线基础镜像来自 Mac 的只读 `docker image save`，归档 SHA 为 `aff4b8b39c65606e89c55667e1924d5fb1b8bf96c60d81f894ae66f3f01ed5cd`。Node/toolchain、PostgreSQL、Redis 的原始 index/manifest、平台 config、全部层摘要/长度和 C 导入后的 rootfs diff ID 均核验。经典 Docker load 丢失 canonical RepoDigest 名称，因此本次仅在独立进程里将 PostgreSQL/Redis 绑定到已证明等价的 config ID；源码中的默认 digest 引用未改变。编译工具下载使用清华 Debian HTTPS 镜像，APT 签名校验保持开启；未改全局 DNS、代理或信任库。

最终镜像包位于：

```text
.local/local-lab/linux-build-c/artifacts/ozz-s3-http413-final-linux-arm64-s3-http413-20261025T193554Z-b9c3411e.tar
SHA256 d1751fd7e4d7355f6d32ae2572cbc3f1d6792df451d44fdfe1ecca42bdc5aef1
3513444352 bytes
```

导出通过严格 SSH 校验流式送到 Mac 文件系统，C/Mac 流摘要相等；本地进一步核验全部 4 个 config 和 36 个唯一 rootfs 层。Moby 28.5.2 的经典 save 会临时物化 layer tar，扩容也覆盖了这段临时空间。镜像包未加载到 Mac Docker，原四个 Mac 来源镜像的 ID、tags、RepoDigests 和大小保持相同。

截至收尾，C 专用 Docker 中保留 193 个镜像 ID、27 个容器、8 个数据卷；所有自建验收容器已停止，专用 `ozz-s3-docker-c.service` 已停止并保留，原 K3s 仍 active。两份 S3 源码归档及全部 556 个文件重新核验通过。完整执行器、原日志、权限/扩容回执与本地原始证据位于 `.local/local-lab/linux-build-c/`，C 端原目录也保留。

同一 C 上可复用固定执行器复核；执行器会校验 C 标识、快照 hash 和镜像 ID，并为新 Compose 运行创建独立数据目录：

```sh
sudo systemctl start ozz-s3-docker-c.service
sudo python3 /var/lib/ozz-local-lab/c/linux-build-s3/workspaces/s3-http413-20261025T193554Z-b9c3411e/build-from-snapshot.final.py
sudo python3 /var/lib/ozz-local-lab/c/linux-build-s3/workspaces/s3-http413-20261025T193554Z-b9c3411e/compose-from-snapshot.final.py
```

停止前五个常驻容器的一次 Docker stats 样本合计约 182.8 MiB；Compose 启动等待 16.974 秒、备份命令 0.323 秒、恢复命令 0.363 秒。样本不含 K3s/Docker/VM 开销，命令耗时也不是生产 RPO/RTO。此次覆盖本地 Linux ARM64；公网 VPS、公开 DNS/ACME 和 AMD64 仍需在对应环境验收。
