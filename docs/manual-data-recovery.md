# S5 手工业务数据备份与新目标恢复

本 runbook 使用 `ozz-manual-data/1.0.0` 独立操作者工具。PostgreSQL、Redis 和普通文件分别走自己的备份/导入路径。工具保留源 Service、Volume、PVC/PV、数据、历史镜像与旧证据；只创建和移除本次有 nonce/UID 回执的 helper Pod。这里的步骤不会自动转流量、绑定消费者、解除维护或启动正式 Service。

这不是 S8 备份调度器。`manual-data-records` 只保存操作者提交的证据索引，始终返回 `verificationSource: "operator_reported"`。本工具的协议测试使用本机临时 HTTPS/WebSocket 服务和固定客户端桩，不能代替真实 PostgreSQL/Redis 或 A→B 验收；实际执行报告另存于 `docs/acceptance/`。

## 1. 固定版本和边界

| 数据       | 实际版本 / 布局                   | 产物                  | 导入方式                                                                                    |
| ---------- | --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| PostgreSQL | 17.11 / `postgresql-17-pgdata-v1` | `data.pgdump`，custom | 新目标原凭证、新空库，单事务 `pg_restore`                                                   |
| Redis      | 7.4.11 / `redis-7-rdb-aof-v1`     | `data.rdb`            | 新目标先以 AOF 关闭加载 RDB，再开启 AOF 并确认 rewrite、正常停止，最后正式 StatefulSet 启动 |
| 普通文件   | GNU tar 1.34 / `files-root-v1`    | `data.tar`，USTAR     | 先停止并维护，只读归档；新空卷受控解压，再比较内容/UID/GID/mode                             |

PostgreSQL helper 镜像为 `docker.io/library/postgres@sha256:858bb5e98eed02eb8cafbcdc007f9a65d1b613972028944a8ec2133ccaf80d27`。Redis 为 `docker.io/library/redis@sha256:44960b3100c48159a66d28c18b0588c193492e25f7551d60e51dd464fc3eca5b`。文件 helper 复用上述 PostgreSQL Bookworm 镜像内的 GNU tar，不启动 PostgreSQL。镜像身份对应 [固定模板资产](../packages/control-plane/src/templates/image-assets.ts)，工具没有任意镜像/命令参数。

首版支持已登记的 local-path Filesystem/ReadWriteOnce 卷、唯一且 Ready 的实际 Node UID，以及 Kubernetes `v5.channel.k8s.io` exec。K3s 1.35 支持这个协议。单份产物最多 1 GiB；每个 JSON 响应、文件条目、stdout/stderr 和远端执行时间都有边界。申请容量不是硬配额。备份、临时文件、目标数据与 Redis 初始 AOF 的保留副本都需要真实磁盘空间，应在运行前检查控制机、源/目标节点和离机存储的实际余量。

数据库导出会在源 Pod 的本次 `/tmp/ozz-manual-<backupId>` 下保留临时文件。它不写源数据目录；源 Pod 重建后这些临时文件可能消失，已完成的本地产物与校验清单才是保留副本。不要为了本次验收删除 S3/S4 镜像、容器、卷或旧报告，也不需要在 Mac Docker 中加载这些镜像。

## 2. 准备受保护的上下文

在有网络访问控制面及目标 Kubernetes API 的操作者机器、当前仓库 checkout 中运行。先完成项目依赖安装，并构建使用到的基础设施模块：

```sh
pnpm exec node --version
pnpm --filter @ozz/infrastructure build
umask 077
mkdir -p /protected/ozz-s5/context /protected/ozz-s5/backups /protected/ozz-s5/restores /protected/ozz-s5/records
chmod 700 /protected/ozz-s5 /protected/ozz-s5/context /protected/ozz-s5/backups /protected/ozz-s5/restores /protected/ozz-s5/records
```

第一条应使用项目 Node **24.22.1**。示例中的 `/protected/ozz-s5` 是操作者选择的私有路径，替换为当前用户可写的位置。目录须由当前用户持有、限制为 0700；JSON、kubeconfig 和产物须为当前用户持有的普通 0600 文件。工具拒绝符号链接输入和对组/其他用户开放的文件。

准备三个文件，用安全编辑器保存真实认证信息，不把它放入命令参数、终端输出、聊天、报告或 Git：

