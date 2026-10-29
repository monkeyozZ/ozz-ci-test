# G-MVP L06 本地控制面恢复增量

日期：2026-10-28。状态：**旧备份、最终一致备份及原库对账、两个连续性采样窗口、恢复后 HTTPS 认证，以及独立元数据恢复计时样本均已有通过证据。** 原始恢复与失败记录见[恢复结果](g-mvp-recovery-local-results.json)，新增 6 项认证/页面检查见[HTTPS 结果](g-mvp-recovery-https-results.json)，4 项独立恢复检查与分段计时见[计时结果](g-mvp-recovery-timing-results.json)。独立样本没有 Builder/K3s；其 RTO 不与原恢复窗口合并。PostgreSQL 精确快照点、含远端对账的独立完整 RTO、生产 Secure Cookie 及 S6 Linux 交付仍未由这些结果证明。

## 本次实测

| 范围             | 结果                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 原控制面全停     | 2026-10-26 16:25:45–16:25:47（Asia/Shanghai）停止 API/Worker/Redis；在任何恢复样本启动前采样 7 轮，首末起点相隔 31.514 秒。A/B HTTP 均正确跳转、HTTPS 均为 200 且校验证书与内容，A PostgreSQL/Redis 标记均可读取；28 次目标检查全部通过                |
| 旧备份恢复       | 在新空库恢复 13 个 BuildRun、57 个 Deployment、20 个 Service。真实 Builder 中额外 15 个已结束 run 使恢复保持只读；1 个较新 K3s 控制器与 6 个备份外控制器均保留。显式审阅并接纳缺失历史后，正式 CLI 解锁到 generation 3，新诊断成功                     |
| 最终一致备份恢复 | 另一个新空库恢复 28 个 BuildRun、85 个 Deployment、33 个 Service；正式只读启动、完整签名清单、generation 4 解锁和新诊断通过，原业务事实与 K3s 资源保持                                                                                                 |
| 回到原数据库     | 2026-10-28 11:14:01（Asia/Shanghai）正式对账完成，原库与 Builder 高水位一致为 generation 5，`originalNeedsReconcile=false`；原 `.env`、主密钥、业务事实和 K3s 资源保持                                                                                 |
| 重启后连续性     | 2026-10-28 11:41:25–11:41:59（Asia/Shanghai）核对原 API/Worker 进程及 Redis 端口已运行；再次采样 7 轮、28 次目标读取，首末起点相隔 30.595 秒，应用 HTTP/HTTPS 与数据库标记全部通过                                                                     |
| 恢复后 HTTPS     | 2026-10-28 20:47:49–20:47:53（Asia/Shanghai）完成 6 项检查和 5 张截图：严格 CA/hostname 校验、API/浏览器分别登录、原身份保留、4 个关键页面及前后身份一致。16 个项目、33 个服务、85 个发布与 generation 5 保持；0 业务写请求、页面错误或非预期 API 失败 |
| 独立恢复计时     | 2026-10-28 19:11:42–19:12:10（Asia/Shanghai）的独立元数据样本完成 4 项检查；从关闭样本 API/Worker 前到同源 HTTPS 新代次诊断及元数据复核成功为 14.537213 秒。恢复 revision 2，备份后已确认的 revision 3 仅保留在源库；无 Builder/K3s 登记               |

恢复驱动累计 13 项检查通过，保留 6 次失败尝试及其后续成功报告。曾修正 Docker 卷不存在错误的识别、隔离 Redis 的启动用户和 Builder 小清单占用分页缓存的问题；没有重建旧库、抹除失败历史或重放应用。旧备份缺失的 15 个 BuildRun 等业务历史仍然缺失，显式接纳只记录审阅结果。两份恢复样本均无未完成任务，本轮没有实测旧排队任务终态化。

旧、最终样本从恢复意图到导入收据分别为 4.122 秒和 2.564 秒。最终样本从恢复意图到新诊断成功为 19.799 秒，完整 `final` 阶段为 21.102 秒；原库 `return-original` 阶段为 12.494 秒。旧样本包含工具修复和人工核对，会话又在 10 月 26–28 日之间中断，不能将这些间隔作为恢复性能结论。原备份清单只保存归档生成时间，没有 PostgreSQL 精确快照时刻；原演练的精确 RPO 和独立完整 RTO 仍留空。下方新增计时属于另一份明确隔离的元数据样本，全停和重启后两个采样窗口也不证明中间整个时段持续可用。

