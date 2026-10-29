# S1 控制面备份与恢复

本流程备份 PostgreSQL 控制面数据库及其匹配主密钥，在一个新的空数据库中恢复。数据库导入、恢复锁和执行代次递增在同一事务内提交；恢复完成后仍然只读，不自动恢复任务执行。

脚本只使用 Node 24 内置模块和 Docker 中的 PostgreSQL 客户端，不依赖宿主机的 `pg_dump`、Prisma 或应用构建产物。项目环境可用 `pnpm exec node` 调用；紧急恢复时也可直接使用已安装的 Node 24。当前验证版本为 Node 24.22.1、PostgreSQL 17.11，默认客户端镜像与 [本地 Compose](../compose.dev.yaml) 相同。默认镜像摘要在 ARM64 上验证；其他架构须选择匹配的 PostgreSQL 17 镜像并另行验证。

## 备份内容与边界

数据库归档包含表、数据、约束、触发器、迁移记录、审计、凭证密文和 Operation/Outbox。备份不导出 PostgreSQL 角色与属主授权，恢复对象归目标数据库用户所有。使用独立控制面数据库；本流程不备份应用集群中的卷、业务数据库或 Git 仓库。

主密钥原样保存到另一个目录，保留当前及历史版本。它不会进入数据库归档目录、清单、标准输出或日志。数据库与密钥清单记录同一备份 ID、两个文件的 SHA256、源库名、控制面 schema、执行代次、迁移清单和所需密钥版本。

备份建立 PostgreSQL 导出的只读一致性快照。`pg_dump`、密钥验证记录及各凭证密钥版本样本共享此快照，正在提交的元数据不会把数据库与密钥核对拆成两个时点。发现未完成的迁移、缺失的历史密钥或无法认证的密文时，备份失败并清理本次新建的不完整目录。

新版数据库清单的 `snapshotObservation` 保留导出快照标识、`pg_current_snapshot()` 的完整事务可见性边界，以及数据库和备份进程观察到的时间区间。事务 ID 以十进制字符串保留，不能转换为可能丢失精度的 JavaScript Number。两份清单共同记录 `snapshotObservationSha256`，将该观察与这份 `database.dump` 的 SHA256 配对；恢复前校验结构与配对，成功恢复收据保留该引用。原格式 1 中完全没有这些字段的旧备份仍可恢复，其快照观察保持未知。

这些记录明确的是 MVCC 的逻辑恢复边界。`createdAt` 是备份完成标签，数据库时间的前后观察也不是快照获取瞬间；`exactAcquisitionTimeKnown` 固定为 `false`。数据库墙钟倒退时 `databaseTimeBounds.ordered=false`，该墙钟区间不能用于 RPO。客户端耗时来自单个进程的单调时钟，不与其他进程时钟相减。精确逻辑边界和带上下界的恢复点时间应分别报告。导出标识在备份事务关闭后仅供追溯，恢复使用归档文件，不重新导入已失效的快照标识。

两个目录分开保存不等于异机备份。密钥备份仍包含原始密钥；应独立保管在受限位置，并按实际部署方案复制到独立存储。SHA256 用于完整性和配对检查，不是备份加密或来源签名。S1 本地验证没有声称完成异机传输、公网切换或目标机 RPO/RTO 验收。

Redis 是队列传输层，不是任务事实来源。本流程不恢复 Redis AOF；新控制面使用独立 Redis 实例或新卷，任务历史及投递依据来自 PostgreSQL。Caddy 证书数据、部署配置与镜像版本需按 [部署记录](acceptance/S1-deployment.md) 另行保留；这里的主密钥是凭证加密密钥，不是 TLS 私钥。

## 创建备份

环境文件和源主密钥必须为普通文件，权限为 `0600` 或更严格。`MASTER_KEY_FILE` 推荐使用绝对路径；脚本中的相对密钥路径相对于环境文件所在目录。

本地 PostgreSQL 已通过 `compose.dev.yaml` 发布到回环地址时：

```sh
pnpm exec node scripts/backup-control-plane.mjs \
  --env-file .env \
  --database-dir backups/postgresql \
  --key-dir .secrets/key-backups \
  --label before-upgrade-20261025
```

正式 Compose 不向宿主机发布 PostgreSQL 端口，因此使用容器内客户端：

