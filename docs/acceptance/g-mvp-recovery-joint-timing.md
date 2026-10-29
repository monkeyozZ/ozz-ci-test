# G-MVP 当前快照联合恢复计时

一次当前空闲快照的本地同进程联合恢复样本通过。
这是独立的局部证据。S6/G-MVP 继续 `in-progress`，S7 入口仍为未满足。

生成时间：2026-10-29T04:36:42.920887+00:00。状态：`passed`。

完整目标恢复时间定义为 incident 至 recovered；原环境返还单列。精确物理快照时刻未知，报告只给出父进程可证明的时间上下界。

| 计时范围 | 毫秒 |
| --- | ---: |
| 完整目标恢复 RTO | 21559.829042 |
| 累计至只读验证 | 10018.448417 |
| 累计至可写就绪 | 16925.884500 |
| 恢复导入段 | 3369.924625 |
| 正式解锁与对账段 | 1362.965000 |
| 原环境返还段 | 13992.611750 |
| incident 至原环境就绪的总窗口 | 35584.209583 |

累计里程碑不可相加；失败尝试中可计算的区间也不计为成功 RTO。

| 独立分段 | 毫秒 | 计入完整目标 RTO |
| --- | ---: | --- |
| 停止原 API / Worker / Redis | 991.052292 | 是 |
| 原控制面离线期间的应用观测 | 2294.594916 | 是 |
| 原库封锁与目标库创建 | 798.829584 | 是 |
| 本地备份复制与取回 | 15.731333 | 是 |
| 导入前准备 | 22.411625 | 是 |
| 正式恢复导入 | 3369.924625 | 是 |
| 只读启动、旧会话撤销与检查点验证 | 2525.904042 | 是 |
| 停只读节点并核对 Builder / K3s | 3296.985166 | 是 |
| 真实远端对账与正式解锁 | 1362.965000 | 是 |
| 读写节点启动与就绪 | 2247.485917 | 是 |
| 新 generation 的实际诊断 | 332.510292 | 是 |
| 最终元数据、Builder、K3s 与应用验证 | 4301.434250 | 是 |
| 目标恢复完成后至原环境返还开始 | 31.768791 | 否 |
| 原环境正式对账、启动与验证 | 13992.611750 | 否 |

incident 时快照年龄的父调用界限：2674.592458–5409.750375 ms。
incident 时已保存检查点提交年龄界限：5512.487375–5549.827458 ms。

被备份排除版本的成功确认至 incident：2584.869208 ms。

备份 `joint-bcdce642-7cc4-4598-ab67-6b2e051259d2` 的规范快照摘要已独立重算；数据库归档摘要为 `08d6e499324ced9c9ce5f4d3fca73c111e603970b16d97d1d309307087ebd8fd`。
导出 MVCC 边界 `1995624:1995624:`；saved 可见：`True`，omitted 被排除：`True`。
生成器没有读取数据库归档、密钥或私有签名清单；配对和 Builder 验签依赖通过且绑定源码的驱动。

| 应用观测窗口 | A 镜像 | B Git | 文件 |
| --- | --- | --- | --- |
| prepared-applications | passed | passed | [JSON](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/7f710fc3-2f7c-43ed-83df-b48accc57200/prepared-applications-56368fb6-b1b1-4e48-8fb7-8f4d7c6585f0.json) |
| source-current-applications | passed | passed | [JSON](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/ce0c0b90-045e-4733-92ca-139470fe051a/source-current-applications-22dca5a3-671f-4e84-b2c3-1184f8b50a8f.json) |
| original-offline-applications | passed | passed | [JSON](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/ce0c0b90-045e-4733-92ca-139470fe051a/original-offline-applications-0909af27-ad90-421d-a6f7-1a2896f79946.json) |
| target-final-applications | passed | passed | [JSON](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/ce0c0b90-045e-4733-92ca-139470fe051a/target-final-applications-5ad3e125-7c0f-4a18-8944-cf96e98db3c9.json) |
| original-ready-applications | passed | passed | [JSON](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/ce0c0b90-045e-4733-92ca-139470fe051a/original-ready-applications-999e1c5b-c8bc-4f4a-82c3-696e54ec9c63.json) |

四个 run 窗口的稳定身份一致：`True`。prepare 与新 run 基线一致：`True`。
应用停机观测发生在原 API/Worker/Redis 确认停止之后、目标创建之前，其耗时已纳入完整 RTO。观测没有覆盖窗口之间的每一瞬间。

prepare 加四个 run 窗口共 10 次 A/B 观测。JSON 保留各窗实际叶证书摘要；稳定身份比较排除可轮换叶证书、动态 A 响应字节、时间和重启计数。

B Git 应用在 `target-final-applications` 观测中首次记录到不同叶证书摘要；各窗严格 TLS 与内容验证均通过，轮换不改变上述稳定资源身份结论。