1. `session.json`：当前管理员会话，唯一字段为 `cookie`，形如 `{"cookie":"ozz_session=<当前会话值>"}`。工具自行通过 `/api/auth/me` 获取 CSRF，并在每个阶段检查会话和恢复锁。不要保存整个登录响应。
2. `cluster.yaml`：本次固定集群的私有 kubeconfig。只支持内嵌 CA、Token 或客户端证书/私钥；拒绝 exec/auth 插件、外部凭证文件、proxy 和跳过 TLS。`server` 必须与产品登记的 `apiEndpoint` 一致，且通过 CA/SAN 验证。需要修正地址时只生成本次私有副本，不修改默认 kubeconfig、全局 Docker/DNS/proxy/TLS 设置。
3. `source-postgresql.json`、`source-redis.json` 或 `source-files.json`：从对应 Volume 的 `manualDataIdentity` 和实际 Service ID 填写。不要凭集群名、Node 名或 PVC 名猜测身份。

PostgreSQL 上下文示例，所有 ID 替换为产品真实返回值：

```json
{
  "apiOrigin": "http://127.0.0.1:4000",
  "appOrigin": "http://localhost:3000",
  "sessionFile": "session.json",
  "kubeconfigFile": "cluster.yaml",
  "serviceId": "55555555-5555-4555-8555-555555555555",
  "engine": "postgresql",
  "expectedIdentity": {
    "installationId": "11111111-1111-4111-8111-111111111111",
    "clusterId": "22222222-2222-4222-8222-222222222222",
    "kubeSystemUid": "33333333-3333-4333-8333-333333333333",
    "environmentId": "44444444-4444-4444-8444-444444444444",
    "volumeId": "66666666-6666-4666-8666-666666666666",
    "pvcUid": "77777777-7777-4777-8777-777777777777"
  },
  "probes": {
    "tables": [{ "schema": "public", "table": "ozz_s5_markers" }]
  }
}
```

`apiOrigin` 是 API 实际 origin；`appOrigin` 必须是本安装配置的 Console origin，用于写入人工记录时的 Origin 检查。HTTPS 可用非本机地址，HTTP 仅允许 loopback。相对文件路径以这个上下文 JSON 所在目录解析。工具没有独立的 Namespace、Node、目标路径、集群覆盖、SQL 或 shell 参数。

Redis 使用 `"engine":"redis"`，并将 `probes` 改为：

```json
{ "database": 0, "keys": ["ozz:s5:marker", "ozz:s5:expires"] }
```

这是**选定字符串键**的验证。固定 Lua 原子读取 `TYPE`、`GET` 原始字节、`PEXPIRETIME` 和服务器时间；工具只保存值的 SHA256，不保存值或 hex。集合、哈希、列表、zset、stream 不可作为首版验证键，避免把内部编码差异误判为数据损坏。RDB 仍完整包含服务器的所有 DB 和数据类型，格式/CRC 由匹配版本的 `redis-check-rdb` 验证。选择同一数据库身份指定的 DB 编号（0–15），1–32 个稳定字符串标记，单值不超过 256 KiB；至少保留一个不会在验收中途过期的业务标记。操作者与 Redis 时钟差异超过 5 秒时停止，不改写 TTL 补偿时钟。

普通文件使用 `"engine":"files"` 和 `"probes":{}`。不能把标记为数据库数据的卷当普通文件卷归档。

PostgreSQL 验证选择 1–32 张用户数据表，每张最多 10000 行，全库最多 256 张用户表。使用适合核对的有界业务/事务标记表，表名和 schema 为受限 ASCII 标识符。完整逻辑 dump 不限于这些选定表。验证同时比较全库用户表列/约束结构及选定表的全部行；先逐行 SHA256，再排序聚合固定长度摘要，保留重复行与行数，避免聚合整张表的原始 JSON。超大单行和超出这些界限的数据校验不在首版范围。

## 3. 采集源备份

先在 Console 刷新源 Service/Volume 观察，确认没有活动任务、未发布草稿、身份漂移或截断。工具还会直接核对 kube-system、Namespace 台账、PVC/PV claimRef、StorageClass、Node、controller/Pod、运行期 Secret 的元数据 UID 和实际挂载；相同 Node 名不会代替 Node UID。

PostgreSQL、Redis 源保持单实例运行并通过产品数据库认证检查。逻辑导出无需把源数据库卷置于维护；文件卷备份必须先通过 Console 停止所有引用该卷的 Service，再进入 **backup 维护**，等待任务成功且真实 Pod 引用归零。只删除挂载草稿不算实际卸载。

```sh
pnpm exec node scripts/manual-data-backup.mjs \
  --context /protected/ozz-s5/context/source-postgresql.json \
  --output /protected/ozz-s5/backups
```