```sh
pnpm exec node scripts/backup-control-plane.mjs \
  --env-file .env.production \
  --compose-file compose.yaml \
  --project ozz \
  --database-dir backups/postgresql \
  --key-dir .secrets/key-backups \
  --label before-upgrade-20261025
```

将环境文件和项目名称替换为实际部署值。Compose 模式显式使用所选环境文件中的 `POSTGRES_DB`、`POSTGRES_USER` 和 `POSTGRES_PASSWORD`，不依赖容器原有 `POSTGRES_DB`。直接连接模式使用环境文件中的 `DATABASE_URL`；其密码通过客户端环境传递，不放入命令参数。

不提供 `--label` 时生成带时间的唯一 ID；已存在的同名备份不会被覆盖。两个目标目录不得相同或互相嵌套，符号链接解析后也必须分离。每份备份生成如下结构：

```text
backups/postgresql/<ID>/       # 0700
  database.dump               # 0600，pg_dump custom 格式
  manifest.json               # 0600

.secrets/key-backups/<ID>/     # 0700
  master-key.json              # 0600
  manifest.json               # 0600
```

成功时退出码为 0，标准输出为包含备份 ID 和两个目录的 JSON。只有两份清单均完整且配对、文件校验通过，恢复脚本才接受该备份。不要只复制 `database.dump` 而遗漏清单与匹配密钥。

## 恢复到新目标

恢复目标必须为空数据库，库名必须不同于备份源库。脚本不支持覆盖恢复，也不自动创建数据库或更换凭证；先使用新部署的 PostgreSQL 配置建立空库。数据库名称可例如设为 `ozz_recovered_20261025`，控制面 schema 保持备份中的名称，S1 默认是 `public`。

正式部署先准备新项目的受限环境文件，再只启动基础设施：

```sh
docker compose --env-file .env.restore -f compose.yaml \
  --project-name ozz-restore up -d postgres redis
```

此时不要启动 API、Worker 或迁移服务；备份中已经包含对应版本的迁移记录。目标环境中的 `POSTGRES_DB` 必须是新空库。恢复密钥使用一个尚不存在的新文件路径，不能用初始化时随机生成的另一份密钥替代备份密钥。

```sh
pnpm exec node scripts/restore-control-plane.mjs \
  --env-file .env.restore \
  --compose-file compose.yaml \
  --project ozz-restore \
  --database-backup backups/postgresql/before-upgrade-20261025 \
  --key-backup .secrets/key-backups/before-upgrade-20261025 \
  --target-key-file .secrets/restored/master-key.json
```

本地隔离验证可省略 `--compose-file` 和 `--project`，在受限目标环境文件的 `DATABASE_URL` 中指定新空库。直接模式在 Docker Desktop 使用 `host.docker.internal` 访问宿主机回环端口，在 Linux Docker 宿主机使用 host 网络访问本机数据库；远程 Docker daemon 不在本次验证范围内。

恢复过程执行以下检查和转换：

1. 验证两份清单、备份 ID、文件哈希、密钥版本及新密钥路径；拒绝现有密钥文件、数据库备份目录内的密钥目标、源库名或非空目标库。
2. 将归档转换为 SQL，并在显式 `BEGIN`/`COMMIT` 事务内导入。只有归档完整、恢复锁与代次更新已加入后才发送 `COMMIT`；归档失败或脚本中断导致的提前 EOF 均回滚，避免客户端自动提交半份导入。
3. 同一事务内设 `restoreLocked=true`、`generation=备份代次+1`，撤销恢复出的会话，清空旧 Worker 心跳，并写入恢复审计。
4. 提交后验证密钥认证，再以 `0600` 创建新主密钥文件及 `<主密钥文件>.restore.json` 收据。Linux 以 root 执行 Compose 恢复时，仅将本次新建主密钥文件的属主设置为目标环境的 `OZZ_RUNTIME_UID:OZZ_RUNTIME_GID`（默认 `1000:1000`），使文件挂载后可被 API/Worker 读取；不放宽权限，也不修改源备份或既有密钥。收据明确要求 `RESTORE_MODE=true`，不会自动解锁。

Linux 使用非 root 用户执行 Compose 恢复时，该用户 UID 必须与目标 `OZZ_RUNTIME_UID` 一致；不匹配会在数据库导入前以 `RUNTIME_KEY_OWNER_MISMATCH` 拒绝。目标 UID/GID 必须是有效 Unix 数字 ID。macOS Docker Desktop 的文件共享不使用该 Linux `chown` 路径；脚本保留调用者创建的 `0600` 文件。

