# 本地 S5 A→B 恢复探针

`tests/probes/s5-recovery-local-lab.mjs` 是本地验收操作者脚本，使用 [手工数据恢复工具](manual-data-recovery.md)。它通过真实 API/Worker 创建新的 B 目标，分别执行 PostgreSQL、Redis、普通文件备份恢复，再检查正式工作负载中的标记。它不提供产品备份调度能力。

执行前必须完成主探针的三个 `write:*` 和 `stop-resume:*` 阶段，并协调文件源的停止/维护窗口。脚本从 `.local/local-lab/storage-product-state.json` 固定源 Service/Volume，从该文件的 B project/environment 固定目标范围；A/B Cluster 来自已登记的 `product-state.json`。它不会创建其他项目、改写父状态或接入消费者。

```sh
pnpm exec node tests/probes/s5-recovery-local-lab.mjs --help
pnpm exec node --env-file=.env tests/probes/s5-recovery-local-lab.mjs run
```

项目 Node 必须是 `24.22.1`。`APP_ORIGIN` 来自本次项目配置。API 固定为本地 `http://127.0.0.1:3000`。脚本从现有受保护文件读取管理员密码和 A/B kubeconfig，不输出密码、会话或 Secret 内容，也不调用 ambient `kubectl`、修改全局配置或加载镜像。

源数据采用主探针的 `runId`：

| 数据       | 固定检查                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| PostgreSQL | `public.ozz_s5_probe`，`id='persistent'` 的 `value` 等于源 `runId`；CLI 另外比较选定表全部行及结构/约束摘要 |
| Redis      | DB 0 的字符串键 `ozz:s5:persistent` 等于源 `runId`；CLI 检查 RDB 导入和正式 AOF 状态                        |
| 普通文件   | `/data/ozz-s5-marker` 的 SHA256 等于源 `runId` 摘要，正式应用 `127.0.0.1:8080/` HTTP 响应也必须匹配         |

PostgreSQL/Redis 源保持在线。文件源通过产品停止、进入 backup 维护，然后运行备份 CLI；只有 Mac 副本验证通过才显式退出原维护并恢复源。所有步骤保持原发布快照和源 PVC 身份。

每份备份完成后才创建对应的 B Service/Volume。目标先正常发布，让 PVC 绑定且数据库完成空库初始化，再停止、进入 restore 维护、运行导入 CLI。导入只生成 `restore-prepared.json`，仍是不完整结果；脚本随后显式退出该维护并恢复同一发布快照，运行正式验证 CLI，再核对业务标记。成功恢复和原备份都在**源 Volume** 的人工记录簿追加 `operator_reported` 记录。

Mac 副本放在本次私有运行目录，标签固定为 `local-mac-outside-source-vm`。它位于源 VM 外，但 A/B 和副本仍共享同一物理 Mac，不能作为物理异机灾备、云存储或未辅助拉取镜像的证明。

状态与回执位于：

- `.local/local-lab/storage-recovery-state.json`：可恢复的 API/CLI 意图、身份和阶段状态，0600。
- `.local/local-lab/s5-recovery/<runId>/contexts/<invocationId>/`：本次会话、kubeconfig 私有副本和上下文，目录 0700、文件 0600。
- `.local/local-lab/s5-recovery/<runId>/cli/<intentId>/`：每个 CLI 的独立输出父目录；原产物、失败目录和回执均保留。
- `docs/acceptance/s5-recovery-local-results-<invocationId>.json`：每次运行不可覆盖的脱敏报告；`s5-recovery-local-results.json` 是最新报告副本。

中断后可使用同一命令或只选择某个引擎：

```sh
pnpm exec node --env-file=.env tests/probes/s5-recovery-local-lab.mjs run --engine=postgresql
```

API 操作使用已持久化的幂等键。CLI 只会启动从未开始的意图；已经启动的命令必须找到并重新校验完成清单/回执，才能继续。缺失回执、失败导入、损坏产物不会授权再次导入。人工记录 POST 丢失响应时读取源记录簿对账，不自动重发。未完成的备份、副本和无回执记录需要操作者先核查原目录与远端状态。

如果导入或正式验证失败，目标和全部证据保留。正式验证阶段已经退出维护时，脚本尝试通过产品停止目标并重新进入 restore 维护；报告的 `failureHold` 明确记录是否确认成功。信号中断或 API 故障可能阻止这个收敛步骤，此时不要接入消费者，按手工 runbook 核对维护和原 helper。

需要另一个新目标时，显式指定状态/报告中的旧 `attemptId`，同时选定引擎：

```sh
pnpm exec node --env-file=.env tests/probes/s5-recovery-local-lab.mjs run \
  --engine=postgresql --new-target-for='<失败目标的 attemptId>'
```

参数必须是失败目标尝试的 ID，不是 Service、PVC 或 CLI restore ID。新目标继续使用原来已验证的备份；旧目标、旧 helper 和原文件均不清理。普通重入不创建替代目标，也不把旧卷当新空卷。原 helper 如需正常停止/删除，使用手工 runbook 的 `manual-data-helper.mjs` 和其原上下文、原运行目录。

脚本用自己的 lock 文件防止并行运行。如果进程异常退出留下锁，先核对其 PID/nonce、子进程和远端操作状态；不要盲目删除锁后重跑导入。

本地回归只验证 CLI 意图恢复规则，不执行 A/B 操作：

```sh
pnpm exec node --test tests/manual-data/recovery-probe.test.mjs
pnpm exec node --check tests/probes/s5-recovery-local-lab.mjs
```

## 已完成的受控验收

2026-10-26（Asia/Shanghai）三类首次真实执行全部通过，累计 9/9 项检查、18 个有持久化意图的 CLI 步骤，无失败目标或重试。每份 Mac 副本还单独运行了完整性校验。6 条备份/恢复记录均满足 `result: "passed"`、`integrity: "passed"` 和 `verificationSource: "operator_reported"`。原始源卷及业务标记均再次核对；文件源已退出维护恢复运行。

| 数据             | 产物大小 | 恢复 CLI 开始至正式验证结束 |
| ---------------- | -------- | --------------------------- |
| PostgreSQL 17.11 | 1721 B   | 16.305 秒                   |
| Redis 7.4.11     | 233 B    | 17.585 秒                   |
| 普通文件 USTAR   | 10240 B  | 15.811 秒                   |

这些时间对应小型验收标记数据，包含导入后的退出维护、正式启动和验证等待，不包含此前备份与新目标创建。文件正式实例额外通过了实际文件读取及 HTTP 响应摘要比较。Redis 此次选择永久字符串标记，实际过期行为仍由协议回归覆盖。

最终 [真实恢复报告](acceptance/s5-recovery-local-results-b247d3cb-7a88-40d5-bb85-6fa96e8168d7.json) 包含源/目标映射、备份与清单 SHA256、恢复耗时、人工记录 ID 和证据引用。其 SHA256 为 `fe6c1932ef43ddc496facb318f6504208503a3514057f513709ddbb8728324c6`。三份执行报告和所有原产物均保留；源、目标和副本共享同一物理 Mac 的范围声明不变。

最终本地 manual suite 为 **60/60 通过、0 跳过**，其中恢复意图与记录对账回归 9 项；手工记录 HTTP/真实隔离 PostgreSQL 聚焦集成为 **6/6 通过**（该聚焦命令未执行另外 27 项，全量结果以工程验收报告为准）。本目录文档与协议/真实执行证据的文件哈希一起收录在验收目录内的带时间戳 `s5-manual-data-final-*.json` 报告。
