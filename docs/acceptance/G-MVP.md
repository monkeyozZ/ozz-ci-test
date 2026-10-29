# G-MVP 本地联合验收

日期：2026-10-29T06:05:17.662962+00:00。状态：**in-progress**。L01/L06 的一次当前空闲快照联合样本、L07 本地 Linux 交付及选定运行组件资源观察已通过各自范围；L08 的 reader-04 因 VoiceOver 自动化传输权限中止，仍未取得有效朗读证据，保持 partial。正式 G-MVP 尚未通过，S7 入口为 false。

[71 项机器索引](g-mvp-local-results.json)保留全部唯一需求 ID 和原有 83 条证据记录，其中最初 47 份证据哈希不变。本版共 103 条证据引用、97 个唯一文件。证据条数不是通过测试总数；不同版本、进程、窗口和重叠检查不相加。所有 formalStatus 保留原基线，只按新增已发布范围更新具名 localStatus。

| 关口 | 本地 / 正式状态 | 已验证本地范围 | 剩余 |
| --- | --- | --- | --- |
| GM.01 | passed / partial | L07固定ARM64四镜像与Builder包完成空库Compose、9迁移、管理员与A/B两真实集群导入、OCI/Registry/实际Docker pull互操作和窗口关闭。 | 具名本地范围已覆盖；外部门禁与范围限制仍保留。 |
| GM.02 | passed / partial | 镜像与Git到应用HTTPS各自已实测，恢复控制面HTTPS与最新Git元数据已公开。 joint-04 prepare加四个run窗共10次A镜像/B最新Git严格HTTPS/内容观测通过，四run稳定身份一致；B实际叶轮换单列。 | 具名本地范围已覆盖；外部门禁与范围限制仍保留。 |
| GM.03 | passed / partial | 同环境数据库、Pod 数据、服务操作、stopped Git、取消/重试和删除留卷。 | 具名本地范围已覆盖；外部门禁与范围限制仍保留。 |
| GM.04 | passed / partial | 旧/最终备份和原库对账、控制面HTTPS、隔离元数据计时及L07七阶段升级/备份回退均已公开。 新宿主机工具已公开验证导出MVCC边界与恢复前绑定，6项单测/11项PG及独立补充包各自留证。 joint-04当前空闲快照的同父进程联合恢复通过；完整RTO21.559829042秒，原环境返还13.992611750秒另列。joint-03失败和独立返还均保留。 | 具名本地范围已覆盖；外部门禁与范围限制仍保留。 |
| GM.05 | partial / partial | 故障、分层工程/性能/真实UI、L07交付安全及已公开当前选定运行组件资源均已汇合；恢复工具补充包和新增五文档扫描已绑定。 joint-04应用身份及真实联合恢复计时已发布；失败历史及环境前提修复各自留证。 reader-04一次测试认证已接受；首项检查尝试因VoiceOver自动化传输权限失败中止，0项通过、0份有效朗读、另11项未执行。同次自动恢复完整闭合，不能据此认定产品label失败或读屏通过。 | VoiceOver自动化权限前提仍阻断真实朗读；reader-04首项传输失败不建立产品语义缺陷结论，UX07/L08继续partial。 生成时待核验，最终结果以外置收据为准；不向被扫描JSON回填扫描hash。 X01–X05仍未验。 |

| 本地工作项 | 状态 | 范围或剩余 |
| --- | --- | --- |
| L01 | passed | 按所引原证据范围复用。 |
| L02 | passed | 按所引原证据范围复用。 |
| L03 | passed | 按所引原证据范围复用。 |
| L04 | passed | 按所引原证据范围复用。 |
| L05 | passed | 按所引原证据范围复用。 |
| L06 | passed | 当前快照具名范围完成，物理快照精确时刻与外部范围未扩大。 |
| L07 | passed | 按所引原证据范围复用。 |
| L08 | partial | VoiceOver自动化权限前提仍阻断真实朗读；reader-04首项传输失败不建立产品语义缺陷结论，UX07/L08继续partial。 生成时待核验，最终结果以外置收据为准；不向被扫描JSON回填扫描hash。 |

本次 [联合恢复报告](g-mvp-recovery-joint-timing.md) 的 joint-04 prepare/run 均通过，分别关闭事件并释放七把锁。run 使用单一父时钟 `dc83c333-8a53-4bd2-9b4c-5b13d5028ff1`，从实际 incident 计至目标 recovered；包括停止原运行时、停机时应用观测、新建目标库、本地备份复制、导入、只读校验、真实 Builder/K3s 对账、读写启动及最终应用检查。

