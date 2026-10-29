# Ozz Console 交互精修记录

**当前阶段：P0–P2 实际 Console 与完整 v3 原型已完成本地验收，本轮远端 CI 待执行。** Console 的 112 项完整回归、随后独立执行的原生 200% 缩放 1/1、原型原有 18 组与新增 16 组均通过。新 CI 将统一执行 113 项 Console 用例；本地两次执行仍分别记录。本文记录用户《Ozz 前端交互精修任务 — 以 Zeabur 为核心参考》的后续工作。[原始要求](/Users/monkeyozz/.codex/attachments/2c302f80-39bb-49df-a42b-d6e2d2f60b6a/pasted-text-1.txt)保存在本机附件中；执行范围和验证口径归纳如下。

## 基准与范围

**[designs/console-v3](../designs/console-v3/README.md) 是本轮唯一的当前交互基准。** 现有 Vue 页面已经实现 v3 的全局导航、项目工作区、六个服务页签和连续创建流程，本轮在这些 UI 与交互上打磨，不重新设计页面结构。早期简版、v1 图片与 v2 设计是历史材料。

- 保留项目、服务器、设置三个全局主入口，项目内服务导航，以及状态、变量、用量、网络、数据与存储、设置六页签。
- 保留“完整创建项目页 → 首服务来源选择 → 配置 → 保存服务草稿 → 同面板核对 → 确认发布”的路径。返回、关闭、失败与重试不得换服务身份或丢失背景编辑。
- 保留现有功能、API、幂等键、revision、秘密保护及 `Cluster → Project → Environment → Service` 归属。单环境隐藏选择，多个环境或环境尚未完整读取时保留明确上下文。
- 原型的演示状态与未来功能不等于真实 API 能力。业务边界仍以 [PRD](prd.md)、API 和真实后端为准；不新增虚构阶段、百分比、部署成功、密码回显或数据恢复能力。
- 本文的 P0/P1/P2 是本次精修的实施顺序，不改变 PRD 的业务阶段或 F01–F50 编号。完整功能与旧场景清单继续由 [v3 覆盖规划](../designs/console-v3/coverage-plan.md)承载。
- 用户已排除旁白、真实读屏与无障碍专项。正常键盘、焦点、IME、缩放、响应式与减少动效仍属于日常交互验证。

[旧 v3 实施记录](console-v3-interaction.md)和提交 `095fc261faa508941ad8a69fc208ae29209a7980` 的 [CI](acceptance/console-v3-ci.md)仅作为改版基线。旧文档中的“本轮”“当前版本通过”指那次 v3 改版，**不证明本次 Interaction Polish 已实施或通过验证**。

## v3 入口与真实源码映射

下表用于检查精修是否偏离 v3 或遗漏入口。它是代码映射，不是本轮浏览器验收结果；原型与真实页面允许适应真实资源/API 的必要差别。