## 恢复后 HTTPS 与独立计时补验

[HTTPS 结果](g-mvp-recovery-https-results.json)绑定原库恢复记录与 generation 5，使用真实返回的当前 Git 已发布 Deployment `19cf6191-2ac5-44ce-a69f-8f6182d25c6b`。独立 API 客户端严格校验私有 CA 和 IP SAN；浏览器在该校验后允许本地测试证书，**没有验证浏览器系统信任库**。页面使用真实网络，没有响应 fixture；唯一写操作为登录/退出。检查后两个会话均撤销，浏览器及数据库连接关闭，未保存密码、Cookie、CSRF、storage state、HAR、trace 或视频。当前 development Cookie 的 `Secure=false` 如实保留，生产策略随 L07 交付验收。

首轮 HTTPS 检查在关键页面定位时失败：同名导航 `h2` 与内容 `h1` 使 Playwright 的标题选择器产生歧义。原报告及 2 张截图保留；限定标题后第二轮 6 项通过。成功报告的 13 个步骤、截图和恢复 state 引用 SHA256 已核对。原报告未记录执行时探针源码哈希，汇总中另列当前探针/助手的只读核对哈希，不把它当作历史源码或完整运行包证明。

使用已有 S6 公共运行环境，入口如下；无需再启动第二套 API/Worker 或初始化管理员。该探针绑定本轮保留的恢复 state、generation 5 和资源身份，后续状态变化应先核对，不能改记录取得通过。

```sh
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node apps/console/tests/local-lab/g-mvp-recovery-https.mjs
```

[计时结果](g-mvp-recovery-timing-results.json)使用单进程 `process.hrtime.bigint` 时钟，UTC 仅作事件标签。通过正常 API 写入并确认恢复点 revision 2，完成正式备份后再写入 revision 3；故障后在新空库通过正式恢复工具导入，验证旧会话失效、凭证可解密、只读锁/Worker paused、正式解锁与新代次诊断。目标仍为 revision 2，较新的 revision 3 仅在保留源库中存在，没有把丢失更新伪造回恢复库。

| 本次独立样本的计时               | 实测范围                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------- |
| 已确认恢复点到故障的间隔         | 2.254297 秒；这是可观测确认点的 RPO，不是精确 SQL commit 或快照时刻               |
| 恢复点 commit 的 RPO 上下界      | 2.254297–2.331709 秒，commit 位于该写请求开始和确认之间                           |
| 备份快照的 RPO 上下界            | 0.046843–2.245025 秒，快照位于备份命令执行期间；`exactPostgresSnapshotRpoMs=null` |
| 故障到只读可用 / 正式解锁 / 可写 | 11.558904 / 13.645179 / 13.928679 秒                                              |
| 故障到新诊断及最终复核完成       | 14.537213 秒，其中数据库导入阶段为 7.519792 秒                                    |

这份样本的源码/API CLI/Worker 入口 8 个 SHA256 均与保留记录一致；这些有限文件不代表完整依赖图或新 Linux 发布包。首轮在计时窗口前以 `GMVP_TIMING_UNEXPECTED_FAILURE` 失败，记录与原探针哈希保留；后续成功没有覆盖该失败。两份尝试的自有进程/Redis 容器均已停止，数据库、备份、密钥与卷均保留。

复现入口如下。它创建新的隔离源库/目标库和 Redis 样本，不使用原应用数据，也不对现有 Builder/K3s 执行 fence、迁移或恢复。仍须由 root 排定单个重型运行窗口并核对当前磁盘/内存，结果不与旧样本拼接。

```sh
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node tests/probes/g-mvp-recovery-timing-local-lab.mjs run
```