| 计时范围 | 秒 |
| --- | ---: |
| 完整目标恢复 RTO：incident→recovered | 21.559829042 |
| 累计至只读验证 | 10.018448417 |
| 累计至可写就绪 | 16.925884500 |
| 恢复导入段 | 3.369924625 |
| 正式解锁与对账段 | 1.362965000 |
| 原环境返还段 | 13.992611750 |
| incident至原环境就绪总窗口 | 35.584209583 |

这些累计里程碑不可相加。停机应用观测 **2.294594916 秒** 已包含在完整目标 RTO 中；恢复完成到返还开始另有 **0.031768791 秒**，因此总窗口为 **35.584209583 秒**。原环境返还 **13.992611750 秒**单列，不改写已定义的目标恢复 RTO。

incident 时快照年龄的父调用界限为 **2.674592458–5.409750375 秒**；已保存检查点提交年龄界限为 **5.512487375–5.549827458 秒**。被排除版本的成功确认至 incident 为 **2.584869208 秒**。导出 MVCC 边界 `1995624:1995624:` 可验证 saved XID `1995610` 可见、omitted XID `1995661` 被排除；规范快照摘要 `c55f3f9c1ec34db457bc25e031229326c9f95818b0b59609bba83fbf954fad11` 已重算。**物理快照取得精确时刻未知，exactPostgresSnapshotRpoMs=null。** 父进程、备份子进程单调时钟与数据库墙钟标签分别保留，不跨时钟相减。

| 应用观测窗口 | A 镜像 / B Git | 机器索引证据 ID |
| --- | --- | --- |
| prepared-applications | passed / passed | GMVP_JOINT_APPS_0 |
| source-current-applications | passed / passed | GMVP_JOINT_APPS_1 |
| original-offline-applications | passed / passed | GMVP_JOINT_APPS_2 |
| target-final-applications | passed / passed | GMVP_JOINT_APPS_3 |
| original-ready-applications | passed / passed | GMVP_JOINT_APPS_4 |

prepare 加四个 run 窗口共 **10 次 A/B 观测**；HTTP 跳转、严格 TLS、主机名和应用内容均通过。四个 run 窗口稳定资源身份一致，prepare 与新 run 基线也匹配。B 叶证书从 source/outage 的 `e191…3bfa` 到 target-final/returned 的 `1cce…75ab` 实际轮换；各窗叶摘要保留，稳定身份比较排除叶轮换、动态 A 响应字节、时间与重启计数。这些读数只证明有界窗口，不声称中间每一瞬间持续可用。

| 保留尝试 | 真实结果与计时处理 |
| --- | --- |
| joint-01 | 初始化预检失败，无 incident，无 RTO，不计成功样本。 |
| joint-02 | 应用预检失败，HTTP 跳转通过但严格 TLS verifyCode 20；无 incident，无 RTO。 |
| joint-03 | 恢复 run 已开始并完成 dump/restore，导入 3.954787917 秒；只读启动失败，完整 RTO 保持 null。 |
| joint-03 独立返还 | 在另一个父时钟上成功返还 16.198130042 秒，resumedAcrossProcesses=true；不能与失败 run 拼接成成功联合 RTO。 |
| joint-04 | 一次同父进程成功样本；旧失败和工具源码快照均保留。 |

joint-03 的工具将不存在 Docker 对象的换行输出误判为错误；原失败源码快照、两个返还副本及其最终分类回归各自绑定，早期 source-map 不作最终执行版本。本次正常 driver 使用修正后 helper，不把修正回填到 joint-03。六项隔离分类检查属于工具验证，不增加产品验收次数。

在 joint-04 之前，本地 Pebble 账户缓存前提修复已由安全摘要留证：原账户 key 与 Issuer/Certificate/Secret UID 保留，重新登记后由 cert-manager 实际签发，A revision 1164→1165、B 1003→1004，严格 HTTPS 200。该修复不计 RTO 或产品验收通过项；生成器未读取私有归档或秘密库存。

当前资源见 [已发布资源报告](g-mvp-runtime-resources.md)：5 次样本实际首尾间隔 **19.985439292 秒**，原 API/Worker、PG/Redis 和 Builder 身份及具名就绪观察均通过。API/Worker 最大 RSS 分别为 49,872,896 / 213,336,064 bytes；PostgreSQL/Redis 近似 working set 为 233,832,448 / 17,186,161 bytes；Builder Node RSS 为 66,015,232 bytes。flock MainPID、Node、服务 cgroup 和 guest 可用内存分别记录，不相加。首轮 manager RSS 实际读到 flock 的原结果保留；该短窗口不证明完整容量或长期负载。