若提交后密钥认证或密钥文件发布失败，目标数据库保持锁定，不发布未经验证的密钥。不要绕过错误启动写入；保留该目标用于核对，或另建空库重新恢复。原数据库与原密钥始终保留。

## 只读核对与解锁

使用与备份对应的应用和迁移版本。将新目标环境的 `MASTER_KEY_FILE` 改为恢复出的绝对路径，设置 `RESTORE_MODE=true`，然后启动其余服务。API 与 Worker 都会验证密钥文件和既有验证密文。

```sh
docker compose --env-file .env.restore -f compose.yaml \
  --project-name ozz-restore up -d
```

管理员密码哈希随数据库恢复，使用原密码重新登录；旧会话已失效。核对项目、环境及目标集群归属、凭证元数据、迁移版本和操作历史。写接口应返回 `503 RESTORE_READ_ONLY`，Worker 状态应为 `paused`；API 持久化 readiness 保持可用，Worker 的执行 readiness 在恢复期间不就绪。

历史成功任务保留原结果。恢复出的未完成任务仍保留历史状态，但其执行代次已过期；解锁后 Worker 会将这些任务结束为 `RECOVERY_GENERATION_CHANGED`，不会自动重放。需要继续的工作在核对后新建任务。

启用 S6 Git 构建后，人工核对还必须使用**独立于数据库备份保存的 Builder 部署清单**，逐个核对安装 ID、实例 ID、可信端点、签名身份和当前 mTLS 凭证归属。`--reconciled` 同时确认这项人工盘点已经完成。自动流程只能枚举恢复数据库中存在的 Builder；禁用的 Builder 和没有本地 BuildRun 的 Builder 也在检查范围内。它能发现这些实例上备份遗漏的运行，但不能发现连 Builder 登记行也被备份遗漏的额外实例。

若独立清单中有额外实例，保持恢复锁，先用该实例当前可信 mTLS 身份取得其签名运行清单，核对仍在执行的进程并保存真实结束证明。本节的 `inspect` / `accept` **只处理恢复库已有可信 Builder 登记的历史运行**，不登记备份遗漏的 Builder，不导入其凭证或替换签名身份。当前没有针对整条 Builder 登记丢失的受控恢复入口；该情形仍属恢复阻断，不能确认盘点完成或将它计作已恢复写入。不要依据等待时长认定构建结束，也不要为通过检查伪造本地运行行或清除远端账本。

### 只有旧备份、Builder 保留备份后的已结束运行

恢复点之后的 Git 构建可能已结束，但对应 Deployment / BuildRun / 来源等元数据不在旧备份中。默认解锁仍报 `UNKNOWN_REMOTE_RUN`，即使远端已有签名结束证明也不会自动接纳。此时不需要也不能假定原数据库仍能补取一份新备份；按以下步骤明确核对这些外部历史。

1. 保持恢复库的持久锁，核对数据库外的完整 Builder 部署清单，以及 Kubernetes 中较新 revision 和备份外受管资源。现有资源保持原样；Builder 历史核对不会处理这些工作负载差异。
2. 用下面的只读命令生成一个新的私有 JSON 文件，逐项审阅其中的完整未知运行列表。它访问所有已登记 Builder，包括禁用实例；验证新鲜签名身份、完整分页清单，以及每个未知运行的签名结束证明。未结束、失联、缺页或证明不匹配时失败，不输出可接纳的部分清单。生成文件不会 fence、写数据库或解锁。
3. 确认列表与运行面符合实际后，显式接纳该文件。接纳在持久恢复锁事务内重新读取全部签名清单与结束证明，要求本次恢复实例、本地事实、可信身份和清单均与审阅内容相同。任一变化要求重新生成、审阅新文件。接纳只写专用审计记录，仍保持只读。

本地连接方式、与备份匹配的构建产物和新的恢复环境文件示例：

```sh
pnpm exec node --env-file=.env.restore apps/api/dist/cli.js \
  recovery:inspect --output /absolute/private/recovery-review-01.json

# 审阅文件及独立运行面证据后，明确确认备份后的业务历史元数据仍然缺失。
pnpm exec node --env-file=.env.restore apps/api/dist/cli.js \
  recovery:accept --manifest /absolute/private/recovery-review-01.json \
  --acknowledge-missing-history
```

