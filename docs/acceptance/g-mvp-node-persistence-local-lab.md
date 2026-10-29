# G-MVP C 节点与 PVC 持久性验收

状态：真实节点停启通过，11 项检查全部通过。C 确认停止后保持了 **31.263 秒**才发起启动，停机期间 9 次独立 B 观察均为 Ready，身份与 boot ID 不变。原 PVC/PV、65 字节标记及其 inode/mtime 保留，恢复后的应用通过 HTTP 返回原标记。

本次是样本 `07e98df5-99cc-4a60-9a04-def03a21196d` 的第一次实际节点故障运行。准备阶段的两次发布失败完整保留；通过依赖一次明确批准的镜像缓存辅助和一次探针健康检查修正，不能描述为首次准备即成功。机器可读结果、证据相对路径及 SHA256 见 [验收汇总](g-mvp-node-persistence-local-results.json)。

## 保留的准备过程

| 产品发布                               | 类型                   | 原始结果                           | 原因或接续                                                                     |
| -------------------------------------- | ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `4ba2870a-3a86-450c-92a3-72f477812f2a` | 首次发布               | failed，`WORKLOAD_ROLLOUT_TIMEOUT` | C 访问 Docker Hub 超时，Pod 为 ImagePullBackOff，应用尚未启动                  |
| `053a6709-eaf2-4404-8b16-c0fcac18ed12` | 原发布的正式产品 retry | failed，`WORKLOAD_ROLLOUT_TIMEOUT` | 镜像已可用；探针继承了 startup `/`，标记尚不存在时该路径返回 404               |
| `b0b74490-f358-4870-9941-d3bee6baea79` | 显式修改配置后的新发布 | succeeded                          | 仅将专用服务的 startup 路径改为 `/healthz`，新发布成功后才首次写标记并建立基线 |

第二次失败属于探针配置遗漏：readiness 已使用 `/healthz`，startup 仍沿用 Docker 模板的 `/`。实际 controller 没有 liveness probe，产品也不生成该探针。现在初始探针配置同时指定 startup/readiness `/healthz`；标记内容校验使用 `/`，健康检查不依赖标记存在。产品 retry 固定原快照，因此配置修正使用新的正式发布，没有改写旧 retry 的快照或结果。

镜像始终是 `docker.io/library/node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53`。从 B 已有的 containerd 缓存只读导出 ARM64 内容，生成独立 0600 OCI 归档，再导入 C 的 `k8s.io` 缓存。62,288,384 字节归档的 SHA256 为 `635c05daf2e05856622f616248d98cc1d1d9d0083cceec22fa364f9151a09402`；7 个 blob 的摘要、大小及层展开后的 diff ID 均已验证，导入后在 C 重算所有 blob 摘要并确认 CRI 可见原引用。未修改 DNS、代理、镜像引用或 PVC。C 的原始公网拉取路径仍不计作通过。

## 实际节点窗口

| 事件                   | UTC 时间                   |
| ---------------------- | -------------------------- |
| 修正发布后的基线完成   | `2026-10-26T08:01:15.679Z` |
| 保存单次 stop intent   | `2026-10-26T08:01:57.318Z` |
| Lima 确认 C 为 Stopped | `2026-10-26T08:02:28.006Z` |
| 发起 C start           | `2026-10-26T08:02:59.269Z` |
| Lima 确认 C 为 Running | `2026-10-26T08:03:17.617Z` |
| 11 项恢复检查全部通过  | `2026-10-26T08:03:30.699Z` |

31.263 秒按“确认 Stopped”到“发起 start”计算，不把启动耗时算作保证的停机保持时间。节点停止前保存的单次 stop intent 阻止重放 `run`。此次没有第二次节点故障运行，也没有恢复阶段标记写入。

原 C kube-system UID 和 Node UID 保持不变，boot ID 从 `31f981bb-cbd9-4e83-b31a-e127a4602935` 变为 `d1c73ebb-2ef1-4524-8716-10f5efd4bca0`。原 PVC UID 为 `7d01de4d-ff4e-44f1-8494-b567f14cf897`，PV UID 为 `73b1d6ef-5959-4531-bc70-d9996a6e9232`。标记只进行过一次带 `O_EXCL | O_NOFOLLOW` 的明确写入，并 fsync 文件与目录；恢复只读。前后标记 SHA256 均为 `b631f20241d383dd51583dcf25755669c403513f34c77bfca677f0866f209e2b`，inode `2379978` 和 mtime 均未变化，HTTP 读取也得到相同摘要。

独立 B 的 9 个停机期间样本及恢复后样本均保持原 kube-system UID、Node UID、boot ID 和 Ready 状态。C 恢复后仍运行原基线发布 `b0b74490-f358-4870-9941-d3bee6baea79`，没有活动产品任务，原卷未销毁。A/B、Builder、Pebble、平台 API/Worker/数据库均未由本探针停启。

## 收尾与证据

专用服务 `f7506102-4e67-4eb2-8036-32b0f8f47237` 的停止操作 `7cccf414-6e8e-46b7-b6f4-11236cbed962` 成功。随后于 `2026-10-26T08:07:31Z` 独立读取 C 的 Kubernetes 对象，确认 controller desired/current/ready replicas 均为 0、Pod 数为 0、generation 已观察到，原 PVC/PV 仍在。startup/readiness 均为 `/healthz`，liveness 为空。该读回没有执行任何标记操作或写请求。

C 窗口交回 root 时 VM 为 Running、Node Ready。窗口交回后的 C/Builder 调度由 root 接续；此验收代理此后仅离线整理文档。项目、服务、卷、缓存归档及全部失败与成功记录均保留。

主要证据位于 `.local/local-lab/g-mvp-node-persistence/`：

- `verified-1793001810698-45e258d1.json`：11 项恢复检查及前后 C/B 观察。
- `service-stop-readback-20261026T080731Z-a39839fe.json`：实际副本与 Pod 为 0，原 PVC/PV 保留。
- `final-1793002051441-1592b851.json`：停止后的产品服务、卷和 VM 状态。
- `outer-invocations/`：6 次调用独立保存 0600 stdout、stderr、意图及退出收据；prepare/retry-prepare 退出 1，repair-prepare/run/stop-service/report 退出 0。
- `cache-assist/`：只读导出归档、摘要核验、C 导入和目标重算证据。

探针语法与 ESLint 检查通过；原 [准备时静态收据](g-mvp-node-persistence-prepared.json) 保持原样，不能代替这次实际运行结果。[执行规程](../../tests/probes/g-mvp-node-persistence-matrix.md) 说明显式 retry/配置修正及中断恢复入口。1 GiB 的 local-path PVC 请求不代表硬配额；此结果证明一次受控 C 重启中的数据保留，不声称跨节点故障转移或数据库备份恢复。