源库和目标库共用本地 PostgreSQL；Node 构建产物、缓存镜像、TLS 入口与数据库管理凭证在故障前已准备。计时包含目标空库、备份本地复制、导入、Redis 创建、API/Worker 启动、无远端目标的对账及 HTTPS 检查，不包含人工发现、远程下载、主机准备、DNS 切换或真实 VPS。**精确 PostgreSQL 快照点与含真实 Builder/K3s 对账的独立完整 RTO 仍须另验**；不能把此处 14.537213 秒与原恢复演练的阶段耗时合成为全流程结果。

## 原恢复驱动入口

入口为 `tests/probes/g-mvp-recovery-local-lab.mjs`，只读 K3s 清单助手为 `tests/probes/support/g-mvp-recovery-k3s.py`。使用 Node 24.22.1：

```sh
export NODE_OPTIONS=--max-old-space-size=1536
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs status
```

## 运行窗口与顺序

先完成 B 的 Builder 故障矩阵、root 的 L05、UI 观察与最终工程构建，再由 root 确认原 API/Worker 空闲。驱动要求零 queued/running Task、零未闭合 BuildRun 和零 waiting WebhookTarget，不暂停 Worker 制造排队样本，也不绕过 `local-runtime stop` 的活动任务保护。

如果前一 C/PVC 窗口停止了 Builder，root 须先完成该窗口的设备/内存协调并恢复原 Builder 的可信连接，再执行 prepare；L06 不负责启停 Builder，也不能在它失联时取得最终完整清单。

原控制面仍在线时：

```sh
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs prepare
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs capture-final
```

`prepare` 读取原环境、主密钥身份、旧备份配对、独立 Builder 部署身份及完整签名清单，写入私有目标配置；此步不创建数据库、不 fence、不启停运行进程。默认旧备份为 `g-mvp-s6-before-faults-20261026T045124227Z`。使用其他源配置或备份时，所有后续命令必须重复相同的 `--source-env` / `--old-backup` 参数。

`capture-final` 调用正式备份脚本保存最终一致样本及匹配密钥，并记录原库事实与 A/B K3s 资源基线。它必须等所有故障与产品写入结束；保存备份意图后如果原事实变化，拒绝沿用该意图。

接下来由 **root** 正式停止原 API、Worker，再单独停止原 Redis。**Redis 的精确停止点是 `capture-final` 成功、`local-runtime stop` 已确认 API/Worker 退出之后，执行 `old` 之前。** `local-runtime stop` 本身不停止 Redis；PostgreSQL 必须保持在线，供新空库创建、restore 和恢复 CLI 使用。

默认 `.env` / `compose.dev.yaml` 部署的操作顺序如下，均由 root 执行：

```sh
pnpm exec node --env-file=.env tests/probes/local-runtime.mjs stop
docker compose --env-file .env -f compose.dev.yaml stop --timeout 10 redis
```

Compose 项目名为 `ozz-dev`，默认原 API/Worker 端口为 3000/3001，原 Redis 为 `127.0.0.1:56379`，PostgreSQL 为 `127.0.0.1:54320`。以本次源环境的实际端口为准。只 stop 原 Redis 服务，保留同一容器和 `redis-data` 卷；不执行 Compose down，也不停止 PostgreSQL。若 Redis 仍在线，驱动会在任何原库锁定/恢复动作前以 `GMVP_RECOVERY_ORIGINAL_REDIS_PORT_ACTIVE` 拒绝继续。

在**原 API/Worker/Redis 已停、任何恢复样本尚未启动**的区间采集下述连续性证据，再执行 `old`。驱动不调用原运行器的 stop/start，也不重启 A/B、Builder 或 Pebble。

```sh
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs old
```

`old` 先通过正式 CLI 锁定保留的原数据库，再把旧备份与匹配密钥恢复到新的空数据库。它启动隔离的只读 API/Worker，验证写入被拒绝和 Worker paused；随后保存恢复出的未完成工作清单。只有该清单为空，才调用生产 `BuildRecovery.prepare()`，记录真实 fence 及 `UNKNOWN_REMOTE_RUN` 保锁结果。备份后的真实 Webhook BuildRun、K3s 较新 revision 和备份外 controller 必须同时存在，资源保持原样。

此步最后通过正式 `recovery:inspect` 生成私有审阅文件，路径及 SHA256 写入 state/report。**到此仍未接纳未知运行，也未解锁旧样本。** root 须审阅文件中的完整未知运行列表、签名结束证明与独立 K3s 差异证据，再明确执行下一阶段：

