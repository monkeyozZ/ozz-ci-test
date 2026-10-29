# G-MVP 本地真实读屏

选定run未构成全部完成的实际读屏样本；已执行项与未执行项分别记录。
生成时间：2026-10-29T05:56:14.088435+00:00。状态：`failed`。本地局部事实报告。

这是12个选定产品语义的局部结果。整体S6/G-MVP继续in-progress，S7入口不由本报告自动满足。

[机器结果](g-mvp-screen-reader-results.json)保留允许字段、证据label与SHA256；终态回执的绝对路径只在本地私有映射中保存。

| 具名检查 | 驱动尝试状态 |
| --- | --- |
| login-username-label | failed（读屏传输失败，未形成产品语义结论） |
| login-empty-password-label | unexecuted |
| login-native-required-error | unexecuted |
| project-selected-target | unexecuted |
| project-target-inheritance-context | unexecuted |
| project-slug-associated-help | unexecuted |
| oom-disclosure-summary | unexecuted |
| failed-deployment-status | unexecuted |
| build-log-bounded-region | unexecuted |
| build-log-source | unexecuted |
| deployment-log-bounded-region | unexecuted |
| deployment-log-source | unexecuted |

未执行项不计为产品失败；读屏传输失败也不证明产品语义或label有缺陷。prepare、原生描述符自检或纯静态回归通过，均不能替代实际朗读。

选定session：`reader-20261029-04`。三类阶段各自按其实际终态解释：

| 阶段 | 状态 | 检查尝试数 | 认证次数 | 证据label / SHA256 |
| --- | --- | ---: | ---: | --- |
| prepare | passed | 0 | 0 | `selected-prepare` / `1591d3ee5c52045e47f497d4eed8d1a143e5ca5195787303e858b10ad28a827d` |
| run | failed | 1 | 1 | `selected-run` / `b89e3c77215b7ba0cab7ec5604cbaead2cb133b67b4f5d8f3bf957d8f1893f7c` |

选定run失败阶段：`twelve-real-voiceover-checks`；失败码：`SCREEN_READER_VOICEOVER_AUTOMATION_NOT_AUTHORIZED`。已尝试 1 项，未执行 11 项。恢复完成不会将该次run改为通过。

其中 1 项检查尝试因`SCREEN_READER_VOICEOVER_TRANSPORT_FAILED`中止；它记录系统读屏传输阻点，不认定对应产品label失败。实际通过 0 项，有效朗读捕获 0 份。

run实际捕获记录数：0；同一reader进程：`无捕获，未评估`；产品身份严格比较相同：`未形成前后观测`。
同次run恢复证明：`True`；事件关闭：`True`；释放锁数：9。

操作者安全摘要：`selected-operator-summary` / `ad575806e4865477f2460d74df6c0fc2e6ad6363473510d048db69ee461ab6eb`；与本run收据SHA和认证尝试数一致，操作者记录测试认证已接受：`True`。生成器未读取实际认证回执，也未发布nativeActions。

reader-01原失败完整保留：prepare通过；run在`verify-native-restoration-control`阶段因`SCREEN_READER_UNOWNED_NATIVE_PROCESS`失败，实际产品检查0项、认证0次。用户确认期间自行开启旁白，不能归因于settings-open或产品缺陷。

随后独立restore通过：实际VoiceOver关闭，原生进程为0，磁盘/defaults四个typed偏好在两次观察中与基线严格一致，前台恢复，restorationRequired=false，事件关闭、9把锁释放。该restore不等于读屏通过，不将原run改写为passed，也不把临时恢复操作算作产品测试。

| reader-01保留阶段 | 原状态 | label | SHA256 |
| --- | --- | --- | --- |
| prepare | passed | `reader01-prepare` | `8722a149290e60257a2e240e704023f46b656a597fe93895afe56e5e1a60d338` |
| run | failed | `reader01-run` | `5473605c5e2af9af99c63e08df578281a61b75bcf8de9727aa8bece239764dae` |
| restore | passed | `reader01-restore` | `e0b36f6a18fb0300dc60b079d8d5c9a960278c204f29204e70aef0b1191b6dcc` |