| v3 入口或连续流程                                    | 原型实现                                                                                                                  | 真实 Console 对应                                                                                                                                                                                                                                                                                                                                                                                    | 本轮约束                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 三个全局入口、顶栏活动、快速打开、主题、移动导航     | [app.js](../designs/console-v3/app.js)：`sidebar`、`topbar`、`commandSearchPanel`                                         | [NavigationContent](../apps/console/src/components/NavigationContent.vue)、[AppShell](../apps/console/src/components/AppShell.vue)、[CommandPalette](../apps/console/src/components/CommandPalette.vue)                                                                                                                                                                                              | 保留入口，只精修状态、焦点、菜单与导航反馈                      |
| 项目列表、完整创建项目页、首服务衔接                 | app.js：`projectsPage`、`createProjectPage`、`createProject`                                                              | [ProjectsPage](../apps/console/src/pages/ProjectsPage.vue)、[ProjectCreatePage](../apps/console/src/pages/ProjectCreatePage.vue)                                                                                                                                                                                                                                                                     | Cluster 选择、可选名称、更多设置和未知结果保护均保留            |
| 项目内服务选择、项目设置、整合、环境管理             | app.js：`sidebar`；[management.js](../designs/console-v3/management.js)：`projectSettingsPage`、`projectIntegrationsPage` | NavigationContent、[ProjectPage](../apps/console/src/pages/ProjectPage.vue)、[IntegrationConnections](../apps/console/src/components/git/IntegrationConnections.vue)                                                                                                                                                                                                                                 | 环境不是数据库分类；不可因精简删除环境 CRUD 或改变项目目标      |
| GitHub、Docker、应用模板、数据库来源与逐步返回       | app.js：`openSource`、`sourcePanel`、`sourceStep`                                                                         | [ServiceCreationDialog](../apps/console/src/components/services/ServiceCreationDialog.vue)、[ServiceCreatePage](../apps/console/src/pages/ServiceCreatePage.vue)、[ImageServiceCreatePage](../apps/console/src/pages/ImageServiceCreatePage.vue)、[GitServiceCreatePage](../apps/console/src/pages/GitServiceCreatePage.vue)、[TemplateCreatePage](../apps/console/src/pages/TemplateCreatePage.vue) | 保留原页面背景、来源草稿与五个现有模板，不添加不可用来源        |
| 六页签、共享草稿、同源部署/日志/历史面板             | app.js：`servicePage` 及各页签函数                                                                                        | [ServicePage](../apps/console/src/pages/ServicePage.vue)、[ServiceWorkspacePanel](../apps/console/src/components/services/ServiceWorkspacePanel.vue)                                                                                                                                                                                                                                                 | 保留已访问编辑器、旧页签链接、项目/环境/服务身份                |
| 保存服务后核对、发布、失败与独立重试                 | app.js：`saveCreationDraft`、`createService`、`publishService`                                                            | [ServiceCreationFrame](../apps/console/src/components/services/ServiceCreationFrame.vue)、[ConfigurationReview](../apps/console/src/components/services/ConfigurationReview.vue)、[DeploymentPage](../apps/console/src/pages/DeploymentPage.vue)                                                                                                                                                     | 草稿、发布快照、任务受理、最近成功发布与实际运行分开            |
| 变量、批量导入、运行参数、资源、探针、停止/恢复/删除 | app.js：`variablesEditor`、`configurationGroups`、`serviceOperation`、`deleteService`                                     | [ServiceVariablesEditor](../apps/console/src/components/services/ServiceVariablesEditor.vue)、[ServiceConfigurationEditor](../apps/console/src/components/services/ServiceConfigurationEditor.vue)、ServicePage、[ServiceDeletionReview](../apps/console/src/components/storage/ServiceDeletionReview.vue)                                                                                           | 不因保存草稿即时部署；恢复沿用已发布版本；删除服务不销毁卷      |
| 当前日志、任务输出、筛选、跟随与复制                 | app.js：`logsPanel`、`taskPanel`；management.js：`taskPage`                                                               | [ServiceLogViewer](../apps/console/src/components/services/ServiceLogViewer.vue)、[VirtualServiceLog](../apps/console/src/components/services/VirtualServiceLog.vue)、[BuildLogs](../apps/console/src/components/git/BuildLogs.vue)、[DeploymentLogs](../apps/console/src/components/services/DeploymentLogs.vue)、[OperationPage](../apps/console/src/pages/OperationPage.vue)                      | 搜索/复制仅覆盖已载入范围；实际来源、连接状态与终态输出可追踪   |
| Server、SSH 指纹/预检、K3s 初始化、Cluster/Node 观察 | management.js：`serversPage`、`serverPage`、`clusterPage`                                                                 | [InfrastructurePage](../apps/console/src/pages/InfrastructurePage.vue)、[ServerPage](../apps/console/src/pages/ServerPage.vue)、[ServerOnboarding](../apps/console/src/components/infrastructure/ServerOnboarding.vue)、[ClusterPage](../apps/console/src/pages/ClusterPage.vue)、[ClusterConnection](../apps/console/src/components/infrastructure/ClusterConnection.vue)                           | 保留 Server / Cluster / Node 模型、连接预览和任务回链           |
| 服务网络、默认域名、DNS/路由/TLS 与解绑              | app.js：`networkPage`；management.js：`domainPage`                                                                        | [ServiceNetworkPanel](../apps/console/src/components/networking/ServiceNetworkPanel.vue)、[DomainPage](../apps/console/src/pages/DomainPage.vue)、[DomainActions](../apps/console/src/components/networking/DomainActions.vue)、[DomainObservations](../apps/console/src/components/networking/DomainObservations.vue)                                                                               | 保留独立观察、时间、重新检查与完整域名确认                      |
| 卷、数据库、应用连接、手工维护与证据记录             | app.js：`storagePage`；management.js：`volumePage`、`databasePage`、`maintenancePanel`、`recordsPanel`                    | [VolumePage](../apps/console/src/pages/VolumePage.vue)、[DatabasePage](../apps/console/src/pages/DatabasePage.vue)、[ServiceDatabaseBindings](../apps/console/src/components/storage/ServiceDatabaseBindings.vue)、[VolumeMaintenancePanel](../apps/console/src/components/storage/VolumeMaintenancePanel.vue)、[ManualDataRecords](../apps/console/src/components/storage/ManualDataRecords.vue)    | 保留源服务删除后的独立数据入口、真实销毁预检与维护锁            |
| 设置、凭证、GitHub/Builder/Registry、所有资源和任务  | management.js：`settingsPage`、`credentialPage`、`integrationsPage`、`resourcesPage`、`activityPage`                      | [SettingsPage](../apps/console/src/pages/SettingsPage.vue)、[GitBuildIntegrations](../apps/console/src/components/git/GitBuildIntegrations.vue)、各资源列表、[DeploymentsPage](../apps/console/src/pages/DeploymentsPage.vue)、[OperationsPage](../apps/console/src/pages/OperationsPage.vue)                                                                                                        | 聚合页和次级入口保持可达，不恢复冗长主菜单                      |
| F26–F50 规划演示                                     | app.js：`openPlan`；management.js：`planningPage`                                                                         | 真实能力边界见 v3 覆盖规划                                                                                                                                                                                                                                                                                                                                                                           | 本轮不把规划演示发布为可执行功能，不把未接入 API 误报为精修遗漏 |

上述核心 v3 入口保持现有结构，差距集中在异步状态、表单保护、日志、复制和上下文恢复。P0–P2 的实际 Console 修改已完成本地完整回归及独立缩放补验，结果见下文；这份源码映射不等于所有旧业务场景、原型最终版本或真实基础设施已经验收。