Redis/文件只需换成对应上下文。每次生成新的 UUID 目录，返回 `backupId`、目录、SHA256 和大小。只有全部校验完成后才原子发布 `manifest.json`；不要把 `.pending`、仅有 `operation-intent.json` 或 `failure-*.json` 的目录视为成功备份。

PostgreSQL 在真实 `psql` 会话中保持只读 REPEATABLE READ 事务，`pg_dump --snapshot` 与表/约束证明共享快照。它使用 custom 格式、`--no-owner --no-acl`，不 tar PGDATA、不导出角色密码；结束或失败时停止真实快照客户端。清单的数据时间是取得快照的范围，不用文件 mtime 代替。

Redis 用运行期凭证认证执行 `redis-cli --rdb`，源仍为 AOF everysec。导出前后比较稳定字符串标记及绝对过期时间；只有自然到期可以解释键消失。Redis 复制可能复用已经开始生成的快照，因此清单 `dataTime.from` 明确为 `null`，上界来自导出后的服务器时间；不能把采集起点冒充精确快照时点。

文件 helper 只读挂载 PVC，不设置源卷 fsGroup。工具生成 USTAR，然后逐条验证内容 SHA256、UID/GID、mode、展开大小和结束块，拒绝绝对路径、`..`、反斜线、重复路径、全部软/硬链接、设备、FIFO、PAX/GNU 扩展和特殊权限位。首版保存普通文件/目录及 POSIX UID/GID/mode，不保存 ACL、xattr、SELinux 标签或稀疏布局；需要这些语义的数据不应使用本路径。成功后 helper 已按 UID/版本删除并确认消失，**源 backup 维护仍保留**。

## 4. 形成并验证独立副本，登记备份记录

复制目的地必须由操作者确认在源故障域之外，例如独立主机导出的私有挂载盘。两个同盘目录不构成离机灾备。工具能证明复制前后字节与清单一致，不能从路径证明物理故障域；`location-label` 只用资产标签，不含主机密码、URL Token 或完整私有路径。

```sh
pnpm exec node scripts/manual-data-artifact.mjs \
  --bundle '/protected/ozz-s5/backups/<backupId>' \
  --copy-to /Volumes/independent-backup/ozz-s5 \
  --location-label independent-backup-host-B

pnpm exec node scripts/manual-data-artifact.mjs \
  --bundle '/Volumes/independent-backup/ozz-s5/<backupId>'

pnpm exec node scripts/manual-data-record.mjs \
  --context /protected/ozz-s5/context/source-postgresql.json \
  --bundle '/Volumes/independent-backup/ozz-s5/<backupId>' \
  --copy-receipt '/Volumes/independent-backup/ozz-s5/<backupId>/copy-receipt-<copyId>.json' \
  --output /protected/ozz-s5/records
```

复制不改原 manifest；目标清单和 `copy-receipt-*.json` 在大小、SHA256 与原清单字节核对后发布。现有目录/文件不覆盖。数据库的离线检查只判断格式签名、清单和字节完整性；真正的引擎格式验证已在源导出阶段执行，并将在目标导入前再次执行，不把签名判断说成语义验证。

记录先写本地请求意图，再发往 `POST /api/volumes/<源 volumeId>/manual-data-records`，附带当前会话的 CSRF/Origin。收到 `operator_reported` 回执才保存成功索引。若响应丢失，先查询同一来源的人工记录和 `backupId`，不要自动重发制造重复记录。

文件源在确认 helper 消失、备份和独立副本有效后，可由操作者显式退出原 backup 维护并按原快照恢复源 Service。

## 5. 创建全新的目标并进入 restore 维护

按这个顺序准备 B：

1. **在备份完成后**于目标环境创建新 Service 和新 Volume。目标 Service、Volume 的 `createdAt` 必须晚于 `manifest.completedAt`，Volume/PVC/Service ID 均与源不同。首次发布使新 PVC 从 WFFC Pending 变为可信 Bound，数据库完成空库初始化及认证验证。
2. PostgreSQL/Redis 使用同一固定引擎/版本/布局模板，可以使用新目标生成的凭证；PostgreSQL 库名/用户名可以与源不同，逻辑导入不恢复源角色密码。Redis 的 DB 编号保持一致。目标数据库先不绑定消费者或创建外部入口。
3. 文件目标首次发布使用不会往数据目录写初始化文件、且健康检查不依赖已有业务文件的配置。否则空卷检查会拒绝导入；不要手工删除文件来把旧目标伪装成新空卷。
4. 通过产品停止新 Service，等待真实 Pod 消失；对新 Volume 进入 **restore 维护**，等待任务成功、观察新鲜、全部实际挂载归零。
5. 新建 `target-*.json`，填目标的完整 `manualDataIdentity`、新 Service ID 和 B 的私有 kubeconfig。验证表/字符串键的 `probes` 必须与源清单相同。不要替换源上下文文件。