操作恢复安全摘要：`reader01-operator-restoration-summary` / `b55aabbb1edfe2a6588f48042e9f368d49ec891b528970414f1bf402444154da`。
旧reader-01的三个执行probe绑定修订前的原源码快照；另一个测试源码仅是归档旁证。两个repo依赖按原回执哈希核对，原生bridge只引用驱动记录的摘要，不执行或重新读取它。

reader-02也作为独立历史保留：只读prepare在`prepare-read-only`阶段因`SCREEN_READER_DESKTOP_LOCKED_OR_UNCONFIRMED`失败，尚无run、UI、认证或产品检查，偏好未改变，事件及9把锁均闭合。该错误表示getter未获得确认，不能写成已确认桌面锁屏。
root的独立只读诊断显示原IOService:/入口没有所需console属性，IORegistryGetRootEntry取得了有效的解锁console行；随后源码修订和新session均不改写reader-02。该失败尚未写入protected源码清单，公开记录保留这一绑定缺口。prepare与诊断不计产品通过或失败。
reader-02 prepare证据：`reader02-failed-prepare` / `f2ad621b02b4f632f85d16c3a113d13926aedda053331ae8e5cf12a53e2e4d7d`；诊断证据：`reader02-desktop-root-diagnosis` / `40e6a99d233e6fc5e1c0f528ec8b4d8dbb7acf27a5d8902627164508418b5689`。

reader-03独立失败历史也保留：prepare通过，run在`verify-native-restoration-control`因`SCREEN_READER_SETTINGS_AUTOMATION_NOT_AUTHORIZED`失败。实际检查0项、认证0次、捕获0份，12个产品检查均未执行。
reader-03同次自动恢复完整闭合：两次恢复观察均与基线相符，实际VoiceOver关闭、原生进程0、四typed偏好一致、前台恢复、事件与9把唯一锁关闭、restorationRequired=false。该恢复不会改写failed run；源码绑定该次原冻结版本，后续修订不倒填。

| reader-03保留阶段 | 原状态 | label | SHA256 |
| --- | --- | --- | --- |
| prepare | passed | `reader03-prepare` | `71db2f5fe64e78edd81331070ceae143b5203f6624056f3bab24cef8b48b6401` |
| run | failed | `reader03-run` | `371fc9dee0100303ec1b00aefe2b1095218525a3ef23e42242041ac18e3d74f7` |

2026-10-26的旧环境尝试与reader-01分别保留：当时启动后退出、未获得有效真实朗读，原因未证实，不能认定12个产品缺陷或通过。

范围限制：

- 一次本地macOS VoiceOver会话中的12个选定产品语义；不是全部UX矩阵或完整WCAG审计。
- 原生bridge编译、自描述事件构造/静态测试及prepare通过不证明VoiceOver实际朗读；运行通过须12项实际检查、非空PID定向朗读证据、身份保持、请求审计及恢复闭合。
- 仅投影显式具名terminal report；公开证据用label、SHA256和字节数定位，绝对路径只在本地私有映射保存。原始朗读、认证对象、请求路径、前台进程路径和nativeActions不发布。
- 独立restore成功只证明环境恢复，不能把此前failed run改成读屏通过；各尝试、源码版本与计数分别保留。
- 本地HTTPS使用保留测试CA和专用浏览器上下文，不新增生产Secure Cookie、公共根信任或公网验收结论。
- 除测试鉴权外，具名run不执行部署、构建、基础设施或产品配置变更；现有产品身份由驱动和报告字段分别核对。
- 恢复范围包括实际VoiceOver getter、四个typed激活/脚本偏好、原生进程和原前台；未扩展到系统所有偏好键或用户其他应用状态。
- 生成器不运行浏览器、VoiceOver、原生bridge、数据库、SSH、VM或负载；不读profile、state、配置/凭据文件、私日志、独立phrase文件或归档，也不执行秘密扫描。
- S6/G-MVP总体与外部门禁由主验收记录另行判断，S7入口不由此局部报告自动满足。

[外置核验清单](../../.local/g-mvp-final-review-20261029-21720acd-e7bf-490b-ad7d-f03884ce0e1f/final-validation.json)：生成时待核验，最终结果以外置收据为准。清单在最终字节扫描和helper关闭后写入；生成器未执行秘密扫描，不预填通过结论，也不向被扫描JSON回填扫描hash。
