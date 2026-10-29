# Ozz Console v3：完整功能覆盖与交互规划

盘点日期：2026-10-29。用途：按用户“直接按 Zeabur 的交互来，不要遗漏功能点”的要求，重做完整可操作原型，再更新真实 Console。本文件是规划与源码盘点，不是新原型、真实页面或平台能力的验收结果。

此前只覆盖创建主路径的简版已由共享数据的 [完整原型](index.html) 替换，服务器、设置、资源、维护和任务均有实际表单与状态联动。当前入口与能力边界见 [README](README.md)，v3 初版控件证据见 [历史完整浏览器报告](verification/full-index-results.json)，后续版本结果见文末精修衔接。旧简版 13 项记录不计为本轮通过，也不能用下文编号覆盖代替逐项交互验收。

## 1. 依据与覆盖口径

| 依据 | 用途与边界 |
| --- | --- |
| [PRODUCT](../../PRODUCT.md)、[PRD](../../docs/prd.md)、[DESIGN](../../DESIGN.md) | 归属模型、P0/P1/P2 功能范围与产品语言；不因精简导航删除需求 |
| [全量 UI 清单](../../docs/ui-coverage-inventory.md) | 78 个 P0/P1 场景、12 条连续流程及 F01–F50 的唯一编号 |
| [v2 覆盖矩阵](../console-v2/coverage-matrix.md)及其 reviewed 页面 | 复用完整字段、业务分支与演示状态；“已定位”只证明设计存在，不能证明真实平台已实现 |
| [Console 路由](../../apps/console/src/router.ts)、下文页面和组件 | 真实 Console 当前有哪些可达入口、字段、接口操作与保护；本次静态盘点不替代浏览器或真实 API 验收 |
| 本次在用户 Chrome 中实际体验的 Zeabur 页面 | 已确认完整创建页、项目服务工作区、六页签、添加来源与 Docker 配置面板；其他管理流程按 Ozz 能力实现，不声称逐项操作过 Zeabur |

后文使用三个状态：**保留**表示已有真实 Console 主入口，改版须保留其能力与边界；**补齐**表示现有部分能力，需补齐交互或完整产品设计；**规划**表示未发现当前 Console 的完整对应能力，原型须可操作并明确标注“规划演示”，真实产品接入另行实现。三者均不表示本轮实现或验收已经完成。

完整原型包含 P0 与 P1；不能把 P1 都塞进“敬请期待”或用几个说明卡片代替。尚未实现的流程用明确的本地演示状态串联，不能伪装成已接入 API。P2 在独立的未来概念入口保留，不占用日常项目主导航。用户已排除无障碍、旁白与 WCAG 专项验收；普通键盘、焦点、中文输入法、响应式、缩放和交互反馈继续保留。

## 2. Zeabur 参考与 Ozz 导航归并

### 已观察到的交互

root 已在用户 Chrome 中点击 Zeabur 的“创建项目”，进入 **完整的 /new 页面，不是创建项目弹窗**。页面先选择承载目标，目标有两类页签；项目名称可选，留空会使用默认名；底部提交创建，并有绑定外部服务器的分支。此观察只涉及查看和选择，未提交真实资源。

Ozz 对应采用完整创建页：选择部署位置 → 可选名称与更多设置 → 创建项目。API 仍要求合法名称和稳定标识时，由前端在提交前生成默认值，并在重试期间保持一致；不能直接向 API 发送空名称。目标列表最终按 Project.clusterId 对应的 Cluster 去重：一个多节点集群不能因多个 Server 被列为多个独立项目目标。未关联 Cluster 的 Server 进入接入流程；已登记但未验证的 Cluster 可以保存项目元数据，发布限制另行展示。

后续实际体验已补齐：进入项目直接打开服务；左侧替换为返回项目、项目资料/整合、新建服务和服务列表。服务顶部为服务状态、环境变量、用量、网络、硬盘、设置六页签；状态中集中运行、实例、Source / Server、域名、日志和部署记录。添加服务是约 640 px 的居中命令面板，背景服务页保留，方向键/Enter/Esc 操作；Docker 配置取消回到来源列表并保留输入，关闭面板回原服务。原型依此组织 Ozz 的 GitHub、Docker、应用模板和数据库，未复制当前不支持的匿名 Git / SSH 来源。

### 主入口与上下文

| 层级 | 可见入口 | 完整内容与返回路径 |
| --- | --- | --- |
| 全局主导航 | 项目、服务器、设置 | 保持三个稳定入口，进入项目后把主要空间交给服务；服务器页内部区分 Server 与 Cluster |
| 全局顶栏 | 活动/任务中心、搜索、账户 | 活动中心包含发布记录、资源操作、Git 事件，保留 Worker 状态与任务详情；账户提供主题和退出 |
| 项目列表的次级入口 | 所有资源 | 明确可点击进入跨项目服务、域名、数据库、持久卷；不只藏在命令搜索中 |
| 项目工作区 | 服务列表、新建服务、项目设置、整合 | 选择项目直接进入最近服务；资源入口提供当前项目的域名、数据库和卷，进入全局聚合页保留筛选上下文 |
| 项目顶部 | 返回项目、项目名、部署位置、必要时环境选择 | 单环境时隐藏日常环境选择器；多环境时显示并保留深链接；部署位置链接到真实 Cluster |
| 服务详情 | 服务状态、环境变量、用量、网络、硬盘、设置 | 部署与日志从服务状态直接打开；历史别名仍落到同服务。宽窄屏共享准确上下文 |
| 服务主操作 | 部署；状态中的重启；更多操作中的停止、恢复、删除 | 发布预览作为部署动作的一部分；运行操作保留各自语义、确认、任务结果与关联记录 |
| 服务设置 | 来源与构建、运行方式、端口/探针、资源、资料、危险操作 | Git 来源和运行配置不再占多个同级主菜单；关键配置可直接跳转到相应分组 |
| 设置内部 | 域名与入口、Git/Registry/Builder、凭证、外观、平台状态 | 保留真实集成表单、验证、到期与引用检查；平台恢复操作按真实 CLI 能力指引 |
| 产品规划 | P1 / P2 目录及相关详情的次级入口 | F26–F50 均有参数、校验、影响预览与独立演示结果；F43–F50 单独归为 P2 |

### Environment 的处理

Environment 用来区分同一项目下的 production、staging 等一组服务、配置、域名、卷和发布；它不是数据库分类。数据库是某个环境中的服务及其数据资源。

维持 Cluster → Project → Environment → Service：项目绑定一个 Cluster，环境与服务继承它。创建普通项目时自动建立 production，创建服务继承当前环境，不再要求用户反复选择。项目设置中保留环境创建、编辑和删除；多个环境时显示切换入口。无效、缺失或属于其他项目的环境必须解释并允许重新选择，不能静默改用 production。环境列表分页或查询失败不能误判成“只有一个环境”。

环境切换不复制数据、不移动服务、不改变 Cluster；同一命名空间规则也不能当作已验证的网络隔离。项目中的保留卷在源服务删除后仍可访问；有依赖的环境不可删除，production 不能单独删除。

## 3. 当前真实能力：必须保留的操作与状态

