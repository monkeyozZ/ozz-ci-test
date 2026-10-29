# G-MVP 本地运行故障增量

状态：L05 的真实 Pod OOM、历史诊断与部分应用恢复链均已通过，证据来自两个独立样本。5 个样本中保留 4 次失败运行，只有最后一次 partial-only 运行完整通过；没有把不同样本合并成一次 full 运行成功。机器可读结果见 [验收汇总](g-mvp-workload-fault-local-results.json)。整台节点停止/恢复和 PVC 持久性由 C 专用探针另验。

入口为 `tests/probes/g-mvp-workload-fault-local-lab.mjs`。先完成 S6 Builder 故障矩阵并释放其运行窗口，复用其中已经成功发布的不可变 Go 镜像。它在新项目、默认环境和一个专用镜像服务中运行，不创建新构建或改动原 Git 服务。

```sh
pnpm exec node tests/probes/g-mvp-workload-fault-local-lab.mjs prepare \
  --artifact-deployment=<S6故障矩阵中成功的原产物重试Deployment>
pnpm exec node tests/probes/g-mvp-workload-fault-local-lab.mjs run
pnpm exec node tests/probes/g-mvp-workload-fault-local-lab.mjs status
```

若一次运行已经清理并恢复 ACL，不直接重放旧 state。保留该目录和所有报告，使用新的 `--attempt=<UUID>` 显式创建独立样本；prepare/run/status/cleanup 都传同一 attempt。已通过 OOM 而只需复测 partial 时，在新 prepare 上传 `--scenario=partial`，该样本的报告会明确只覆盖部分应用，不重复 OOM 检查。

流程先发布健康版本，再以 128 MiB Pod 上限执行有界内存样本。只有目标 rollout 的实际容器状态及产品保留的失败观察均出现 OOMKilled 才算通过，旧健康 Pod 不能证明新版本成功。

随后恢复健康版本，为该服务创建临时 ValidatingAdmissionPolicy。规则仅匹配 B 集群中这一个 namespace、Deployment 名和 UPDATE 操作；先用 server dry-run 确认规则生效，再从产品发起带新变量的发布。通过条件是实际 Secret/Service 已应用到新版本，而 controller 仍是旧版本，产品显示 partial 并拒绝重启。删除临时规则后，使用同一 controller 和当前 replicas 的 server dry-run 等待准入拒绝实际解除，再执行停止。停止必须可用，恢复仍须被完整配置门禁拒绝；最后显式修复发布成功并停止专用服务。停止验收同时要求操作成功、controller replicas 为 0、样本 Pod 清空，不能只依据入队时写入的 desiredState。

探针只为精确测试仓库临时增加 pull 权限，结束后按原始字节与 SHA256 恢复 ACL。它通过 UID 前置条件删除自己创建的两个 admission 资源，保留项目、服务、任务、镜像与全部失败记录。原 Git 服务的 revision、发布身份与期望状态前后核对。

同一探针的 prepare/run/cleanup 复用 0600 私有会话缓存，并先通过 `/api/auth/me` 核对身份，避免反复登录触发现有限流。收到退出信号后，清理等待使用独立有界 signal，仍会尝试停止自己的样本。

私有状态、ACL 备份、请求意图、Kubernetes 元数据和产品结果保存在 `.local/local-lab/g-mvp-workload-faults/`。凭证、Cookie、CSRF 和原始 Secret 数据不进入证据。退出时会尝试清除规则、取消并停止自己的任务/服务、恢复 ACL；任何未恢复项都会使结果失败。需要单独恢复时使用 `cleanup`，不能删除 state 或覆盖原备份以跳过检查。

这项检查不重启 A/B、K3s、Pebble 或 Builder，不操作原有数据卷。执行前后检查本机 8 GiB 磁盘保留线；所有结果按实际收据填写，准备好的脚本不计作通过。

## 当前保留结果