## 阶段审计与实施清单

位置按本轮审计时源码记录，修改后行号可能移动。下表保留起始问题、最小修复范围与验证目标；P0–P2 实际 Console 的实施结果、报告和边界分别记录在后文，原型与远端 CI 的待验状态单独列明。

### P0：交互基础，已验证

| ID    | 问题与本轮最小动作                                                                                                     | 源码位置                                                                                                                                                                                                                                               | 必要验证                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| P0-01 | 按钮、链接按钮、输入与状态反馈需统一；修正 `asChild` 禁用链接仍可导航的边界，统一 hover/active/focus/disabled 与短动效 | [Button.vue](../apps/console/src/components/ui/button/Button.vue)、[variants.ts](../apps/console/src/components/ui/button/variants.ts)、[styles.css](../apps/console/src/styles.css)                                                                   | 鼠标与键盘触发、禁用链接、触摸目标、明暗主题、减少动效；不把只读元素做成可点击   |
| P0-02 | 统一 Dialog 首焦点、关闭恢复、IME/Esc、busy 禁止关闭，保留关闭动画期间的标题/说明                                      | [Dialog.vue](../apps/console/src/components/ui/dialog/Dialog.vue)、[GlobalFeedback.vue](../apps/console/src/components/GlobalFeedback.vue)                                                                                                             | Esc/遮罩/关闭按钮、确认与原弹层衔接、滚动锁定、关闭文字不闪空、迟到回调不抢焦点  |
| P0-03 | 首次加载、后台更新、刷新失败和离线反馈分开，保留已载入内容；接口错误不能同时显示真实空态                               | [QueryState.vue](../apps/console/src/components/QueryState.vue)、[useNetworkStatus.ts](../apps/console/src/composables/useNetworkStatus.ts)、AppShell；[DeploymentCollection.vue:79](../apps/console/src/components/services/DeploymentCollection.vue) | 首载/重试/离线恢复、慢刷新、带缓存失败、无缓存失败、空结果；局部错误不清空工作区 |
| P0-04 | 提示堆叠、自动消失和确认关闭协调；限制重复提示与遮挡，清理计时器                                                       | GlobalFeedback、[stores/ui.ts](../apps/console/src/stores/ui.ts)                                                                                                                                                                                       | 连续成功/失败提示、手动关闭、会话退出、活动弹层的确认按钮不被遮挡                |
| P0-05 | 移动导航与窄屏页签应保持选中项可见并恢复焦点；沿用 v3 菜单和页签                                                       | AppShell、CommandPalette、[useActiveTabVisibility.ts](../apps/console/src/composables/useActiveTabVisibility.ts)、ServicePage、SettingsPage                                                                                                            | 菜单开关、快速打开、前后退、窄屏切页签、滚动不强制归零                           |
| P0-06 | 项目创建的 pending/unknown 保护必须覆盖返回、导航、快速打开和退出；已受理结果仍可进入原项目                            | ProjectCreatePage、[useProjectCreationState.ts](../apps/console/src/composables/useProjectCreationState.ts)、[router.ts](../apps/console/src/router.ts)、AppShell                                                                                      | 慢创建、响应未知、重复点击、页面离开与退出；会话失效仍能到登录，重试保持原请求   |
| P0-07 | 项目列表搜索、目标筛选和返回位置缺少完整上下文恢复；使用 URL 与按会话隔离的返回状态                                    | ProjectsPage、[useProjectListContext.ts](../apps/console/src/composables/useProjectListContext.ts)、router                                                                                                                                             | 进入服务后返回、刷新、前后退、清空筛选、数据加载后恢复位置、不同账户不串状态     |
| P0-08 | 复制反馈需等待真实剪贴板结果，并在失败时局部解释，避免另开弹层覆盖编辑                                                 | [CopyButton.vue](../apps/console/src/components/CopyButton.vue)                                                                                                                                                                                        | Promise 延迟/拒绝、重复点击、值变化与卸载；不显示复制值，不对空值假报成功        |

P0 已完成对应代码与浏览器验证，结果见下文。下表继续保留起始问题与验证目标，最终结果以阶段报告和当前源码绑定为准。

### P1：项目、服务、部署、配置与日志，实际 Console 已验证