此表的 K 编号用于后续路由和场景映射；不是新增 PRD 编号。表中“现有”是源码入口盘点，所有重新组织后的操作仍须重新做交互验收。

| 编号 / 新归属 | 必须保留的功能 | 关键状态、编辑与结果 | 主要源码依据 |
| --- | --- | --- | --- |
| K01 登录与公共壳层 | 管理员登录、密码显隐、会话到期返回原页面、退出；命令导航、移动导航、主题、统一反馈 | 输入错误/限流/离线；登录后原资源已删除；未保存离开；IME 不误提交；加载/空/刷新失败/403/404；主题不丢表单 | [LoginPage](../../apps/console/src/pages/LoginPage.vue)、[AppShell](../../apps/console/src/components/AppShell.vue)、[QueryState](../../apps/console/src/components/QueryState.vue)、[路由守卫](../../apps/console/src/router.ts) |
| K02 项目列表与创建 | 搜索、分页、真实空态、目标状态；选择固定 Cluster，名称/标识/描述，创建后添加首服务；无目标接入返回 | 筛选无结果与零项目分开；中文名称；名称/标识冲突、目标已移除、受理中、结果未知；重试不重复创建；未验证目标不冒充可部署 | [ProjectsPage](../../apps/console/src/pages/ProjectsPage.vue)、[ProjectCreatePage](../../apps/console/src/pages/ProjectCreatePage.vue) |
| K03 项目与环境设置 | 项目资料保存/重新载入/受限删除；环境新增、编辑、删除、切换、归属与分页 | revision 冲突、脏表单、production 保护、同名冲突、服务/保留卷依赖；错误环境不兜底；普通编辑不能换目标 | [ProjectPage](../../apps/console/src/pages/ProjectPage.vue) |
| K04 添加服务 | 镜像、GitHub、内置模板三种来源；继承项目与环境；必要字段在主路径，低频字段渐进展开 | 返回保留草稿；只读/能力限制；校验定位到折叠项；配置保存、服务创建、任务受理、实际部署分别呈现；失败后复用已创建服务 | [ServiceCreatePage](../../apps/console/src/pages/ServiceCreatePage.vue)、[ImageServiceCreatePage](../../apps/console/src/pages/ImageServiceCreatePage.vue)、[GitServiceCreatePage](../../apps/console/src/pages/GitServiceCreatePage.vue)、[ServiceCreationFrame](../../apps/console/src/components/services/ServiceCreationFrame.vue) |
| K05 运行配置 | 镜像与拉取凭证；Web/后台/数据库类型；启动命令/参数数组；具名端口/内部端口/暴露意图；副本、requests/limits；HTTP/TCP readiness/startup | 校验格式、重复端口、路径/时间/阈值、request 大于 limit；数据库身份/单实例保护；草稿与已发布不同；取消和加载最新不静默覆盖编辑 | [ServiceConfigurationEditor](../../apps/console/src/components/services/ServiceConfigurationEditor.vue)、[ServicePage](../../apps/console/src/pages/ServicePage.vue) |
| K06 变量 | 普通值、新秘密值、已有凭证引用/键；逐项增删改；.env 批量解析、预览和应用 | 无变量、重复键、行错误、数量上限；导入内容有离开保护；取消/类型切换清空秘密；保存后待发布，秘密不回显原文 | [ServiceVariablesEditor](../../apps/console/src/components/services/ServiceVariablesEditor.vue) |
| K07 Git 与构建 | GitHub 授权、仓库/分支、Dockerfile/上下文、Builder、Registry、镜像名、架构、构建参数/秘密；来源维护；自动发布策略与待发布提交 | 未授权/不可见/分支缺失、未配置或失效连接；来源修改使发布预览失效；停止服务收到提交只进入待发布；不因保存来源开始构建 | [GitSourceEditor](../../apps/console/src/components/git/GitSourceEditor.vue)、[ServiceGitSource](../../apps/console/src/components/git/ServiceGitSource.vue)、[ServicePendingCommits](../../apps/console/src/components/git/ServicePendingCommits.vue) |
| K08 发布复核与执行 | 草稿差异、完整发布快照、固定 commit/digest/配置/存储快照；确认后创建独立部署任务 | 预览过期/revision 变化、活动任务、依赖/目标/权限阻断、未知受理；停止时明确启动；部分应用需明确修复；不能把旧 Pod 健康当成本次成功 | [ConfigurationReview](../../apps/console/src/components/services/ConfigurationReview.vue)、[ServiceStorageReview](../../apps/console/src/components/storage/ServiceStorageReview.vue) |
| K09 服务运行操作 | 重启、停止、恢复原已发布版本；删除预览、消费者/卷审查、名称确认与异步删除 | 恢复不采用草稿、不消费待发布提交、不重新构建；未发布/不可信/部分应用阻止；停止保留数据；删除保留卷；取消待确认、清理失败/未知有原任务入口 | [ServicePage](../../apps/console/src/pages/ServicePage.vue)、[ServiceDeletionReview](../../apps/console/src/components/storage/ServiceDeletionReview.vue) |
| K10 运行观察 | 实例/容器、Ready、重启、imageID、节点、资源请求/上限、即时 CPU/内存、最近事件 | 期望、已发布、实际观察分开；OOM/拉取/探针失败；实例消失、无实例、陈旧/失联/漂移/未知；指标缺失不变成零，无历史趋势假图 | [ServiceRuntimePanel](../../apps/console/src/components/services/ServiceRuntimePanel.vue)、[DeploymentFailureObservation](../../apps/console/src/components/services/DeploymentFailureObservation.vue) |
| K11 运行日志 | 选择实例/容器/previous；尾部 100/200/500/1000 行；读取、持续跟随、停止；换行、搜索与复制有界缓冲 | 上滚暂停自动滚动、新输出计数、回到底部；Pod 已删除/服务停止/权限/断线/截断；明确当前来源、时间和缓冲范围；不冒充历史集中检索或下载 | [ServiceLogViewer](../../apps/console/src/components/services/ServiceLogViewer.vue)、[VirtualServiceLog](../../apps/console/src/components/services/VirtualServiceLog.vue) |
| K12 发布与 Git 事件记录 | 项目/环境/服务/状态筛选、分页；详情时间线、构建/推送/部署输出、目标实例与快照；Git 事件收件、拒绝和逐服务投递详情 | 镜像发布无构建阶段；失败与取消终态保留；重试生成新记录；已过期日志有说明；事件拒绝/忽略不伪造部署；跳转不丢服务与任务身份 | [DeploymentsPage](../../apps/console/src/pages/DeploymentsPage.vue)、[DeploymentPage](../../apps/console/src/pages/DeploymentPage.vue)、[WebhookDeliveryPage](../../apps/console/src/pages/WebhookDeliveryPage.vue)、[DeploymentCollection](../../apps/console/src/components/services/DeploymentCollection.vue) |
| K13 五个内置模板 | Docker、Node.js 示例、静态网站示例、PostgreSQL、Redis；模板详情、固定版本/镜像、参数、资源/卷/凭证计划预览 | 参数变化使预览失效；版本/容量/架构/凭证等问题可定位；数据库初始化/AOF 与单实例保护；模板创建不等于运行成功 | [TemplateGallery](../../apps/console/src/components/storage/TemplateGallery.vue)、[TemplateCreatePage](../../apps/console/src/pages/TemplateCreatePage.vue)、[模板 ID 契约](../../apps/api/src/modules/templates/template.dto.ts) |
| K14 域名与网络 | 已发布 HTTP 端口的默认域名分配；全局/集群后缀、入口 IP/CNAME、ACME 邮箱；cert-manager 检查/安装；DNS/路由/TLS 诊断；重查、重新应用、production 证书申请；解绑审查与清理 | 无发布端口/缺入口/能力不足；DNS、路由、证书分别观察且保留时间；staging 验证后申请 production；解绑需完整域名确认，手工 DNS/共享资源保留；失败任务可追踪 | [ServiceNetworkPanel](../../apps/console/src/components/networking/ServiceNetworkPanel.vue)、[DomainActions](../../apps/console/src/components/networking/DomainActions.vue)、[DomainObservations](../../apps/console/src/components/networking/DomainObservations.vue)、[ClusterEntryEditor](../../apps/console/src/components/networking/ClusterEntryEditor.vue) |
| K15 持久卷生命周期 | 卷聚合/创建/详情；项目环境、StorageClass、申请容量；实际 PVC/PV/节点/回收策略；同环境挂载/卸载草稿、路径/只读、单写入；独立销毁预览 | 期望/已发布/在途/实际引用分别展示；保存挂载待发布；挂载/保护/维护状态阻止销毁；名称确认、失败重试；服务删除后仍可找到保留卷 | [VolumesPage](../../apps/console/src/pages/VolumesPage.vue)、[VolumePage](../../apps/console/src/pages/VolumePage.vue)、[ServiceVolumeMounts](../../apps/console/src/components/storage/ServiceVolumeMounts.vue)、[VolumeReferences](../../apps/console/src/components/storage/VolumeReferences.vue) |
| K16 数据库与连接 | PostgreSQL/Redis 数据身份、版本、认证/AOF 与私有连接；同环境应用选择数据库、变量映射、变更预览、保存/移除连接草稿；消费者追踪 | 凭证仅显示引用；草稿/已发布/在途消费者区分；保存不即时注入；跨环境或不可信身份阻止；源服务删除后身份仍随保留数据存在 | [DatabasePage](../../apps/console/src/pages/DatabasePage.vue)、[DatabaseIdentity](../../apps/console/src/components/storage/DatabaseIdentity.vue)、[ServiceDatabaseBindings](../../apps/console/src/components/storage/ServiceDatabaseBindings.vue) |
| K17 手工备份与恢复 | PostgreSQL pg_dump、Redis RDB→AOF、文件卷归档指引；进入备份/新目标恢复维护；退出核验；登记备份/恢复证据与历史 | 维护任务/互斥/阻断；超时仍锁定，退出核验 helper 和实际挂载；记录包含备份 ID、源/目标、版本、大小、SHA256、执行/数据时间、离机位置、完整性、结果与证据；恢复选择已登记备份和不同源卷的新目标 | [ManualDataGuide](../../apps/console/src/components/storage/ManualDataGuide.vue)、[VolumeMaintenancePanel](../../apps/console/src/components/storage/VolumeMaintenancePanel.vue)、[ManualDataRecordForm](../../apps/console/src/components/storage/ManualDataRecordForm.vue)、[ManualDataRecords](../../apps/console/src/components/storage/ManualDataRecords.vue) |
| K18 服务器 | Server 列表/登记/编辑/受限移除；地址、SSH 用户/端口/凭证、地区/标签；发现/确认指纹；只读预检与报告；固定 K3s 初始化 | 未预检、连接/权限/指纹错误；OS/架构/资源/磁盘/端口；已有安装不覆盖；安装独立确认、任务、取消/重试/部分失败；移除登记不卸载远端软件 | [InfrastructurePage](../../apps/console/src/pages/InfrastructurePage.vue)、[ServerPage](../../apps/console/src/pages/ServerPage.vue)、[ServerOnboarding](../../apps/console/src/components/infrastructure/ServerOnboarding.vue)、[SshPreflightReport](../../apps/console/src/components/infrastructure/SshPreflightReport.vue) |
| K19 集群与节点 | Cluster 列表/登记/编辑/受限移除；kubeconfig 解析、连接预览、导入与同身份更新；RBAC/入口/存储/指标能力；节点、关联 Server/项目与观察 | 危险 kubeconfig 拒绝；不能将项目重定向另一集群；Node UID 和 Cluster 归属；陈旧/失联/未知保留；关联项目/任务/数据阻止移除；目前不提供节点 join/drain 等维护入口 | [ClusterPage](../../apps/console/src/pages/ClusterPage.vue)、[ClusterConnection](../../apps/console/src/components/infrastructure/ClusterConnection.vue)、[ClusterObservationReport](../../apps/console/src/components/infrastructure/ClusterObservationReport.vue)、[NodeInventory](../../apps/console/src/components/infrastructure/NodeInventory.vue) |
| K20 凭证与集成 | SSH、kubeconfig、Git、Registry、数据库、generic、Webhook secret、Builder mTLS 凭证新建/元数据/到期/受限删除；GitHub/Registry/Builder 新增、编辑、验证和分页；仓库/分支、Webhook 注册/更新；推送与拉取身份；Builder 身份、mTLS、停用 | 类型切换有输入先确认，取消保留，确认或关闭后清空秘密；不能读回原文；替换通过新凭证与更新引用完成；无连接删除界面不假装可删；未配置/权限/到期/验证任务结果明确 | [SettingsPage](../../apps/console/src/pages/SettingsPage.vue)、[IntegrationConnections](../../apps/console/src/components/git/IntegrationConnections.vue)、[GitHubRepositories](../../apps/console/src/components/git/GitHubRepositories.vue)、[GitBuildIntegrations](../../apps/console/src/components/git/GitBuildIntegrations.vue) |
| K21 操作任务与平台状态 | 独立 Operation 列表/详情/筛选/状态/执行日志/结果/固定目标/取消/重试；控制面诊断；基础设施、服务、网络、卷与集成任务统一回链；Worker 健康与队列；恢复只读反馈 | ready/degraded/offline/paused、心跳和待投递；任务受理不等于完成；重试保留原历史；取消待确认不提前结束；恢复锁与资源状态分开，Web 不提供不存在的一键解锁 | [OperationsPage](../../apps/console/src/pages/OperationsPage.vue)、[OperationPage](../../apps/console/src/pages/OperationPage.vue)、[WorkerHealth](../../apps/console/src/components/WorkerHealth.vue)、[AppShell](../../apps/console/src/components/AppShell.vue) |