正式 Compose 使用本节已有的 `run --rm --no-deps api /app/dist/cli.js` 入口，并将当前运行 UID 可访问的私有审阅目录显式 bind mount 到容器，再使用容器内路径传入 `--output` / `--manifest`。目录须为 `0700`，文件由 inspect 以 `0600` 新建且不覆盖旧文件；accept 拒绝符号链接、宽松权限或大于 16 MiB 的文件。不要将只留在一次性容器内的文件当成已保存的审阅证据。

清单绑定当前恢复库和 schema 的身份哈希、installation ID、generation、锁定时间及本次正式 restore / lock 审计 ID。恢复旧备份、建立新的恢复锁或重新创建同名目标库，都不能继承旧清单的授权。若已有锁来自不含本次审计标记的旧版工具，先用当前 `recovery:lock` 建立明确的新恢复实例，再 inspect；接纳后重复加锁也要求重新审阅。相同 review ID 与内容在当前记录未被替代时可安全重试，接纳回执给出审计 ID；后续完整审阅取代旧记录，不合并多个零散授权。

`--acknowledge-missing-history` 确认的只是：文件明确列出的、已经可信结束的备份外运行可作为外部历史保留。它不会生成假的 Deployment / BuildRun、重建丢失的来源与发布记录、重新构建、授予认证、取消远端执行或删改 Kubernetes 资源。清单与审计中的 `historyMetadataRestored=false` 保留这一限制。RPO 仍以实际备份中的数据时间点计算，Builder 的结束证明不能缩短已丢失业务元数据的时间区间。

接受历史记录也不等于 Kubernetes 差异已经解决。仍须完成前述独立盘点与安全写入核对，才能继续以下完整解锁流程。此后清单新增或缺少运行、任一运行身份/epoch/ledger/proof 变化、失联或签名错误都会再次保锁；没有列入当前有效接纳记录的未知运行仍被拒绝。

确认新目标可用后，先把环境文件的 `RESTORE_MODE` 改为 `false` 并重建 API/Worker。此时数据库内的持久恢复锁仍然有效，业务写入依旧被拒绝：

```sh
docker compose --env-file .env.restore -f compose.yaml \
  --project-name ozz-restore up -d api worker
```

最后执行已有的显式核对解锁命令：

S6 解锁先验证主密钥，再对可枚举的每个 Builder 发出显式 generation fence，并读取该安装的完整签名分页清单。新 generation 大于本地及已观察到的所有 Builder 高水位；普通 Builder 验证、构建提交、租约续期及上述 inspect / accept 不会执行这次升代。若本次恢复有显式接纳记录，只允许这次 fence 改变全局高水位；完整运行集合及每个运行的 epoch、ledger revision 和证明必须保持审阅时的事实，并重新验证每个被接纳运行的真实结束证明。在持久锁事务内，CLI 再核对一次清单和接纳记录是否变化，保存已验证的本地结束证明或确实未提交的关闭事实，最后才解除锁。未接纳的未知运行、未结束运行、缺页、失联、签名或身份不匹配都会保留锁和任务槽位。解锁审计关联所用接纳审计 ID 与运行数量。一次失败的核对可能已经持久升高部分 Builder 的 generation；重试会重新读取高水位，不回放旧任务。

```sh
docker compose --env-file .env.restore -f compose.yaml \
  --project-name ozz-restore run --rm --no-deps api \
  /app/dist/cli.js recovery:unlock --reconciled
```

省略 `--reconciled` 时 CLI 拒绝解锁；仅去掉环境开关也不会解除持久锁。解锁后创建一个新的无服务器副作用诊断，验证排队、执行、结果和日志，再按部署计划处理入口切换。S6 会执行上述 Builder 代际隔离；此流程不会提交新构建或修改应用集群工作负载。

## 故障与退出状态

脚本失败时退出码为 1，标准错误只输出稳定错误码和安全说明，不透传数据库驱动输出或连接串。常见错误：