```sh
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs old-accept
```

`old-accept` 使用原审阅文件及 `--acknowledge-missing-history` 调用正式 `recovery:accept`，验证只新增对应审计且持久锁仍开启；然后切换自己隔离进程的环境开关，通过正式 `recovery:unlock --reconciled` 完成新的 fence、完整清单重核与解锁。它核对解锁审计确实引用该接纳记录，创建一个新 generation 的诊断并要求成功。旧样本的 Deployment / BuildRun / 来源等缺失历史不会被伪造回来，结果保留 `historyMetadataRestored=false`。

本轮驱动只解锁没有未完成 Task、未闭合本地 BuildRun 或 waiting WebhookTarget 的恢复样本；遇到这些额外差异保留锁，不能由探针自动补数据或重放。旧任务代次隔离复用 S1/S6 的 PostgreSQL 回归，L06 报告明确 `oldTaskTerminalizationTestedInThisRun=false`，不将零未完成任务描述成测过实际终态化。

默认旧备份的数据库/密钥 manifest 均为 complete，所列数据库与主密钥 SHA256 配对一致；数据库 manifest 的 generation 为 0，列出 S6 迁移，归档生成于 `2026-10-26T04:51:29.712Z`。**manifest 没有 Task / BuildRun / WebhookTarget 数量，不能据此推断旧样本空闲。** 若实际恢复后发现未完成工作，`old-idle-admission` 在第一次 Builder fence 前以 `GMVP_RECOVERY_RESTORED_UNFINISHED_WORK_REQUIRES_REVIEW` 退出；state/report 的 `oldWorkAdmission` 给出计数和私有证据文件，其中保留具体 Task / Run ID、状态和 generation。该样本保持锁定，不生成可供跳过这些差异的接纳记录，不计作旧备份恢复通过。

接着运行独立的最终一致样本，并回到原数据库：

```sh
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs final
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs return-original
pnpm exec node tests/probes/g-mvp-recovery-local-lab.mjs status
```

`final` 把最终一致备份恢复到另一个新空库和新密钥文件，验证只读状态，再通过原完整清单/fence/unlock 流程及新诊断。它是单独样本，不代替旧样本的恢复结果。

**一旦 state/report 的 `originalNeedsReconcile=true`，无论样本后来是否通过，都须执行 `return-original`。** 此标记在尝试锁定原库之前保存；即使旧样本因未完成工作而在 fence 前退出，原库也可能已经正式锁定。一次失败的 Builder 核对还可能升高真实高水位。该命令可在样本失败后独立使用：只停止自己登记的样本 API/Worker/Redis，核对原数据库的事实仍与最终备份一致，再对原数据库执行正式 lock/unlock，直到其 generation 与新鲜签名 Builder 高水位一致。它不要求 old/old-accept/final 已通过。不得直接改 generation，不得先启动旧 generation 的原 Worker。

旧样本被阻断时，保留其库、密钥、工作清单及失败报告，维持原 API/Worker/Redis 停止且 PostgreSQL 在线，直接执行 `return-original`；不要执行 old-accept、取消旧 Task、删除状态或使用 final 的成功替代旧样本结果。

驱动不重启原控制面。`return-original` 期间原 Redis 端口也须保持关闭。root 核对 `originalNeedsReconcile=false` 与正式解锁审计后，先启动原 Redis 并等待健康，再启动原 API/Worker：

```sh
docker compose --env-file .env -f compose.dev.yaml start redis
docker inspect --format '{{.State.Health.Status}}' ozz-dev-redis-1
```

确认健康状态为 `healthy` 后再启动原 API/Worker；如果仍为 `starting`，稍后重新查询，不能提前启动。当前 Compose 2.30 的 `start` 不支持 `--wait`。

```sh
pnpm exec node --env-file=.env tests/probes/local-runtime.mjs start --profile=s6-github
```

随后验证实际产品入口；`originalOfflineFirstObservedAt` 只是驱动首次确认原 PID/端口都已停止的时间，不替代 root 记录的真实停机命令起止时间。

## 控制面全停时的连续性取证