完整原型已校准三个边界：当前模板仅 docker、node-example、static-example、postgresql、redis，统一模板版本 1.0.0；镜像版本、digest、端口、资源与默认卷来自真实 catalog 和 pinned assets，不提供虚构 MySQL 或任意数据库版本；Node/静态网站是预构建示例，不等于自动源码构建；手工备份/恢复记录只保存证据，不执行导出、导入、数据校验或生产流量切换。

## 4. 28 个真实页面的路由闭合

当前有 28 个页面文件：26 个不同页面由 router 直接加载，Image/GitCreate 是 ServiceCreate 内部分支；Server 与 Cluster 页面各复用新建、详情两个路由。下表逐页保留入口；路由可用于直接打开、刷新和浏览器后退，不能仅有画布点击时的临时状态。

| 页面文件 | 当前路由 / 分支 | v3 明确入口与归属 |
| --- | --- | --- |
| LoginPage.vue | /login | K01，登录和会话到期返回 |
| ProjectsPage.vue | /projects | K02，全局项目；次级所有资源入口 |
| ProjectCreatePage.vue | /projects/new | K02，完整创建页；接入返回继续填写 |
| ProjectPage.vue | /projects/:projectId | K03，服务工作区、资源、设置/环境；保留 environment 与 tab |
| ServiceCreatePage.vue | /projects/:projectId/services/new | K04，工作区添加服务；来源选择与返回 |
| ImageServiceCreatePage.vue | ServiceCreate 的镜像分支 | K04/K05，来源 → 配置 → 发布复核；不成为孤立页面 |
| GitServiceCreatePage.vue | ServiceCreate 的 Git 分支 | K04/K07，授权/仓库/构建 → 配置 → 发布复核 |
| ServicePage.vue | /projects/:projectId/services/:serviceId | K05–K12/K14–K16，项目服务面板与可直接访问的详情页 |
| ServicesPage.vue | /services | 所有资源 → 服务；跨项目列表和明确筛选，不只靠搜索 |
| TemplatesPage.vue | /templates | 添加服务 → 模板；也可从所有资源/数据库空态进入 |
| TemplateCreatePage.vue | /templates/:templateId | K13，目录 → 参数/计划 → 创建；携带有效目标与返回上下文 |
| VolumesPage.vue | /volumes | 项目资源/所有资源 → 持久卷；保留卷永远有独立入口 |
| VolumeCreatePage.vue | /volumes/new | K15，卷列表或服务数据 → 创建 → 返回原上下文 |
| VolumePage.vue | /volumes/:volumeId | K15/K17，概览/挂载/手工维护记录；数据库与服务反向链接 |
| DatabasesPage.vue | /databases | 项目资源/所有资源 → 数据库；无服务的保留数据身份仍可见 |
| DatabasePage.vue | /databases/:databaseId | K16，数据库身份/消费者/来源服务/卷/手工维护 |
| DomainsPage.vue | /domains | 项目资源/所有资源 → 域名；保留 projectId/environmentId/clusterId/serviceId 筛选 |
| DomainPage.vue | /domains/:domainId | K14，服务网络/域名列表 → 诊断、重新应用、解绑和任务 |
| DeploymentsPage.vue | /deployments | K12，顶栏活动；发布记录/资源操作/Git 事件可互达 |
| DeploymentPage.vue | /deployments/:deploymentId | K08/K12，服务部署或活动 → 时间线、快照、日志与重试/取消 |
| WebhookDeliveryPage.vue | /webhook-deliveries/:deliveryId | K12，Git 事件 → 逐服务投递与实际部署关联 |
| InfrastructurePage.vue | /infrastructure | K18/K19，全局服务器；Server/Cluster 两类资源与新增入口 |
| ServerPage.vue | /servers/new；/servers/:serverId | K18，登记、编辑、指纹、预检、初始化、关联与移除 |
| ClusterPage.vue | /clusters/new；/clusters/:clusterId | K19，登记/导入/连接/编辑、节点/项目/入口设置、移除 |
| SettingsPage.vue | /settings | K14/K20，域名入口、Git 与构建、外观与凭证 |
| OperationsPage.vue | /operations | K21，顶栏活动的资源操作；各对象带上下文进入 |
| OperationPage.vue | /operations/:operationId | K21，各资源提交结果与列表 → 原任务详情 → 对象 |
| NotFoundPage.vue | /:pathMatch(.*)* | K01，无效链接解释与返回；不能展示默认项目假数据 |