固定 L07 候选仍为 `s6-20261028T173714Z-f8b90388`，四镜像、Builder 包和源码归档的原版本、安装/鉴权、互操作、升级回退及关闭记录见 [最终交付报告](S6-deployment.md)。[快照观察工具增量](g-mvp-snapshot-observation.md)在冻结之后单独交付：6 项单测、11 项真实 PostgreSQL 检查和 22,420 字节补充包各有范围；不改称旧镜像内容，不与历史全套计数相加。索引生成未重新运行归档装配器或读取/哈希大型归档。

安全证据保留实际 API/DB/日志断言、L07 生产 Cookie/Origin/CSRF 及源包/Builder/OCI 的各自扫描范围。原七文件扫描仅绑定其记录的历史字节，两份冻结 L07 文件仍匹配；living 文档后续修改另绑定。五份快照/资源文档保留自己的独立扫描。最终公开字节由[外置核验清单](../../.local/g-mvp-final-review-20261029-21720acd-e7bf-490b-ad7d-f03884ce0e1f/final-validation.json)统一记录：**生成时待核验，最终结果以外置收据为准。** 该清单在最终扫描和 helper 关闭后写入；旧 passed 状态不扩大到新字节，生成器未执行秘密扫描，不向被扫描 JSON 回填扫描 hash。

L08 的最新实际结果见[真实读屏报告](g-mvp-screen-reader.md)与[读屏机器结果](g-mvp-screen-reader-results.json)：reader-04 prepare 通过；run 在 `twelve-real-voiceover-checks` 因 `SCREEN_READER_VOICEOVER_AUTOMATION_NOT_AUTHORIZED` 失败。一次测试认证已接受；`login-username-label` 的检查尝试因 `SCREEN_READER_VOICEOVER_TRANSPORT_FAILED` 中止，**0 项通过、0 份有效朗读，另 11 项未执行**。该传输失败不建立产品 label 有缺陷的结论。

reader-04 同次自动恢复完整闭合：两次观察中实际 VoiceOver 均关闭、原生进程为 0、四个 typed 偏好与基线一致、原前台恢复、9 把唯一锁和事件关闭，restorationRequired=false。恢复成功不能把该次 run 改写为读屏通过。reader-01 的原失败与独立 restore、reader-02 的 getter 未确认失败、reader-03 的设置自动化权限失败，以及 2026-10-26 原因未证实的环境失败均按各自原回执和源码版本保留；不拼接成功、不相加重叠计数。公开读屏证据仅使用 label 与 hash，不公开实际朗读、认证内容或原生动作对象。

目前仍没有有效朗读证明选定字段/错误、项目上下文、状态与日志控制。Axe、ARIA、键盘、配置开关、工具静态回归或能力预检不能替代真实朗读；12 个选定语义也不覆盖完整 UX 矩阵或全部 WCAG 要求。L08、F24、N08 与 UX07 继续 partial；S6/G-MVP 继续 in-progress，S7 入口为 false。

| 外部关口 | 未验范围 | 所需证据 |
| --- | --- | --- |
| X01 | 独立云控制面与真实 VPS | 真实云安装/规格/SSH/sudo/防火墙/K3s/API SAN 与持续运行 |
| X02 | 公共域名与可信证书 | 公共 A/AAAA、80/443、Let's Encrypt staging→production、默认信任与跨网络访问 |
| X03 | GitHub 自身与外部 Registry | GitHub SaaS 授权/权限/公网投递，以及选定 Registry 与目标 VPS push/pull |
| X04 | 架构与物理故障域 | 计划支持的 amd64/arm64 各自实际运行、独立物理备份/密钥与恢复 |
| X05 | 目标容量与生产 RPO/RTO | 真实目标规格、实际网络/数据量、整套进程/数据库/日志/磁盘成本和恢复时间 |

本地 ARM64/Lima、显式测试 CA、同物理 Mac 的备份与目标，以及已准备缓存/凭据/TLS/VM 容量均保留范围限制；不证明公开 DNS/公共根信任、独立物理故障域、目标架构/容量、远程备份下载、人工响应或生产端到端 RTO。S6/G-MVP 继续 in-progress，S7 入口未满足。