可执行入口为 `tests/probes/g-mvp-continuity-local-lab.mjs`，远程只读助手为 `tests/probes/support/g-mvp-continuity-k3s.py`。它只写独立的本地证据目录，不调用恢复命令、产品 API 或服务/VM 启停命令。本次 `all-off` 与 `restarted` 两组真实结果均已通过，详见上方实测表和[结果中的 continuity](g-mvp-recovery-local-results.json)。以下保留重现步骤。

在 `capture-final` 成功后、原 API/Worker/Redis 仍在线时，由 root 执行：

```sh
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node tests/probes/g-mvp-continuity-local-lab.mjs baseline --postgresql=a --redis=a
```

成功时基线保存在 `.local/local-lab/g-mvp-recovery-continuity/baseline.json`。它固定 S4 A/B 的两个既有应用；默认选择 S5 的 A PostgreSQL 与 A Redis。每种数据库可在**基线命令**中独立指定 `a`（原样本）或 `b`（S5 已完成恢复的唯一既有样本），例如 `--postgresql=b --redis=b`。不会自动换目标、启动停止的样本或写入 marker；任一目标不就绪、归属不符或内容不匹配均使基线失败，失败报告仍保留。若需要重新采基线，使用新的文件名，如 `--baseline .local/local-lab/g-mvp-recovery-continuity/baseline-02.json`，并在后续 sample 中重复该路径；已有成功基线不会被覆盖。

本地输入来自受保护的 `product-state.json`、`networking-product-state.json`、`networking-lab/state.json`、`storage-product-state.json` 与 `storage-recovery-state.json`（均在 `.local/local-lab/`），以及原 `.env`、现有 `credentials/ssh_config` / `known_hosts` / Lima SSH 私钥。L06 `g-mvp-recovery/state.json` 只用于核对同一 capture-final 和窗口阶段，`.local/s3-runtime.json` 只提供原 PID；不修改这些输入。成功基线绑定配置与 helper 源码的 SHA256，后续变动会被拒绝。

基线成功后按前述顺序停止原 API/Worker，再停止原 Redis；**在原 Redis 停止后、执行 old 前**运行第二条命令：

```sh
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec node tests/probes/g-mvp-continuity-local-lab.mjs sample
```

默认阶段为 `all-off`，要求成功基线不超过 15 分钟、原锁定意图尚未产生。固定采 7 轮，各轮起点至少相隔 5 秒，首末起点跨度至少 30 秒。每轮前后读取原 PID 的运行情况，并对原 API/Worker/Redis 和 old/final 六个隔离端口做无应用数据的 TCP 检查；端口超时或进程检查不明不能算“已停”。全停窗口不匹配时仍保留该轮实际读结果，但整组不能判为通过。

| 观察              | 实际读取与判定                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A/B 应用          | 通过固定 SSH alias 到目标 VM，以原 ingress IP、Host/SNI 请求 HTTP 和 HTTPS。核对两条 Ingress、Service 与就绪 EndpointSlice 指向已固定 Pod；HTTP 为正确 HTTPS 重定向或内容正确的 200，HTTPS 必须为 200。严格校验 CA、hostname 和当前证书有效期；固定本地 CA 摘要，允许叶证书正常轮换。只比较稳定的 `message` 字段摘要与预期 `Ozz S4 A/B`，不要求包含 uptime 的完整 body 相同。 |
| PostgreSQL marker | 在固定 Pod/PVC 中设置 `default_transaction_read_only=on`、3 秒语句与 2 秒锁超时，使用 `psql -X -w` 只执行 `SELECT value FROM public.ozz_s5_probe WHERE id='persistent';`。                                                                                                                                                                                                    |
| Redis marker      | 在固定 Pod/PVC 中执行 `redis-cli --no-auth-warning --raw -h 127.0.0.1 -n 0 GET ozz:s5:persistent`。只做 GET，不重新生成 marker。                                                                                                                                                                                                                                              |