服务旧页签 overview、source、configuration、review、deployments、logs、network、storage 均要映射到新详情的明确位置；旧链接打开后直接落到对应分组。发布预览即使改为面板，也保留可追踪的状态和返回编辑入口。模板、创建卷、登记目标、任务页返回时都保留来源项目与环境；跨项目“所有资源”不附加虚构的 production。

## 5. 78 个 P0/P1 场景逐项映射

每行继承 [v2 唯一场景行](../console-v2/coverage-matrix.md)中的完整异常、确认与数据边界；本表补充 v3 归属和真实能力差异，不把旧场景删减成只有成功状态。优先级保持原清单，尤其“规划”不表示可从完整原型中省略。

| 场景 | 优先级 | 状态 / v3 落点 | 必须覆盖或补齐的内容 |
| --- | --- | --- | --- |
| UI01.01 管理员登录 | P0 | 保留 · K01 | 登录中、错误/限流/离线、密码显隐、返回原路径 |
| UI01.02 首次初始化说明 | P0 | 补齐 · K01/K21 | 当前无独立初始化页面；原型提供 CLI/安装指引、主密钥缺失/状态未知，不新增公开注册 |
| UI01.03 会话过期与重新登录 | P0 | 保留 · K01 | returnTo、会话撤销/原对象已删除；不重放写操作或持久存储秘密草稿 |
| UI01.04 首次使用引导 | P0 | 补齐 · K02/K18/K19 | 零项目/零目标/目标未验证分别引导，串联接入后返回创建 |
| UI01.05 退出当前会话 | P0 | 保留 · K01 | 账户菜单退出、未保存确认、失败/结果未知、已失效；迟到响应不能恢复敏感上下文 |
| UI02.01 项目列表 | P0 | 保留 · K02 | 真空态、搜索无结果、分页、目标失联/观察时间；若增加概况不能从未知状态编造统计 |
| UI02.02 选择服务器/集群 | P0 | 保留 · K02/K19 | 创建完整页首先选择；Cluster 去重、未验证仍可登记元数据、能力不齐可解释 |
| UI02.03 无目标的接入分支 | P0 | 保留 · K18/K19 | 未关联 Server、登记/预检/安装/导入、取消/失败、返回原项目草稿 |
| UI02.04 项目信息与确认 | P0 | 保留 · K02 | 可选名称与自动标识、更多设置；固定目标、重复/冲突/超时原请求确认；名称默认是本次交互调整 |
| UI02.05 创建后的项目空态 | P0 | 保留 · K02/K04 | 新项目与 production 已建立，打开添加服务且可返回空态；不宣称应用已上线 |
| UI03.01 项目服务总览 | P0 | 补齐 · K03/K10/K16 | 现有服务列表保留；关系图只来自真实数据库连接/依赖，混合状态与需处理事项可跳转 |
| UI03.02 环境管理 | P0 | 保留 · K03 | 单环境隐藏日常选择；多环境切换/CRUD、production 保护、依赖删除阻止、分页/错误与未保存保护 |
| UI03.03 项目设置与删除 | P0 | 保留 · K03 | 资料修改/载入最新/revision 冲突、固定 Cluster、空项目删除与依赖阻止 |
| UI03.04 环境差异与配置复制 | P1 | 规划 · 项目设置/环境 | 环境 CRUD 已有；差异、选项复制、目标引用重绑与实际网络隔离报告未实现 |
| UI03.05 项目导出 | P1 | 规划 · 项目设置 | schema、范围、非敏感配置/凭证占位、导出错误/下载或复制结果；不包含数据 |
| UI03.06 项目复制/导入新项目 | P1 | 规划 · 项目设置 → 新建 | 先选新 Cluster、映射身份/凭证/依赖、独立卷/域名、部分失败和定向重试 |
| UI03.07 导入现有项目 | P1 | 规划 · 项目设置 | 继承目标、解析/schema/优先级、revision 冲突、引用缺失、保存待发布，不后台覆盖 |
| UI04.01 添加服务入口 | P0 | 保留 · K04 | 三来源、项目/环境继承、返回保留输入、只读/权限/未验证目标 |
| UI04.02 镜像服务配置 | P0 | 保留 · K04/K05 | 公共/私有镜像、凭证、端口、digest/架构/拉取错误；生成服务后失败不可重复创建 |
| UI04.03 GitHub 服务接入 | P0 | 保留 · K04/K07/K20 | 授权/仓库/分支/Dockerfile/Builder/Registry、固定 commit；保存来源不构建 |
| UI04.04 基础模板目录与参数 | P0 | 保留 · K13 | 五模板完整目录和参数/计划/版本/容量/架构；移除错误的 MySQL 现有能力标记 |
| UI04.05 模板仓库、版本与组合模板 | P1 | 规划 · 添加服务/模板 | 固定版本、三组件依赖、schema/环/缺引用、逐组件失败/重试与集合联动 |
| UI04.06 Monorepo 与自动构建计划 | P1 | 补齐 · K07/服务设置 | Dockerfile 和 context 已有；watch paths/共享路径触发、自动识别/无 Dockerfile 构建未实现 |
| UI05.01 配置总览与草稿 | P0 | 保留 · K05/K08 | 未保存、已保存未发布、无发布基线、完整快照、部分应用/冲突，丢弃确实恢复对应基线 |
| UI05.02 类型、启动、端口和资源 | P0 | 保留 · K05 | 所有运行字段保留，可折叠；参数数组、重复端口/request-limit/数据库保护错误可定位 |
| UI05.03 健康检查 | P0 | 保留 · K05/K08/K10 | readiness/startup、HTTP/TCP、未配置/无效/等待目标版本/失败；不借用旧实例健康 |
| UI05.04 环境变量与批量录入 | P0 | 保留 · K06 | 逐项/引用/.env 解析预览、重复/数量/行错误、秘密保护、保存后待发布 |
| UI05.05 卷挂载配置 | P0 | 保留 · K15 | 同环境选卷/新卷、绝对路径/只读/单写入、草稿与实际挂载、销毁阻断 |
| UI05.06 变量引用与依赖 | P1 | 补齐 · K06/K16/变量 | 当前数据库连接注入与消费者已有；通用服务输出、构建期依赖、引用环/传播还需完整设计与实现 |
| UI05.07 配置文件 | P1 | 规划 · 服务设置/配置文件 | 文本/秘密引用、路径/卷冲突/权限、差异与并发修改，保存后待发布 |
| UI05.08 Git/构建设置维护 | P0/P1 | 补齐 · K07 | 保留来源/策略/待发布提交；补齐自动构建/Monorepo P1 分支，不误标为已支持 |
| UI06.01 发布预览与创建任务 | P0 | 保留 · K08 | 主操作内复核固定输入；修改后失效、启动/修复意图、任务受理/未知、完成回到当前服务 |
| UI06.02 部署历史与操作列表 | P0 | 保留 · K12/K21 | Deployment/Operation/Git 事件分开，筛选/分页/空结果、历史结果不替代当前观察 |
| UI06.03 部署详情与阶段时间线 | P0 | 保留 · K12 | 排队/构建/推送/应用/等健康、日志/实例/快照、部分失败、镜像无构建 |
| UI06.04 失败、重试与取消 | P0 | 保留 · K12/K21 | 重试新记录、固定输入/产物/凭证问题、原失败保留；取消请求与确认终止分开 |
| UI06.05 重启、停止与恢复 | P0 | 保留 · K09 | 已发布快照恢复、草稿/新 commit 保留、离线/不可信/部分应用阻止或待执行 |
| UI06.06 Git 推送与待发布版本 | P0 | 补齐 · K07/K12 | 保留签名拒绝、非跟踪/重复、停止待发布；路径跳过/共享目录规则随 F29 标明规划 |
| UI06.07 漂移、删除与清理结果 | P0 | 保留 · K09/K10/K21 | 期望/实际/未知/较新资源；删除依赖/保留卷、清理部分失败与原任务查询 |
| UI06.08 历史镜像回滚 | P1 | 规划 · 服务部署/历史操作 | 失败重试和恢复原版本已有，历史 digest 回滚未实现；保留可信配置、数据保护、停止启动意图 |
| UI07.01 实例与当前资源 | P0 | 保留 · K10/K19 | 实例/容器/节点/版本/指标/事件，OOM/拉取失败/已删除/陈旧/缺指标 |
| UI07.02 运行日志 | P0 | 保留 · K11 | 实例、容器、previous、尾部、跟随、暂停、回底、复制、换行及限额/断线 |
| UI07.03 构建与部署日志 | P0 | 保留 · K12 | 绑定服务/部署/阶段的输出，镜像发布不适用、日志过期、分页/加载失败 |
| UI07.04 日志检索与下载 | P1 | 规划 · 服务日志/历史 | 当前有界日志不等于集中检索；时间/服务过滤、分页、下载、留存/外部能力缺失 |
| UI07.05 容器命令与交互终端 | P1 | 规划 · 服务日志/终端 | 明确 Pod/container、连接/权限/断线/超时/已删除、会话结束；不能冒充主机 SSH |
| UI08.01 基础设施列表 | P0 | 保留 · K18/K19 | Server 与 Cluster 分开、搜索/分页/空态/未验证/陈旧；目标去重 |
| UI08.02 服务器登记/编辑 | P0 | 保留 · K18/K20 | SSH/地区/标签/凭证、指纹、保存/冲突/引用、接入返回 |
| UI08.03 只读预检报告 | P0 | 保留 · K18 | OS/架构/CPU/内存/磁盘/端口、连接/权限/指纹、超时与原任务 |
| UI08.04 K3s 初始化任务 | P0 | 保留 · K18/K21 | 固定版本、独立确认、已有安装阻止、排队/部分失败/取消/重试 |
| UI08.05 已有集群导入 | P0 | 保留 · K19/K20 | kubeconfig 解析/危险配置拒绝、地址/身份/权限/能力、连接预览和失败回到原输入 |
| UI08.06 集群/节点/工作负载详情 | P0 | 补齐 · K19/K10 | 节点与项目已有，工作负载在服务观察；新原型补齐相互导航，未知目标不借用其他集群观察 |
| UI08.07 移除登记 | P0 | 保留 · K18/K19 | 引用/关联项目/任务/卷阻止、确认和失败；只移除登记，不卸载或销毁数据 |
| UI08.08 节点维护 | P1 | 规划 · 集群/节点 | join/cordon/drain/uncordon/移除/重接、PDB/本地卷影响、部分结果/取消/独立重试 |
| UI08.09 集群登记/编辑 | P0 | 保留 · K19 | CRUD、只读身份、同集群地址/凭证更新、冲突、关联/能力/连接状态 |
| UI09.01 服务网络总览 | P0 | 保留 · K14/K16 | 已发布端口/默认域名/私有地址、无端口、跨环境连接限制与观察时间 |
| UI09.02 默认域名分配与诊断 | P0 | 保留 · K14 | 后缀/入口/证书组件、分配、DNS/路由/TLS 分别检查、重查/重应用/证书申请 |
| UI09.03 自定义域名与 Cloudflare | P1 | 规划 · 服务网络/设置 | 自定义/多个域名、所有权/DNS 建议、Cloudflare 凭证与记录冲突/验证均未完整实现 |
| UI09.04 公网 TCP | P1 | 规划 · 服务网络 | 私有 TCP 已有；公网端点/端口冲突/防火墙/清理与结果另行设计，不默认暴露数据库 |
| UI09.05 解绑与清理 | P1 | 保留 · K14/K21 | 当前已有解绑审查/域名确认/异步清理；保留手工 DNS 和共享资源、未知/失败查询 |
| UI10.01 项目数据总览 | P0 | 补齐 · K15/K16 | 当前聚合列表已有；项目资源页联动卷/数据库/保留身份/位置/观察，不靠仍存在的源服务进入 |
| UI10.02 创建/挂载卷 | P0 | 保留 · K15 | 创建参数/范围、挂载路径/只读/单写入；新卷和挂载草稿区分，发布后观察 |
| UI10.03 卷详情与销毁 | P0 | 保留 · K15/K21 | PVC/PV/节点/策略/引用、维护/挂载/保护阻断、独立确认、任务与失败重试 |
| UI10.04 数据库详情与应用连接 | P0 | 保留 · K16 | PostgreSQL/Redis 身份/认证/AOF/私有连接、同环境映射、消费者/发布快照/数据保护 |
| UI10.05 手工备份/恢复指引与记录 | P0 | 保留 · K17 | 三种数据指引、维护锁、登记证据、源与新目标/校验和/时间；记录不执行数据操作 |
| UI10.06 备份中心与计划 | P1 | 规划 · 项目资源/备份 | 手工记录已有；自动计划/对象存储/下载/保留/失败/时间点说明未实现 |
| UI10.07 恢复到新目标 | P1 | 补齐 · K17/备份 | 手工新目标维护与记录已有；平台自动恢复/验证/切流向导仍为规划，排队不允许宣称数据通过 |
| UI11.01 项目需处理事项 | P0 | 补齐 · K03/K10/K12/K21 | 当前服务/任务/网络异常分别存在；工作区汇总并跳到同源详情，避免编造统一告警系统 |
| UI11.02 历史资源 | P1 | 规划 · 服务概览/资源历史 | 即时 CPU/内存已有；历史时间序列/采样/缺口/留存/Prometheus 能力未实现 |
| UI11.03 告警规则 | P1 | 规划 · 项目活动/设置 | 阈值/持续/冷却/恢复/范围、禁用、验证、目标失败；不能用运行状态卡代替规则 |
| UI11.04 事件、告警与投递详情 | P1 | 补齐 · K10/K12/K21/活动 | 当前运行事件、任务和 Git 投递已有；告警生命周期、合并与通知投递另行补齐 |
| UI11.05 观测能力与保留说明 | P1 | 补齐 · K10/K11/设置 | 当前时间来源/日志缓冲有说明；历史采样/留存/外部集成容量和缺口需规划 |
| UI12.01 平台与偏好设置 | P0 | 保留 · K01/K14 | Light/Dark/System、平台后缀/入口、当前状态，主题变化不清空输入 |
| UI12.02 凭证中心 | P0 | 保留 · K20 | 各凭证种类、元数据/到期/新增/替换引用/受限删除；不读回原秘密或虚构原地改密功能 |
| UI12.03 GitHub、Registry 与 Builder | P0 | 保留 · K20 | 三连接新增/编辑/验证、仓库/分支/Webhook、Registry 推送拉取、Builder 身份/mTLS/停用 |
| UI12.04 DNS、对象存储与观测集成 | P1 | 补齐 · K14/设置 | 当前默认 DNS 指引和入口已有；Cloudflare API、对象存储、Prometheus/Loki 连接表单是规划 |
| UI12.05 通知目标 | P1 | 规划 · 设置/通知 | HTTP Webhook 目标、凭证引用、测试/失败/重试/结果；与 Git 收件 Webhook 分开 |
| UI12.06 API Token | P1 | 规划 · 设置/自动化 | 创建后只显示一次、到期/撤销、上下文与权限；当前无用户 Token 管理页 |
| UI12.07 CLI 与公开契约指引 | P1/P0 | 补齐 · 设置/自动化 | OpenAPI 和初始化/恢复运维 CLI 已有；完整用户 CLI/Token 未实现，示例必须明确项目环境 |
| UI12.08 平台状态、恢复与操作追踪 | P0 | 补齐 · K21 | Worker/诊断/只读横幅已有；恢复核验与解除锁按 CLI 引导，不能加入无 API 的 Web 解锁按钮 |