| 保留的失败尝试 | 阶段 / 原错误码 | 处理 |
| --- | --- | --- |
| [joint-20261029-01](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-01/8528f155-a35e-4149-809c-652a1520ad9e/report.json) | `initialize` / `GMVP_JOINT_UNEXPECTED_FAILURE` | preflight failed；无 incident，不计 RTO 或成功样本 |
| [joint-20261029-02](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-02/c8515367-7dc6-446a-b9e1-72c8e3bc094d/report.json) | `prepare-read-only-preflight` / `GMVP_JOINT_APPLICATION_OBSERVATION_FAILED` | preflight failed；无 incident，不计 RTO 或成功样本 |

joint-01 终态仅记录初始化通用失败；joint-02 的应用文件保留 A/B HTTP 跳转成功与 TLS verifyCode 20。入口缺失、旧证书过期和 Pebble 账户缓存问题的进一步归因以独立诊断为准，不能由这两份预检终态推算恢复时间。

本地 Pebble 前提修复已有[实际安全摘要](../../.local/local-lab/pebble-account-recovery/pebble-20261029-01/75d6d577-0354-4da6-a85c-bb379fc2e365/summary.json)：原账户密钥及 Issuer / Certificate / Secret UID 保留，账户重新登记后由 cert-manager 真实签发，A/B 严格 HTTPS 均为 200。
A 证书 revision 1164→1165，B 1003→1004。此修复发生在联合测试之前，不纳入 RTO，也不增加产品验收通过项；旧失败签发子对象的控制器回收与预先归档分别说明。

保留的 [joint-20261029-03 失败 run](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-03/6bbf3b42-fdf9-4245-984e-38c1e5927d12/report.json) 已完成全停后的 A/B 应用抽检和正式 dump/restore；导入段为 3954.787917 ms。只读启动未完成，原回执保持 `failed`，完整 RTO 为 `null`。
root 定位到探针将不存在 Docker 对象的换行输出误判为未知错误。这个失败没有被后来的工具修正或成功返还改写。
后续[独立返还](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-03/7febeb30-8e05-4b4e-87c5-eaa003ff180f/report.json) 用自己的父时钟测得 16.198130042 秒，并在原 generation 7 完成真实对账与就绪；`resumedAcrossProcesses=true`。两个进程的时间不相加，不生成跨进程 RTO。
[原源码快照](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-03/original-source-before-fix-ca6dfc81-3998-49d7-9be1-59184e3de361/manifest.json)保留失败版本；返还的两个新副本以[最终静态/分类回归记录](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-03/return-amendment-71dd5de4-5da4-4ca4-b302-558be624f483/final-validation.json)和实际返还回执共同绑定。早期 source-map 继续保留，不用作最终执行版本。

| 本次回执 | 状态 | SHA256 |
| --- | --- | --- |
| [prepare](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/7f710fc3-2f7c-43ed-83df-b48accc57200/report.json) | passed | `2bba7cc1d87d9ba944642cde002e2d81fa5a8ab6a2f5df86666a6a4adfb4fa66` |
| [run](../../.local/local-lab/g-mvp-recovery-joint-timing/joint-20261029-04/ce0c0b90-045e-4733-92ca-139470fe051a/report.json) | passed | `11bcf20a28deaf893a56d577193a17346bcf5342f785be0cf05b1321650071ed` |

允许绑定的代码/公开输入共 23 个；本次已绑定 23 个。完整字段、纳秒值与哈希见配套 JSON。

范围限制：

- 本次只覆盖一个当前空闲快照；不重跑或增加旧备份、旧任务、故障与发布矩阵的通过次数。
- 导出 MVCC 边界可核验事务可见性；PostgreSQL 物理快照取得的精确时刻未知。父进程 backupStarted→backupCompleted 仅给出调用界限。
- 父进程单调时间、备份子进程单调时间、数据库墙钟标签分别保留，不跨进程相减；数据库墙钟可能倒退。
- 镜像/制品缓存、凭据、TLS 配置和虚拟机容量在 incident 前已准备。计时包括停止原运行时、停机应用观测、新建目标库、本地备份复制、导入、Redis/API/Worker 启动、真实 Builder/K3s 对账及最终验证。
- 原库与目标库在同一台本地 PostgreSQL 服务；不覆盖数据库物理主机丢失、远程下载、DNS 切换、人工响应、物理资源创建或生产端到端 RTO。
- A/B 属于同一物理 Mac 上的 ARM64/Lima 环境。严格 TLS 使用显式本地 CA，不证明公开根信任、公共 DNS、外部故障域或 X01–X05。
- 四个应用观测窗口只证明各自有界观测的就绪、身份、HTTP 跳转与严格 HTTPS 内容，不声称每一瞬间持续可用。
- 真实 Builder 签名清单由绑定源码的驱动验证；报告生成器不读取私有清单，也不独立重验签名。
- 原环境返还单列，不能计入已定义的目标恢复 RTO。独立 return-original 进程的时间不能补成一次成功的同进程 RTO。
- 预检失败保留为历史失败；本地测试签发器重启后的账户/叶证书修复属于环境准备，不增加产品验收通过项。
- 总体 S6/G-MVP 继续 in-progress，S7 入口未满足；本报告不自动提升其他需求或外部门禁。

公开文件使用允许字段投影；不包含凭据、环境/配置内容、原始响应正文或私日志。新字节的实际秘密扫描由独立回执记录，本生成器未执行扫描。