| ID    | 已确认问题 / 最小修复范围                                                                                        | 审计位置                                                                                                                                                                                                                                           | 必要验证                                                                                 |
| ----- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P1-01 | 慢 `.env` 解析关闭重开后，旧响应可覆盖新文本对应的预览；按输入/请求代次核对，清空、改文、卸载时废弃旧结果        | [ServiceVariablesEditor.vue:25–32、58–63](../apps/console/src/components/services/ServiceVariablesEditor.vue)                                                                                                                                      | 旧请求迟到、关闭重开、连续编辑、导入失败保留新输入；秘密不持久化                         |
| P1-02 | “载入最新”无动作锁；请求期间的新输入或失败时旧缓存可被无条件回填覆盖；增加 pending 反馈并核对草稿快照/请求代次   | [ServicePage.vue:238–254、863–868](../apps/console/src/pages/ServicePage.vue)                                                                                                                                                                      | 慢载入后继续输入、重复点击、取消确认、网络错误与旧缓存，失败不丢草稿                     |
| P1-03 | 添加服务首焦点落到关闭按钮，KeepAlive 切步骤无明确焦点定位；对齐 v3 来源首项/首字段/复核区域的行为               | [ServiceCreationDialog.vue:66–88](../apps/console/src/components/services/ServiceCreationDialog.vue)、[ServiceCreatePage.vue:25](../apps/console/src/pages/ServiceCreatePage.vue)                                                                  | 打开、方向键/IME、来源→配置→复核→返回、关闭回触发；现有测试手动 focus 不能替代首焦点断言 |
| P1-04 | BuildLogs 的 active 变为 false 后没有终态补读，可能漏掉两次轮询之间产生的末批输出                                | [BuildLogs.vue:50、88](../apps/console/src/components/git/BuildLogs.vue)                                                                                                                                                                           | 成功/失败末批、尾页追取、去重及既有 200 段/20 万字符上限；读完后停止                     |
| P1-05 | 同目标重读先 `stop(true)` 清空缓冲，重连失败会丢失排障输出；在新响应成功前保留旧缓冲，换目标仍清空               | [ServiceLogViewer.vue:154](../apps/console/src/components/services/ServiceLogViewer.vue)                                                                                                                                                           | 网络失败、同目标重连、切 Pod/container/previous、旧订阅迟到与卸载                        |
| P1-06 | 日志握手之前已经显示“连接已建立”；区分连接中、接收中、结束和失败                                                 | [ServiceLogViewer.vue:158、293](../apps/console/src/components/services/ServiceLogViewer.vue)                                                                                                                                                      | 慢握手、拒绝、零输出、正常结束与中断；提示必须对应真实连接事件                           |
| P1-07 | 无 Pod 时仅凭 desiredState 显示“已停止”，混淆期望与实际；未知/陈旧观察仍应明确未知                               | [ServiceLogViewer.vue:220](../apps/console/src/components/services/ServiceLogViewer.vue)、[ServiceRuntimePanel.vue:199](../apps/console/src/components/services/ServiceRuntimePanel.vue)                                                           | 期望停止但观察未知/过期、真实停机、实例不可读，不把缺失指标当作零                        |
| P1-08 | 部署、构建和 Operation 输出缺复制；四类日志缺当前缓冲搜索，Operation 缺跟随/暂停；接入 P0 复制控件并保留有界输出 | [DeploymentLogs.vue:96](../apps/console/src/components/services/DeploymentLogs.vue)、[BuildLogs.vue:125](../apps/console/src/components/git/BuildLogs.vue)、[OperationPage.vue:409](../apps/console/src/pages/OperationPage.vue)、ServiceLogViewer | 剪贴板失败、仅已载入范围筛选、新日志不抢历史阅读、暂停/回底、缓冲上限                    |
| P1-09 | 部署列表筛选只存在本地 ref，进入记录后返回丢失；绑定 URL/返回上下文                                              | [DeploymentCollection.vue:14](../apps/console/src/components/services/DeploymentCollection.vue)                                                                                                                                                    | 服务内面板与独立记录往返、刷新、前后退，保留项目/环境/服务身份                           |

已有并应保留：服务切换的 abort/generation 保护、卸载清理、VirtualServiceLog 有界虚拟化、已访问编辑器保活、各来源草稿、幂等重试和发布预览校验。平台 Deployment/Operation 日志后端限制 64 条、首取 100 条，审计中的“分页追尾可能漏日志”在该范围不可达，不作为缺陷或新增测试目标。部署阶段只使用真实数据；镜像来源不添加 Building。

### P2：基础设施与细节，实际 Console 已验证