维护 API 是有限操作，不是命令接口：`POST /volumes/:id/maintenance/enter` 使用当前 `{revision,purpose:"restore"}`；退出使用当前 `{revision,maintenanceId}`。可在 Console 操作并跟踪 Operation。工具不会自行接受 Pending、未知位置、其他挂载、旧快照或同名替代卷，也不会重建丢失的 PVC。

## 6. 导入并保留维护

```sh
pnpm exec node scripts/manual-data-restore.mjs \
  --context /protected/ozz-s5/context/target-postgresql.json \
  --bundle '/Volumes/independent-backup/ozz-s5/<backupId>' \
  --copy-receipt '/Volumes/independent-backup/ozz-s5/<backupId>/copy-receipt-<copyId>.json' \
  --output /protected/ozz-s5/restores
```

helper 的本地创建意图先于 Kubernetes POST 持久化；回执丢失时，只用固定名称、原 nonce、完整预期规格恢复确认。它只复用目标当前已发布运行期 Secret 的引用，读取 Secret 时只请求 PartialObjectMetadata。数据库 helper 以 999:999 运行、只监听 `127.0.0.1`，不进入正式 Service selector；不挂载 ServiceAccount Token，不接受额外容器、生命周期脚本、探针、subPath、设备或交互执行入口。

导入前先把产物放入 helper 的独立临时目录，再核对大小/SHA256 和引擎格式：

- **PostgreSQL**：验证目标 PG_VERSION、凭证、实际版本和空库（无用户关系/函数），使用 `pg_restore --single-transaction --exit-on-error --no-owner --no-acl`。不使用 `--clean` 或 DROP。比较表、全部选定行、关键值和约束摘要后，通过 `pg_ctl` 正常停止并等待落盘。
- **Redis**：先以正常 AOF 配置启动目标初始数据，认证后检查 **全部 DB 的 INFO keyspace 为空**，正常停止。把初始空 `appendonlydir`/RDB 整体保留到新卷的 `.ozz-preserved-<restoreId>`。以 `appendonly no` 加载已校验 RDB并比较字符串标记/绝对 TTL，再 `CONFIG SET appendonly yes`，等待首次 rewrite 完成、AOF manifest 存在、rewrite/写入均为 `ok`、everysec 生效。再次比较数据，`SHUTDOWN NOSAVE` 正常停止。不能仅复制一个 AOF 文件，也不能在旧 AOF 开启时放入 RDB 后宣布成功。
- **文件**：确认 `/data` 根目录为空，只解压本地已经完整验证、且上传后 SHA256 再次匹配的 USTAR，使用 `--keep-old-files`、数字属主和原权限。正式应用启动前重新归档并逐条比较内容、UID/GID 和 mode。

成功导入后只删除本次 helper Pod，使用 UID/resourceVersion precondition，等待远端确认消失。输出 **`restore-prepared.json` / `state: "awaiting-formal-verification"` / `result: "incomplete"`**。这个状态说明导入与临时实例验证完成；维护仍在，不等于正式服务已经恢复。

## 7. 正式启动后再次验证，再接入消费者

确认 `restore-prepared.json` 存在、helper 已消失、无其他挂载。通过 Console 显式退出目标原 restore 维护，按同一已发布快照恢复目标 Service，不改模板、数据路径或凭证。等待正式工作负载及数据库认证观察就绪后运行：

```sh
pnpm exec node scripts/manual-data-verify.mjs \
  --context /protected/ozz-s5/context/target-postgresql.json \
  --bundle '/Volumes/independent-backup/ozz-s5/<backupId>' \
  --copy-receipt '/Volumes/independent-backup/ozz-s5/<backupId>/copy-receipt-<copyId>.json' \
  --prepared '/protected/ozz-s5/restores/<restoreId>/restore-prepared.json'

pnpm exec node scripts/manual-data-record.mjs \
  --context /protected/ozz-s5/context/source-postgresql.json \
  --bundle '/Volumes/independent-backup/ozz-s5/<backupId>' \
  --copy-receipt '/Volumes/independent-backup/ozz-s5/<backupId>/copy-receipt-<copyId>.json' \
  --restore-report '/protected/ozz-s5/restores/<restoreId>/restore-complete.json' \
  --output /protected/ozz-s5/records
```