| 错误码                                                                    | 处理                                                                                                                                               |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARGET_NOT_EMPTY` / `SOURCE_DATABASE_REFUSED`                            | 选择名称不同的新空库；不清空当前数据库                                                                                                             |
| `OUTPUT_EXISTS`                                                           | 选择新的备份标签或恢复密钥文件，不覆盖已有文件                                                                                                     |
| `BACKUP_PAIR_MISMATCH` / `BACKUP_CHECKSUM_MISMATCH`                       | 找到同一备份 ID 的完整两份备份并重新核验传输                                                                                                       |
| `INVALID_SNAPSHOT_OBSERVATION` / `BACKUP_SNAPSHOT_MISMATCH`             | 核对新清单的完整快照观察、数据库归档与密钥清单配对；保留原材料，不手工删除字段绕过失败                                                               |
| `MASTER_KEY_MISMATCH`                                                     | 使用保留全部历史版本的匹配主密钥，不生成替代密钥                                                                                                   |
| `INVALID_RUNTIME_OWNER` / `RUNTIME_KEY_OWNER_MISMATCH`                    | 检查目标 UID/GID；Linux Compose 恢复使用目标 UID 或 root                                                                                           |
| `SCHEMA_MISMATCH`                                                         | 目标配置使用备份中的 schema 名称                                                                                                                   |
| `DATABASE_ARCHIVE_INVALID` / `DATABASE_RESTORE_FAILED`                    | 导入未完成；核对归档、目标版本及空间，检查目标仍为空或锁定                                                                                         |
| `POSTGRES_CLIENT_FAILED`                                                  | 检查 Docker、已缓存的 PostgreSQL 17 客户端镜像、连接及权限                                                                                         |
| `BUILD_RECOVERY_BLOCKED`                                                  | 根据有界 `issues` 中的 Builder/Run ID 核对完整清单、可信身份和结束证明。已有登记且已可信结束的未知运行按 inspect / accept 显式处理；不提供跳过开关 |
| 其中 `RECOVERY_SCOPE_CHANGED` / `RECOVERY_INSTANCE_UNRECORDED`            | 当前恢复实例与审阅文件不匹配，或缺少正式恢复标记；保留锁，使用正确恢复实例重新生成审阅文件                                                         |
| 其中 `REVIEW_CHANGED` / `ACCEPTANCE_STALE` / `ACCEPTED_INVENTORY_CHANGED` | 本地事实、完整运行清单或证明在审阅后改变；保留原证据，重新核对并生成新清单                                                                         |

脚本不会隐式拉取镜像。开始前保证所需客户端镜像已在本机；直接模式可通过 `--tools-image` 或环境中的 `POSTGRES_IMAGE` 指定经过验证的 PostgreSQL 17 镜像。Compose 模式使用该项目 PostgreSQL 容器中的客户端。

## 本地验收证据

2026-10-25，在真实 PostgreSQL 17.11、Node 24.22.1 和 Docker ARM64 上运行：

```sh
pnpm exec node --env-file=.env node_modules/vitest/vitest.mjs run \
  --config vitest.integration.config.ts tests/integration/recovery.test.ts
```

测试使用唯一的临时源库、多个空恢复库和私有目录，未替换开发环境数据库、`.env` 或主密钥。已验证 8 项集成场景：双密钥版本及完整数据恢复、SQL 归属约束保留、恢复代次与显式 CLI 解锁、旧任务隔离、会话失效、拒绝危险目标/密钥路径、错误密钥与缺失版本、归档损坏后的全事务回滚，以及恢复进程在 COPY 阶段被 SIGKILL 后的全事务回滚。该次运行共 9.35 秒；验证完成后仅清理测试创建的数据库与目录。

正式 Compose 的同源 HTTPS、内部端口、健康检查与资源验证记录在 [S1 部署验收](acceptance/S1-deployment.md)；异机灾备和 Oracle 目标机验证需要在实际部署环境单独完成。

2026-10-26，显式 Builder 历史核对新增了独立新 PostgreSQL 库中的窄回归：首次运行 27 项通过，随后针对正式 restore 事务审计绑定和 101 个运行的完整分页补验 2 项通过，共 29 个不同检查。包括本机真实 mTLS 连接下的生产 CLI 三步流程、接纳幂等、恢复实例隔离、缺少明确确认、清单/证明变化、未结束及失联继续保锁，且不创建缺失的 Deployment / BuildRun。签名协议由受控 Builder 夹具提供，未对真实 Builder 发 fence。记录保留在 `.local/s6-a/recovery-cli-tests/20261026T055917637Z-2dc9d495/initial.json` 与 `restore-scope-and-pagination.json`；真实旧备份、K3s 差异和原控制面回归按 [L06 驱动](acceptance/g-mvp-recovery-local-lab.md)另行执行。