| ID    | 已确认问题 / 最小修复范围                                                                                          | 审计位置                                                                                                                                                                                                                                                                                                           | 必要验证                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| P2-01 | 凭证类型切换立即清空秘密输入；改为受控切换，有输入时确认，取消保留原类型和内容                                     | [SettingsPage.vue:364–376](../apps/console/src/pages/SettingsPage.vue)                                                                                                                                                                                                                                             | 输入后误切、取消/确认、连续切换；确认前不把旧私钥放入其他类型控件                          |
| P2-02 | 指纹读取/信任、SSH 预检、集群同步、域名检查只有 disabled；按当前动作显示“读取/保存/受理中”。凭证删除显示当前行状态 | [ServerOnboarding.vue:326、388、407](../apps/console/src/components/infrastructure/ServerOnboarding.vue)、[ClusterConnection.vue:331](../apps/console/src/components/infrastructure/ClusterConnection.vue)、[DomainActions.vue:137](../apps/console/src/components/networking/DomainActions.vue)、SettingsPage:539 | 慢请求、重复点击、失败/重试与任务回链；受理不等于远端成功，幂等与互斥保留                  |
| P2-03 | DNS 配置没有记录值复制入口；复用 CopyButton，只复制实际返回的地址/CNAME                                            | [DomainObservations.vue:31–51](../apps/console/src/components/networking/DomainObservations.vue)、[DomainAllocationForm.vue:146–166](../apps/console/src/components/networking/DomainAllocationForm.vue)                                                                                                           | 多地址、长 CNAME、空值、剪贴板失败；不新增 DNS 写入能力                                    |
| P2-04 | 数据库 host/port/database/username 不便复制；补非敏感字段入口，未知 host 不生成假值                                | [DatabaseIdentity.vue:90–111](../apps/console/src/components/storage/DatabaseIdentity.vue)                                                                                                                                                                                                                         | PostgreSQL/Redis、未部署、长字段、复制成功/失败；API 只返回凭证引用，不补密码原文          |
| P2-05 | 服务器/集群、数据库和卷列表的搜索在离开/刷新后丢失；衔接 URL 与返回上下文                                          | [InfrastructurePage.vue:20](../apps/console/src/pages/InfrastructurePage.vue)、[VolumesPage.vue:19](../apps/console/src/pages/VolumesPage.vue)、[DatabasesPage.vue:17](../apps/console/src/pages/DatabasesPage.vue)                                                                                                | 详情返回、刷新、前后退、筛选组合；基础设施只筛已载入条目，卷/数据库使用后端搜索            |
| P2-06 | 凭证和新集群内联表单关闭后不恢复入口焦点；关闭完成后恢复，异步回调检查视图归属                                     | [SettingsPage.vue:164–216](../apps/console/src/pages/SettingsPage.vue)、[ServerOnboarding.vue:258–282](../apps/console/src/components/infrastructure/ServerOnboarding.vue)                                                                                                                                         | 取消、放弃确认、保存成功、期间导航；ClusterConnection 和 ServerPage 已有的正确恢复行为保留 |
| P2-07 | 基础设施日志缺复制/跟随控制；复用 P1 日志交互与 P0 复制控件                                                        | [InfrastructureTask.vue:217–250](../apps/console/src/components/infrastructure/InfrastructureTask.vue)                                                                                                                                                                                                             | 追加、历史阅读、分页、切任务、连接失败；仅搜索/复制已载入范围                              |

维护和销毁保护已存在，不能在精修中弱化：卷销毁使用真实 preview/revision/PVC UID/digest/blockers 与完整名称确认；维护锁不会因超时、失败或取消自动解除；域名解绑需要完整域名；移除服务器/集群登记不等于卸载远端软件。[OperationDto](../packages/api-client/src/schema.ts)只有状态、时间和结果，没有通用 stage/phase 字段，基础设施任务不能虚构阶段或百分比。本地明暗主题、长文本、390/1024/1440 px 与原生 200% 缩放的实测范围和结果见后文；这些界面检查不扩大真实操作验收范围。

## 原型同步清单

P0–P2 已在现有五个运行文件中完成同步，原有 18 组与新增 16 组均通过最终复验。新增脚本检查的页面脚本错误、控制台错误、外部请求均为 0；原有脚本记录的页面脚本错误与 HTTP 请求均为 0。两份报告的五个运行文件 SHA256 与当前源码一致，继续维护 `index.html + app.js + management.js + styles.css + management.css`。

| 同步项               | 原型实现依据                                                                                                            | 已同步行为与验收边界                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 状态、动效与弹层  | styles.css；app.js:`notify/openModal/closeModal`                                                                        | 已同步 pending/disabled、开闭动效、首焦点、关闭恢复、减少动效和局部反馈，保持 v3 布局；P0/P1 阶段已有浏览器证据                                                     |
| 列表上下文与创建保护 | app.js:`projectsPage/createProjectPage/goto`、hashchange；management.js:`filters/change/listHref/detailHref/returnHref` | 项目搜索、筛选、返回位置和创建受理中/未知结果保护已同步；P2 增加管理列表经详情页签、刷新和安全返回链接保留筛选。演示数据仍按 README 的重置边界处理                  |
| 创建步骤与草稿动作   | app.js:`sourceStep/saveCreationDraft`                                                                                   | 来源、配置、复核及返回定位相应焦点，关闭后新会话不复用旧输入；可控慢响应和未知结果保留原受理身份。`.env` 与配置仍是本地演示，真实异步校验由 Console 用例验证        |
| 日志与任务输出       | app.js:`logsPanel/taskLogPanel/taskPanel`；management.js:`taskPage`                                                     | 已同步连接与重连反馈、失败保留缓冲、目标切换隔离、已载入范围搜索/复制及历史阅读位置；P2 独立操作输出不虚构通用阶段，示例持续标明演示                                |
| DNS 与数据库复制     | management.js:`domainPage/databasePage`；app.js:`copyText/decorateCopies`                                               | 已增加实际存在的非敏感字段复制，Promise 成功/失败就地反馈，空值不提供复制入口；新增 16 组已通过复制与窄屏行为断言                                                   |
| 凭证与内联表单       | management.js:`change/secretSnapshot/preserveInputs/confirmFormClose`；app.js:`demoRequest`                             | 有输入时切类型先确认，取消恢复当前类型和输入，关闭后恢复入口；慢保存保护原表单并避免重复受理。秘密仅在当前 DOM 和短期恢复闭包中保留，不进入可序列化状态、URL 或存储 |
| 远端受理与实际任务   | management.js:`queue/action`；app.js:`demoRequest/addTask/taskPanel`                                                    | 指纹、预检、集群与域名操作已区分点击等待、任务受理及最终观察；演示阶段不作为 Operation API 能力承诺                                                                 |