正式验证再核对原目标 Volume/PVC/PV/Node、controller、快照和真实 Pod/容器身份。PostgreSQL 再查实际版本、目标凭证和表/行/约束；Redis 再比较字符串值/绝对 TTL，并检查正式 StatefulSet 实际 AOF everysec、rewrite 和写入状态。文件内容与权限证明来自维护中重新归档，随后检查正式应用按原快照就绪；应用自身的读取/业务探针由验收另外记录，不能用 Pod Ready 冒充业务读取结果。

只有这一步通过才创建不可覆盖的 `restore-complete.json`。`durationMs` 从第一次导入命令开始计到正式数据验证结束，包含人工退出维护、启动和等待时间。Redis 按绝对过期时间判断自然到期，不会要求恢复后的剩余 TTL 等于备份前的数字。

恢复记录同样发往**源** Volume 的路径，包含原 `backupId`、原大小/SHA256、新目标映射和验证来源。可以先用 `restore-prepared.json` 或 `restore-incomplete.json` 登记明确不完整的尝试，再追加完成记录。最后才由操作者接入消费者或流量；源数据和原入口保留到另行决定。

## 8. 失败、未知结果与重试

每次运行保留 `operation-intent.json`、递增 `stage-*.json`、helper 意图/UID 回执、`.pending` 和经过脱敏的 `failure-*.json`。数据库 stderr 可能包含数据或连接详情，工具不会把它写入报告或终端。命令/网络中断不能证明远端进程已经结束：单条远端命令最多 880 秒，客户端最多 900 秒；检查会话/恢复锁发生在阶段前后，已发出的命令不保证瞬时撤回。

导入失败时新目标保持停止/维护、保留数据和 helper；不要解除维护、强制删除 Pod、替换 UID、清空目标目录或把旧卷再当空卷导入。需要先正常停止并移除遗留 helper 时，使用原目标上下文和本次运行目录：

```sh
pnpm exec node scripts/manual-data-helper.mjs \
  --context /protected/ozz-s5/context/target-postgresql.json \
  --run-directory '/protected/ozz-s5/restores/<failedRestoreId>'
```

该命令只接受原 nonce、UID、预期规格及维护身份。它可以在**仍为 active、身份未变但已经 overdue** 的原锁下完成正常停止和 helper 删除；不能在这个会话中创建 helper、备份或导入。它不会解除维护，也不会把恢复标为完成。Pod/卷/Secret/Node 被替换、观察未知、原锁变化或停止无法证实时仍停止并保留证据。

文件源失败后的 helper 移除用源文件上下文及对应备份运行目录。移除后由操作者核对零挂载，再决定显式退出源 backup 维护。失败恢复的目标保留用于诊断；下一次尝试创建新的 Service/Volume 并使用新运行目录，不覆盖原报告。

如果**正式验证**失败，目标此前已由操作者退出维护并启动。此时不要接入消费者，应立即通过产品停止新 Service、重新进入 restore 维护并保留失败证据。工具不会伪造平台未就绪标记，也不会自动替你改流量。`restore-complete.json` 不会生成。

若人工记录请求超时，保留 `manual-record-intent.json`，先在源卷人工记录中按 `backupId`/目标 ID 对账。字节校验、位置标签、客户端语义验证、实际数据库内容比较和平台的 `operator_reported` 来源是不同事实，报告中分别记录。

## 9. 受控验证入口

本机测试另需 `openssl`、Python 3 和 Bash，用于临时 TLS 证书和进程生命周期桩；业务工具本身不启动本地数据库或 Docker。

```sh
pnpm exec node --test tests/manual-data/*.test.mjs
pnpm exec eslint 'scripts/manual-data-*.mjs' 'tests/manual-data/*.mjs'
pnpm exec prettier --check 'scripts/manual-data-*.mjs' 'tests/manual-data/*.mjs' docs/manual-data-recovery.md
```

测试只创建本次临时文件、临时 TLS 服务与短生命周期客户端桩，覆盖原子发布/复制、tar 攻击与损坏、SQL 标识符边界、选定字符串值/绝对 TTL、真实进程 PID 释放、完整三类协议工作流、节点/卷/Secret 身份替换、typed List 省略 TypeMeta、截断/禁读/其他挂载、helper 规格漂移、丢失创建回执、空目标拒绝、AOF rewrite 失败、维护超时清理及人工记录来源。具体通过数以带时间戳的 [验收目录](acceptance/) 报告为准。

本地 A→B 的真实执行入口、重入规则和最终验收结果见 [恢复探针说明](manual-data-recovery-probe.md)。协议测试和真实恢复报告分别保留，副本位置的物理故障域仍以报告中声明的范围为准。