## 6. 功能编号不遗漏

### P0 F01–F25 的当前界面落点

这些落点不代表 F 项下的所有真实基础设施验收已经通过；现有证据范围仍以各阶段 acceptance 文档为准。

| 需求 | 当前界面落点 |
| --- | --- |
| F01 身份与会话 | K01；初始化说明按 UI01.02 补齐 |
| F02 凭证保护 | K06/K18/K19/K20；版本/替换以真实凭证引用方式呈现 |
| F03 项目 | K02/K03，固定目标与受限删除 |
| F04 基础环境 | K03/K04/K15/K16，环境归属保持 |
| F05 Server | K18，登记/预检/指纹/受限移除 |
| F06 K3s 与已有集群接入 | K18/K19/K21 |
| F07 Cluster 与 Node | K19/K10，项目与工作负载回链 |
| F08 服务配置 | K04/K05/K08 |
| F09 发布与 Operation | K08/K12/K21 |
| F10 OCI 镜像 | K04/K05/K08/K12 |
| F11 探针与目标健康 | K05/K08/K10 |
| F12 服务操作 | K09/K21 |
| F13 变量 | K06 |
| F14 默认域名与 HTTPS | K14 |
| F15 私有连接 | K05/K14/K16 |
| F16 日志 | K11/K12 |
| F17 当前资源与诊断 | K10/K18/K19/K21 |
| F18 持久卷 | K15/K17 |
| F19 PostgreSQL/Redis | K13/K16/K17 |
| F20 基础模板 | K13 |
| F21 GitHub 构建与发布 | K07/K12/K20 |
| F22 手工备份与恢复 | K17/K21；维护和记录不冒充自动执行 |
| F23 工程与公开契约 | K01/K21、现有 OpenAPI/运维指引；不是新增一个全局开发者菜单 |
| F24 Console 体验 | 所有 K 项；保留本轮范围内的主题、键盘/IME、响应式和反馈 |
| F25 对账与清理 | K09/K10/K19/K21；未知/较新资源与恢复只读保护 |