[README](../designs/console-v3/README.md)、[coverage-plan](../designs/console-v3/coverage-plan.md) 和 [console-v3-interaction.md](console-v3-interaction.md) 已增加精修衔接，并保留旧截图与旧通过记录的版本范围。当前两份最终报告位于 `.local/interaction-polish/evidence/final-prototype/`，源码与报告摘要统一保存在 `local-final-record.json`。修复前的失败报告独立保留，详见下方原型最终复验。

## 验证和收尾要求

| 层次        | 本轮记录的内容                                                                              | 当前结果与边界                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 代码与类型  | 构建、类型、lint/格式、单元与必要的异步竞态测试                                             | P2 生产构建、Console/测试类型、仓库 ESLint/Prettier、69 项 Console 单元通过；新增 zoom 测试的类型、ESLint 和 Prettier 另行通过 |
| P0 浏览器   | hover/active/focus/disabled、Dialog/菜单/抽屉、加载/缓存错误/离线、提示、复制、导航与上下文 | 已含在本地 112 项完整回归中；P0 阶段 38 项证据保留，旧 v3 CI 不计入本轮                                                        |
| P1 连续路径 | 创建、服务编辑、核对、日志、切换与运行操作；返回、慢请求、失败和未知结果                    | P1 阶段 63 项通过，随后纳入 112 项完整回归；受控 API 只证明 UI 行为                                                            |
| P2 连续路径 | 服务器/集群等待、域名与数据库复制、基础设施任务日志、凭证保护、资源列表返回                 | 新增 22 项并纳入 112 项完整回归；真实 SSH/K3s、DNS/ACME、数据库和存储操作另记证据                                              |
| 完整原型    | 新增状态、完整管理入口、脚本/控制台错误、外部请求和运行文件摘要                             | 最终原有 18 组与新增 16 组均通过，页面脚本错误与外部请求为 0；新增脚本另查控制台错误为 0                                       |
| 主题与布局  | 明暗、390/1024/1440 px、长名称/地址、减少动效、正常键盘与 IME                               | 已有响应式、长文本和键盘结果；原生 200% Chrome 独立补验 1/1 通过。合成 composition 事件不等于真实中文输入法通过                |
| 远端 CI     | 本轮提交、检查结论、下载报告及对应源码摘要                                                  | 新配置将包含 113 项 Console 用例，并运行原型新增脚本与原有脚本；尚未推送或执行，没有本轮远端通过结果                           |
| 收尾        | 实际修改、命令/结果、报告路径、源码版本与未验证边界                                         | 本地 Console、缩放和最终原型证据已保存，体验站已更新；本轮远端 CI 待执行                                                       |

以上表格汇总当前状态，以下阶段结果记录实际修改、执行和边界。Console 界面用例使用全量受控 API，原型使用内存演示；未在用户数据库执行测试变更。

## P0 实施结果（2026-10-29）

保留 v3 页面和功能入口，完成按钮禁用（含链接中键）、反馈与动效、弹窗忙碌/关闭期保护、焦点返回、离线接线、错误与空态分离、后台更新保留内容，以及项目创建和列表上下文保护。实际浏览器又定位并修复了默认空态图标被误调用、叠层确认关闭抢焦点和快速点击遮罩未关闭的问题。CopyButton 已实现 Promise 成功/失败反馈，业务接入与复制验收在 P1/P2 完成。

- Console 类型检查通过；既有 66 项单元通过。
- 本轮 Chrome 受控界面 38 项通过：基础 9、项目导航 5、v3 创建 14、v3 工作区 10；失败、跳过、flaky 均为 0。包含 390 px、减少动效、忙碌/未知请求、离线恢复、焦点、返回筛选与滚动。
- 首次运行因为本机缺少 Playwright bundled Chromium 未能启动，切换到已安装 Chrome 后执行；之后发现的 3 项交互失败均保留定位过程并修正，再完整跑出上述 38 项结果。
- 原始报告与源码摘要保存在 `.local/interaction-polish/evidence/p0-browser-results.json` 和 `p0-record.json`。这批结果不代替新改动后的回归，也不证明 SSH/K3s、真实部署或真实输入法已经验收。

## P1 实施结果（2026-10-30）

P1-01–P1-09 已在原有 v3 布局中实现。环境变量解析按请求代次隔离，慢速重新载入有反馈并保留新编辑；创建来源、配置、复核与返回各自定位焦点，关闭后新会话不复用旧草稿或已受理身份。服务工作面板关闭期间保留内容并停止交互，快速历史重开仍返回原触发位置。项目与服务聚合搜索、范围和返回上下文已保留，清空搜索后读取失败也不会卸载输入框。

构建日志会在初始终态与运行转终态时补齐尾页，仍保留原缓冲上限；容器日志区分真实握手、接收和结束，重连失败保留原缓冲，切目标或离开即取消。构建、部署、服务与操作日志增加当前已载入范围的搜索、复制、暂停跟随与回到最新。停止期望和实际观察分开，部署筛选通过 URL 保留并隔离服务。