- 首轮 Deployment `75271808-e382-40b8-af7a-063bc9550136`：健康等待失败，但历史快照未保存容器诊断；原报告和已停止的样本保留。修复新增每个 Pod 最多 16 条白名单容器诊断，旧历史字段仍可缺省，未改写旧记录。
- 第二轮 `a988bc74-9664-49b4-b010-473505925925`：Deployment `81c34c92-48dd-4053-9716-0bcf9dc75a21` 的 Kubernetes OOM 与产品历史 OOM 均通过；partial 发布 `d0345c17-abac-4523-b272-2c8ba667863d` 暴露“已确认 partial 被后续 beforeWrite 改成 unknown”的状态问题。停止/恢复门禁未被绕过；样本已停止，临时 policy 与 ACL 已恢复。
- 状态修复保留已确认的 partial/drifted，完整应用后才进入 consistent；真实 PostgreSQL 回归先复现 unknown→预期 partial 不符，修复后通过。第一次窄测试遗漏具名端口导致没有 Service 资源，其失败报告也保留，不能冒充产品缺陷复现。
- 第三轮 `c7c16ca6-2452-42d5-93a7-f53aa79875b5` 为 partial-only，在安装故障规则期间请求超时，尚未执行 partial 发布；样本与规则已清理，ACL 原字节恢复。本机当时内存压力较高，已停止空闲 Builder VM，后续独立窗口继续验证。
- 第四轮 `ed3a4a63-a7a4-4df3-a206-6a7fc8aa8cfd` 为 partial-only：发布 `17fe12ba-968d-4f8c-b004-e0871d071c92` 的实际资源分裂、partial 状态与 restart 拒绝通过，但 stop `a6286d88-bff2-46db-86a0-972ff9f876c8` 返回 `KUBERNETES_FORBIDDEN`。删除规则后立即 stop 与准入缓存尚未传播的情况一致，但通用错误码不能单独证明具体拒绝来源。旧 cleanup 仅检查 desiredState，曾留下 replicas=1 的样本并误报 cleanupIssues 为空；该失败报告保持原样。更新后的独立 cleanup 于 `2026-10-26T07:20:19.417Z` 通过，实际 replicas=0、Pods=0，不将清理成功改写为原运行通过。
- 第五轮 `1fe6b29d-6ee1-4b4c-9c7e-9ee83c547210` 为新的 partial-only 样本，在 `2026-10-26T07:22:11.422Z` 完整通过。健康基线 `53716d54-744a-44b8-97cf-e29cbcadc6b4` 保留在 controller；被拒绝的发布 `d87c5632-6e03-4ca1-97c2-0d6562051bc7` 已写入 Secret/Service，产品保留 partial 并拒绝 restart。停止 `8886e88a-7080-48df-8c9e-3ab4c8012f59` 成功且 replicas=0、Pods=0；resume 被拒绝；显式修复 `49f1dc4e-1552-4e66-ad09-c6c82d5d84e6` 成功；最终停止 `7c1bdce9-3e08-48a7-b0a0-9a0014968fbf` 同样有实际停止证据。原 Git 服务 revision、发布身份和期望状态与该样本基线相同。这次运行未重复 OOM。

OOM 的通过证据是第二轮 `a988` 的同一失败 rollout：真实 Kubernetes Pod 和产品保留的 failureObservation 均记录 Pod UID `36c431ab-0254-47fa-a4cd-d7d9e88479bd`、`OOMKilled`、退出码 137，工作负载内存上限为 128 MiB。旧健康 Pod 的 Ready 状态未被当作新版本成功。该轮后续 partial 失败，因此原 full 运行仍为 failed。

最终使用既有 B kubeconfig 和严格 TLS 执行独立只读核对，5 个样本均为 replicas=0、current/ready replicas=0、Pods=0，controller 已观察到当前 generation；已安装的 4 组 policy/binding 均返回 404，各次 ACL 原始字节 SHA256 与当前文件一致。未追加清理操作，也未请求修改产品、数据库或原 Git 服务。收据为 `.local/local-lab/g-mvp-workload-faults/all-fixtures-stop-readback-1792999659404-cfd1586a.json`；汇总包含该收据、各次原始报告及通过证据的相对路径与 SHA256。

| 独立样本        | 范围         | 原运行结果                               | 接受的故障项                          | 最终实际副本 / Pod |
| --------------- | ------------ | ---------------------------------------- | ------------------------------------- | ------------------ |
| 默认 `f0cd0dfb` | full         | failed，历史容器诊断缺失                 | 无                                    | 0 / 0              |
| `a988bc74`      | full         | failed，partial 被覆盖为 unknown         | OOM                                   | 0 / 0              |
| `c7c16ca6`      | partial-only | failed，规则安装期间超时                 | 无                                    | 0 / 0              |
| `ed3a4a63`      | partial-only | failed，stop 被拒绝；后续 cleanup passed | partial 状态与 restart 门禁的中间证据 | 0 / 0              |
| `1fe6b29d`      | partial-only | passed                                   | partial 完整恢复链                    | 0 / 0              |