每个目标的读取前后都复核 A/B boot ID、kube-system/node/namespace、controller/Service/Pod/owner、数据 PVC/PV 的 UID 与规格摘要；同时记录 Ready/Running、容器重启数、UTC 起止、实际 HTTP/TLS 状态、body/稳定字段摘要和 marker 匹配结果。数据库认证只在 Pod 内使用既有环境变量；marker 在 VM 内与预期 SHA256 比较，正文、密码、环境值、Kubernetes Secret 和原始错误输出均不进入本地报告。SSH 有严格主机密钥校验和有界超时。

每次调用单独写入 `.local/local-lab/g-mvp-recovery-continuity/<UTC>-<随机标识>/`，目录 0700、文件 0600：`events.jsonl` 逐步骤落盘并同步，`round-01.json` 至 `round-07.json` 保留每轮结果，`report.json` 保存总结果、基线 SHA256 与 `sampleSpanMs`。一项失败不取消其他目标或后续轮次；SSH 超时前已返回的步骤仍保留。人工中断只结束 helper 自己的请求，并保留不完整、未通过的报告。

`return-original` 成功且原运行器仍停止时，可运行 `sample --phase returned`；原 Redis/API/Worker 重启后运行 `sample --phase restarted`。这些复核沿用同一基线、各采 7 轮，并单独标注阶段；不能代替 **任何恢复样本启动之前** 的 all-off 证据。K3s inventory 本身也不能代替实际 HTTP、TLS 或数据库读取。

## 隔离与保留

- 两个新库分别为 `ozz_gmvp_old_<session>`、`ozz_gmvp_final_<session>`；原库、原 `.env`、原主密钥保持保留。只用公开恢复脚本导入，拒绝覆盖非空未知目标。
- old 端口为 53580/53581/53582，final 为 53590/53591/53592；每次只运行一组样本 API/Worker，使用独立 Redis 容器与卷。Redis 容器限制 128 MiB、队列内存 64 MiB，仅使用缓存镜像。
- 停进程前核对唯一环境文件参数、入口、cwd、PID 与启动时间；停止 Redis 前核对 owner/session/sample 标签。中断后的清理使用独立有界等待，仍须验证所有权。
- 恢复准入至少保留 10 GiB 主机磁盘，持续监测 8 GiB 底线。所有数据库、备份、密钥副本、Redis 容器/卷及失败证据保留，不 reset/clean。
- 数据库外的 Builder 身份与备份中的登记必须匹配。本驱动不覆盖“旧备份连整个 Builder 登记也丢失”的恢复；当前产品也没有该类受控登记恢复入口，须保持锁并单独处理。

私有状态、每次运行的不可覆盖证据和报告位于 `.local/local-lab/g-mvp-recovery/`。正式审阅文件、请求意图、restore/unlock 审计、签名清单及 K3s 资源 UID/revision/hash 都保留。K3s 助手只执行 get，不导出 Secret 或环境值；TLS Secret 的独立证书轮换不计作工作负载恢复改动。

若命令响应丢失，驱动按正式 restore 收据、保存的 manifest ID/内容哈希及解锁审计核对后继续；不覆盖已有库或密钥。任何额外差异、输入/代码哈希变化或所有权不明都会停止当前阶段。`status` 只读本地记录，不能代替现场核对。

## 证据边界

产品最小修复由 `recovery:inspect`、`recovery:accept` 和既有 `recovery:unlock` 组成，详见 [控制面恢复手册](../control-plane-recovery.md)。隔离回归位于 `tests/integration/builds-s6.test.ts`；真实 PostgreSQL 与本机 mTLS 签名协议夹具证明持久审计、锁代次绑定、完整分页、旧未知运行默认拒绝及变化后继续保锁，不代表真实 Builder 或 K3s 演练已通过。

原演练的实际停机、分阶段恢复时间、两组应用和数据连续性、旧样本、最终一致样本及原库回归见[恢复结果](g-mvp-recovery-local-results.json)；后续认证与独立元数据计时分别见[HTTPS 结果](g-mvp-recovery-https-results.json)和[计时结果](g-mvp-recovery-timing-results.json)。备份清单的 `createdAt` 是归档生成时间，不能作为 PostgreSQL 导出快照的精确时间。新样本已有恢复点及 RPO 上下界、独立元数据 RTO；精确快照点及含真实远端对账的独立完整 RTO 仍未测，不据此关闭 G-MVP 的全部恢复计时要求。