- 最终同一批 Chrome 浏览器 **63 项全部通过**：P0 基础/导航 14、原 v3 创建/工作区 24、新创建配置 9、工作区细节 7、日志 9；无失败、跳过或 flaky。
- Console 类型、测试类型、ESLint、Prettier、生产构建通过；66 项 Console 单元通过。
- 日志首轮 4 项失败来自 Chrome Home 原生滚动未结束时提前取位，等待实际到达顶部后继续严格验证新输出和重连不移动历史位置。旧移动端测量在入场动画中读到 389.95 px，改为等待最终布局后仍精确断言 390 px。首轮结果保留，未降低功能断言。
- 报告及源码摘要：`.local/interaction-polish/evidence/p1-browser-results.json`、`p1-record.json`。P1 生产构建为 `.local/interaction-polish/p1-dist`，已更新本地 HTTPS 体验站并保留旧哈希资源，入口响应 200。
- 上述浏览器执行使用独立 Chrome context 与全量受控 API，证明界面行为；不代替真实发布、SSH/K3s、DNS/ACME 或数据库验收。原型同步结果与最终远端 CI 单独补记。

原型 P0/P1 同步保持 v3 原页面结构，补齐项目列表返回、创建等待与未知状态、首焦点、关闭新会话、复制结果与四类日志反馈。新增 10 组和原有 18 组已在独立 Chrome 顺序运行并全部通过。两份脚本均无页面脚本错误与外部请求；新增脚本另检查控制台错误，结果为 0。首次新增组定位到配置首焦点被头部关闭按钮抢走，已按明确优先级查找首字段并完整重跑。报告及运行文件摘要在 `.local/interaction-polish/evidence/p1-prototype-final/`；原型仅为内存演示，不代表真实 API 成功。

## P2 实施结果（2026-10-30）

P2-01–P2-07 已完成：凭证类型切换先确认，取消保留当前内容，确认后清空类型专属字段并重新隐藏，名称和到期时间保留。保存期间与列表刷新期间分别给出等待反馈，失败保留输入，同一键重试；保存和关闭后恢复对应入口，旧异步回调不抢其他视图焦点。服务器指纹、可信记录、预检、初始化以及集群/域名请求按实际动作显示等待，不把请求受理写成远端执行成功。

DNS A/AAAA/CNAME 和数据库 host/port/database/username 使用统一复制反馈，未知地址不提供假值，Redis 逻辑库 0 可正常复制，不返回密码或带密码连接串。服务器、集群、卷和数据库搜索保留到 URL，普通面包屑、历史返回和刷新均恢复原筛选；详情返回仅接受对应资源列表的非敏感查询。基础设施任务增加已载入日志的搜索、复制、暂停跟随，切任务后不残留旧输出或旧操作错误。

- 新增 P2 浏览器 22 项：凭证与接入操作 9、域名/数据库/任务 8、资源导航 5。初次用例修正了原生 select 操作的焦点准备和两个新增入口的定位，产品行为断言保留。
- 最终完整 Chrome 回归 **112 项全部通过**，包含前述 P0/P1、P2 和原有 S5/S6 27 项；无失败、跳过或 flaky。
- 69 项 Console 单元、Console/测试类型、仓库 ESLint、仓库 Prettier 和生产构建通过。新增测试引入的旧 S4 镜像样本补齐当前 DTO 必需字段，不改变 API 或旧断言。
- S5 的 66 个、S6 的 10 个响应式组合均无页面横向溢出；新增复制控件另覆盖长 DNS/数据库地址及复制失败后的 390/1024/1440 × 明暗主题共 12 组合。已查看当前桌面创建弹层和窄屏任务页面的截图。
- 当前报告：`.local/interaction-polish/evidence/final-browser-results.json`、`p2-record.json`、`s5-responsive/`、`s6-responsive/`。生产构建 `.local/interaction-polish/final-dist` 已更新到本地体验地址，旧哈希资产保留，入口响应 200。
- 这些用例以受控 API 证明界面行为；真实云端发布、SSH/K3s、DNS/ACME 与数据操作不由本轮结果证明。112 项完整回归结束后，另行完成下述 200% 实际页面缩放补验；本轮远端 CI 仍待推送和执行。

## 原生 200% Chrome 缩放补验（2026-10-30）

本项在本地 **112 项完整回归之后单独执行，1/1 通过**，无失败、跳过或 flaky。它不是一次性 113 项本地回归；新 CI 配置通过 `*-polish.spec.ts` 将此项与原有 112 项共同收集为 113 项，远端结果尚待执行。

[zoom-polish.spec.ts](../apps/console/tests/local-lab/zoom-polish.spec.ts) 仅使用一个新建临时 profile 的 Chrome context。本机浏览器为 Chrome `156.0.8078.48`，`viewport: null`，启动参数为 `--window-size=1440,1000 --force-device-scale-factor=1`。测试在临时 profile 的 `Default/Preferences` 中设置 Chrome 原生 `partition.default_zoom_level.x = log(2) / log(1.2)`；没有设置 CSS zoom、transform、较小的 Playwright viewport 或 pinch emulation。CI 分支使用 `channel: 'chromium'` 的完整 bundled Chromium，避免使用不具备同等 profile 行为的 headless shell；该 CI 分支尚待远端验证。

服务设置初始/保存后、创建来源/配置/复核共 5 个检查点，均实际测得：