### P1 F26–F42：已有部分与需要补齐的完整设计

| 需求 | 当前真实能力 | 完整原型必须补齐 |
| --- | --- | --- |
| F26 变量引用与依赖 | 同环境数据库连接注入、消费者引用 | 通用服务输出、构建/运行期、秘密传播、环/缺失/待就绪、目标环境重绑 |
| F27 配置文件 | 未见配置文件挂载入口 | 文本与秘密文件、权限、路径/卷冲突、差异/冲突与发布 |
| F28 模板仓库与组合模板 | 五个单服务内置模板 | 仓库/版本/schema、组合服务/依赖、逐组件结果和定向重试 |
| F29 Monorepo | Dockerfile 路径、构建上下文 | watch paths、共享目录、无关推送跳过、匹配说明 |
| F30 自动构建 | Dockerfile 构建；预构建示例模板 | 无 Dockerfile 识别/计划、锁文件冲突、命令覆盖与降级到 Dockerfile；Railpack 评估不算交付 |
| F31 历史镜像回滚 | 失败任务重试、恢复原已发布版本 | 选择历史成功 digest、可信配置、镜像缺失/数据保护/停止意图、新记录与结果 |
| F32 容器终端 | 未见命令执行/交互终端入口 | 固定 Pod/container、权限/超时/断连/结束会话、与主机 SSH 的边界 |
| F33 自定义域名与增强网络 | 默认域名、诊断、解绑与异步清理已存在 | 自定义/多个域名、Cloudflare API、所有权与 DNS 记录冲突 |
| F34 公网 TCP | 私有 TCP/具名端口已有 | 公网分配、端口冲突、防火墙、撤销与独立观察 |
| F35 自动备份与恢复 | 手工指引、维护锁、新目标恢复维护、证据记录 | 计划/对象存储/下载/留存、自动恢复向导、数据验证、明确切流与回退 |
| F36 历史指标 | 即时指标及采样时间 | Prometheus/兼容外部历史、范围/采样/缺口/容量/保留设置 |
| F37 历史日志 | 当前有界 Pod 日志、构建/部署输出 | 搜索、下载、集中保留、Loki/外部存储与容量范围 |
| F38 告警与通知 | 运行事件、任务失败、Git 事件详情 | 告警规则/持续/冷却/恢复/合并、通知目标、投递重试和失败追踪 |
| F39 项目声明配置 | 项目 CRUD 已有 | 导入/导出/复制、新目标身份/凭证/依赖映射、schema/优先级/部分失败 |
| F40 环境差异与隔离 | 环境 CRUD、配置和数据归属 | 差异/选项复制、引用重绑、CNI/NetworkPolicy 能力与实测隔离说明 |
| F41 节点维护 | 节点观察与 Server/Cluster 关联 | 加入/排空/恢复调度/移除/重接、PDB/本地数据影响、部分完成/取消/重试 |
| F42 用户 CLI 与 API Token | OpenAPI，初始化/恢复等有限运维 CLI | 登录/上下文/项目服务/发布/日志操作、非交互输出、Token 新建/撤销/到期 |