| 指标                       | 实测值                       |
| -------------------------- | ---------------------------- |
| 原生窗口                   | 1440 × 1000 px，普通窗口状态 |
| `innerWidth × innerHeight` | 720 × 456 CSS px             |
| `devicePixelRatio`         | 2                            |
| `visualViewport.scale`     | 1                            |
| HTML / body 的 CSS `zoom`  | 1 / 1                        |
| 文档可视宽度 / 滚动宽度    | 720 / 720 px，无页面横向溢出 |

验证覆盖服务设置的长名称编辑、保存按钮、六个服务入口，以及创建来源 → 配置 → 复核 → 返回配置。方向键选来源、Tab/Shift+Tab 切字段、Escape 返回、Enter 保存和复核均通过，往返保留当前草稿。控件滚动后均位于页面可视范围内且可操作。全部 API 使用 fixture，仅保存受控草稿，没有触发真实部署；页面脚本错误和未声明 API 请求均为 0。

证据已归档到 `.local/interaction-polish/evidence/native-zoom/`，包括 [Playwright 报告](../.local/interaction-polish/evidence/native-zoom/browser-results.json)、测试目录中的 `native-zoom-evidence.json` 和唯一一张 `native-200-percent-creation.png`。截图采用不指定 clip 的 CDP `Page.captureScreenshot`，保留完整 1440 × 913 px 原生页面 surface，已目视检查；`innerHeight` 的整数值与原生奇数像素高度相差 1 px 属于缩放取整。Playwright 默认截图在这一窗口配置下的裁切问题已修正，保留的最终证据为完整截图。

测试类型、ESLint 与 Prettier 通过。测试结束已关闭独立 context 并删除自行创建的临时 profile，未读取或修改用户 Chrome profile、系统设置。专用 5199 测试实例随后停止，用户本地 HTTPS 体验服务保留。

可在已安装依赖和本机 Chrome 的仓库根目录复跑。先在独立终端启动唯一测试实例；`strictPort` 要求 5199 未被占用，API 代理指向关闭端口作为 fixture 之外的隔离边界：

```sh
OZZ_API_PROXY=http://127.0.0.1:1 pnpm --filter @ozz/console exec vite --host 127.0.0.1 --port 5199 --strictPort
```

再运行独立配置：

```sh
pnpm --filter @ozz/console exec playwright test --config tests/local-lab/zoom-polish.playwright.config.ts
```

新输出写入 `.local/interaction-polish-zoom/`，不会覆盖已归档的 112 项完整回归或原生缩放证据。独立配置不自动启动服务，完成后应停止该测试实例；单项复跑仍不能代替最终原型和远端 CI 验收。

## 完整原型最终复验（2026-10-30）

同一份最终运行源码在独立 Chrome 中顺序通过原有 **18/18** 组与新增 **16/16** 组。新增组涵盖 P0–P2 的等待、焦点、复制、日志、凭证、资源返回与任务状态；原有组继续验证全部原有入口、模板、创建与发布、域名解绑、服务删除保留卷等连续流程。原型仍使用内存演示，不接入实际后端。

最终复验修正了两处实际问题：Chrome 的 HTML `pattern` 使用 `v` 模式，三个字符类中的连字符改为合法等价表达；创建切步骤的延迟首焦点现在核对步骤归属，并保留用户在该帧前已经选择的字段，避免端口输入进入镜像字段。旧脚本对域名与保留卷的链接定位适配了新增返回参数，同时增加资源身份和返回上下文断言，原解绑和保留数据断言保留。

- `final-prototype/full-index-results.json`：18 组通过、页面脚本错误 0、HTTP 请求 0；该脚本没有独立记录控制台错误。
- `final-prototype/interaction-polish-results.json`：16 组通过、页面脚本错误/控制台错误/外部请求均为 0，含同一事件循环内快速选字段的焦点回归。
- 两份报告的五个运行文件 SHA256 与当前源码一致；总记录为 `.local/interaction-polish/evidence/local-final-record.json`，简要机器结果见 [console-interaction-polish-results.json](acceptance/console-interaction-polish-results.json)。
- `final-prototype-attempt-01` 保留 pattern 控制台错误；`attempt-02` 保留旧域名链接定位失败；`attempt-03` 保留焦点竞态和保留卷链接定位失败。最终结果由修复后的完整复验得出，未覆盖或修改失败报告。

在仓库根目录依次复跑，输出与历史记录分开：

```sh
OZZ_PROTO_OUTPUT_DIR=.local/interaction-polish-prototype-recheck node designs/console-v3/verification/interaction-polish-browser.mjs
OZZ_PROTO_OUTPUT_DIR=.local/interaction-polish-prototype-recheck pnpm test:prototype
```

两条命令默认读取本地 `index.html`，无需后端。macOS 使用安装的 Chrome；Linux 先安装 Playwright Chromium。本机完整 Console 回归使用 `pnpm --filter @ozz/console exec playwright test --config tests/local-lab/interaction-polish.playwright.config.ts`，先按缩放补验章节启动唯一 5199 测试实例；当前配置会收集 113 项，使用本机 Chrome。CI 使用 `pnpm test:console-fixtures`，要求已有生产构建与 Playwright Chromium，并自动独占启动 5199 preview；报告写入 `apps/console/tests/artifacts/fixtures-ci/`。用户当前体验服务与测试实例相互独立。