### P2 F43–F50：独立未来概念

| 需求 | 原型保留范围与边界 |
| --- | --- |
| F43 文件管理 | 容器临时文件、PVC、配置文件三种来源；浏览/传输/编辑/冲突/删除，非任意宿主机文件管理 |
| F44 主机 Web SSH | Server/指纹/维护连接/超时，与 F32 容器终端分开；浏览器不获取私钥 |
| F45 AI 与知识库 | 部署计划/日志诊断/显式文档导入与证据、流式/取消/失败；AiRun 不代替 Deployment |
| F46 PR 预览 | 继承项目目标、可信来源/秘密、TTL/资源配额、创建/更新/失败保留/关闭清理 |
| F47 本地源码上传 | 归档/排除/大小/hash、上传/取消与独立构建，上传成功不等于发布 |
| F48 跨集群迁移与数据库维护 | 新目标项目/映射、源数据保留、备份恢复/验证/停写/切流/回退；密码轮换和应用数据库主版本升级为独立流程 |
| F49 高级路由与 IP 规则 | 条件/优先级/匹配测试/影响预览/撤回，避免锁死管理入口 |
| F50 无状态 HPA | 副本上下限/指标/配额/容量/扩缩历史；数据库与本地卷不能自动增加写入副本 |

PRODUCT 中已有“S5 主库升级”的工程进展不能解释为 F48 的应用数据库主版本升级 UI 已交付。

## 7. 完整可操作原型的连续流程

原型需要共享项目、环境、服务、任务和资源集合。每条流程必须能从真实导航进入、操作、观察结果并返回；不以弹一条 toast、替换一张截图或硬编码固定服务冒充闭环。沿用原 FLOW 编号，分别标明现有能力演示与 P1 规划分支。

| 流程 | 连续操作 | 验收重点 |
| --- | --- | --- |
| FLOW01 首次进入到项目 | 登录 → 无项目 → 完整创建页 → 无目标登记/导入或选已有 Cluster → 名称/更多设置 → 创建 → 项目空态/添加服务 | 接入返回不丢非敏感输入；默认名称/标识重试稳定；项目进入集合；创建不等于部署 |
| FLOW02 镜像到 HTTPS | 添加镜像 → 运行配置 → 保存并固定服务草稿 → 同面板复核 → 确认发布 → 阶段/日志/实例 → 服务网络 → 默认域名 → DNS/路由/TLS 报告 | 保存不启动应用；返回修改复用服务 ID；未知保存先核对原请求；发布失败修正或重试不重复服务；域名受理不显示 HTTPS 已成功 |
| FLOW03 Git 自动发布 | 设置三种集成/验证 → 选仓库/分支/Dockerfile → 配置/发布 → Git 事件 → 部署 → 同源构建/运行日志 | 拒绝/忽略事件不生成发布；固定 commit 与构建产物；Monorepo/自动构建分支注明 P1 |
| FLOW04 停止、推送、恢复 | 服务停止 → 收到新提交 → 待发布 → 选择恢复原版本或发布并启动 → 服务结果/历史 | 恢复沿用原完整快照；草稿和待发布提交保留；取消待确认与终态分开 |
| FLOW05 数据持久化 | PostgreSQL/Redis 模板 → 参数/卷计划 → 创建发布 → 数据详情 → 应用连接映射 → 发布 → 消费者/挂载 → 删除源服务后的保留卷 | 所有引用同环境；实例、数据身份、卷独立；新模板无观察时不能套用既有数据库状态 |
| FLOW06 备份与恢复 | P0：卷 → 手工指引 → 维护任务 → 登记备份 → 新目标恢复维护/证据 → 退出核验；P1：计划/备份 → 新目标恢复向导 → 独立数据验证 → 明确切流 | 记录不执行备份恢复；新目标继承目标项目 Cluster；排队/未知/失败不能记录验证通过；切流独立确认 |
| FLOW07 组合模板与配置 | P1：选择模板仓库/版本 → 三组件参数/依赖/文件 → 创建草稿 → 发布队列 → 单组件失败/重试 → 工作区依赖与结果 | 新服务进入集合；提供方未就绪消费者等待；环/缺失阻止；部分成功保留，无重复资源 |
| FLOW08 失败与回滚 | 失败/部分应用 → 同源日志/事件 → 修改并新发布或固定输入重试；P1：选择历史成功 digest → 复核 → 新任务 → 服务结果 | 原失败不改写；修复不是恢复；历史回滚不倒退数据库、卷或草稿；不可信快照/产物缺失可解释 |
| FLOW09 环境与项目复制 | 环境 CRUD/切换；P1：选来源目标 → 差异/复制配置 → 导出/导入现有项目或选新 Cluster 创建项目 → 映射 → 复核 | 单环境无需反复确认；多环境不串数据；复制配置不复制秘密/数据/运行状态；部分保存可定向修复 |
| FLOW10 异常到排障 | 项目需处理事项/活动 → 同一部署、服务或节点 → 事件/日志/目标观察 → 关联任务；P1：告警与通知投递、终端/CLI | 事件来源未指向服务时不能猜服务；离线保留未知；通知失败不改写原部署结果 |
| FLOW11 节点维护 | 现有节点详情/关联项目；P1：加入或影响预览 → cordon/drain/移除/重接 → 任务 → 节点重新观察 | Project.clusterId 不变；PDB/本地卷阻断；不默认 force；取消和恢复调度分别有任务与终态 |
| FLOW12 凭证与控制面恢复 | 凭证到期 → 新凭证/替换引用 → 分项重验 → Worker/只读状态 → 运维恢复指引/记录 → 对账结果 | 不读回秘密，不重放旧任务；未知/较新 revision/缺主密钥可见；解除锁按真实 CLI，不能伪造 Web 成功 |

额外闭环必须随上述流程覆盖：五模板逐个可进入和返回；全局四类资源聚合/筛选/分页与详情回链；服务全部配置分组的新增/编辑/保存/冲突；域名解绑；独立卷销毁；Git 集成编辑/验证；凭证受引用删除阻止；项目/环境/Server/Cluster 受限删除。不能只验证创建主路径后宣告全功能覆盖。

## 8. 原型与真实页面的交付顺序

1. 已按本次实际 Chrome 体验对齐工作区、命令面板、取消返回与六页签。创建项目使用完整页面。
2. 从 v2 已有页面与场景复用字段和状态，重新组织为一个共享数据的完整原型；保留设计演示标记和现有/规划边界。先串 FLOW01–FLOW04，再补齐全部资源、服务器、设置及 P1 连续分支；不能把剩余家族压成入口卡片。
3. 原型内每个主/次导航、按钮、表单、返回、取消都有可见且可回溯的结果；状态选择用于验收演示，收在独立演示工具中，日常页面不露出测试 ID、模拟开关或实现细节。
4. 完成下列交互核对后，再按稳定布局改真实 Vue 页面；保留原 API/归属/并发/任务语义。已有 compact 编辑器和创建流程调整只是可复用实现，不构成本轮完整改版完成。
5. 真实页面逐项映射本文件的路由、K 能力和 78 场景；已有 API 能力需做实际控件验证，未实现的 P1 不伪装可用。若真正实现新的后端能力，需另补对应数据/任务验收，不能由原型测试代替。

### 原型验收约束

| 核对范围 | 通过条件 |
| --- | --- |
| 覆盖完整性 | 78 场景、12 流程、F01–F42 均有具体可操作落点与状态；P2 八项单列；28 页面文件的当前能力均有新入口 |
| 对象与集合联动 | 新建/改名/删除更新列表与详情；项目切换后不借用另一服务数据；数据库连接、卷、域名、任务都有准确反向链接 |
| 表单与渐进展开 | 返回不丢合理输入；无效折叠字段自动展开定位；.env/来源切换/主题/IME/回车不会误提交或丢内容；未保存离开可取消 |
| 创建与重试 | 已创建服务与后续部署结果分开；同次未知请求可确认，重试不会再建服务；任务重试产生新记录且原失败保留 |
| 状态真实性 | 草稿/已发布/运行观察分开；排队/受理/取消请求/终态分开；失败/未知/陈旧保留时间与恢复入口；不展示无来源的运行资源或依赖 |
| 数据与危险操作 | 项目/环境依赖阻止、production 保护；域名解绑、服务删除、卷销毁分别确认并产生正确结果；保留数据可独立访问 |
| 历史与筛选 | 项目/环境/服务/状态过滤、真实空态/无匹配/分页/刷新失败；旧记录不可被新结果覆盖，返回列表保留合理筛选 |
| 多环境与目标 | 单环境日常隐藏但设置可管理；多环境切换明确；失效环境不回落 production；Cluster 去重且归属不可被表单覆盖 |
| 日志体验 | 固定 Pod/container/部署来源；跟随/暂停/新条数/回底/换行/复制及限额；切换服务不串日志，停止/断线可解释 |
| 屏幕与主题 | 1440、1024、390 宽度及 200% 缩放；详情面板、表单、确认、日志都能完成主操作；深色和主题切换保留上下文 |
| 浏览器操作 | 以连续实际控件操作为证据；前进/后退/直接链接/关闭面板可用；截图只保留少量关键检查，不要求用户补截图 |
| 完成声明 | 分别报告原型交互通过、真实页面控件通过、真实 API/部署能力与未实现项；不混算旧 v2/简版记录 |

### 文档盘点与浏览器证据的区别

初始规划阶段使用 pnpm exec node 对照 v2 矩阵、当前 router 和页面目录完成以下静态核对：

- UI 场景 78/78，无缺失、额外编号或重复行。
- FLOW 连续流程 12/12；F01–F50 需求编号 50/50，无缺失或重复行。
- 页面文件 28/28；router 直接加载的 26 个不同页面全部有映射。
- 68 个不同本地文档/源码链接均能解析到现有文件。

这些检查只证明文档覆盖与当时链接有效。后续完整原型的独立 Chrome 连续操作、模块文件 SHA256 与限制单独记录在 [full-index-results.json](verification/full-index-results.json)；不得据静态编号或旧简版结果宣称全部 78 场景、真实 Console、API 或部署已验收。


## 2026-10-30 交互精修衔接

当前前端继续沿用本 v3 的主入口、六个服务页签、创建来源与复核流程。K01–K21 和 F01–F50 的功能边界、独立数据入口与规划区均保留；本轮的 P0/P1/P2 是精修顺序，不是重划业务阶段。对应代码、问题 ID 和实测结果见 [精修记录](../../docs/console-interaction-polish.md)。

精修集中在加载/错误/离线、点击和弹层反馈、创建与编辑保护、页面返回、日志搜索复制与阅读位置、服务器/域名任务受理、凭证切换和 DNS/数据库复制。新增 [精修原型脚本](verification/interaction-polish-browser.mjs) 与原有完整入口脚本共同维护；仓库内旧 full-index-results.json 和旧截图仍是先前版本的历史证据，不能依据文件名推断当前运行文件已经验证。原型与实际 API 能力的边界不变。
