# Product

## Register

product

## Users

Ozz 面向单一管理员，以项目组织自己的应用与数据库，管理其运行所需的 VPS 和多个独立 K3s 集群。主要使用场景是桌面浏览器中的日常发布、状态检查和故障排查；用户重视中文交互、清晰的资源上下文与可靠反馈。

## Product Purpose

通过统一控制台完成服务器接入、项目/环境管理、应用发布、域名、日志、持久化数据与备份。统一归属为 `Cluster → Project → Environment → Service`：项目必须绑定一个已登记 Cluster，同一 Cluster 可承载多个项目；环境和服务继承项目目标，普通编辑不更换目标或将已有环境改挂其他项目。同项目的 production/staging 等环境使用同一集群；需要分集群时使用不同项目，通过配置复制或明确的数据迁移流程转移内容。

Server 是 SSH 主机，Cluster 是 Kubernetes API，Node 是集群中的节点。单节点 Cluster 可在 UI 中以其服务器名称展示，但实际仍引用 Cluster；Server 与 Cluster 不构成两种并列调度实体，多节点集群中的项目也不被描述为固定属于其中一台主机。已登记但未验证的 Cluster 可用于保存项目元数据，真实发布仍要求目标连接、权限与所需能力可用。

发布必须区分草稿、已发布快照和实际观察，控制面与应用运行面分开。项目配置复制重新分配资源身份并重映射依赖，不复制数据或运行状态；跨集群数据迁移属于 F48，在目标 Cluster 创建目标项目，经过恢复、验证、停写及流量切换处理。

产品需求和验收以 [PRD](docs/prd.md) 为准。后端维护语言已确认为 TypeScript / Node.js；前端选择 Vue 3、shadcn-vue 与 Tailwind CSS。AI 部署助手、日志诊断和知识库属于后续 P2。

## Brand Personality

清晰、准确、克制。以用户提供的 Ozz 紫色浅色控制台拼图作为视觉参考，追求长时间使用时的可读性、操作效率与精细感。文案具体说明对象、状态与下一步。

## Anti-references

避免用大面积装饰地图挤占异常与部署任务的位置；避免弱化项目入口、让服务绕过项目独立选择目标、把 Server 与 Cluster 混成可重复选择的调度对象，或把 production 当成跨项目环境。避免用一个运行中标记替代全部发布状态，用无来源的指标、不可用按钮和成功提示冒充真实执行结果。避免小而淡的密集文字、重复卡片套层以及妨碍操作的装饰动效。

## Design Principles

1. 优先呈现需要处理的问题、进行中的任务和相关操作。
2. 通过项目列表、创建项目和项目内服务组织操作；保留继承目标，确认仅有一个环境时隐藏日常环境选择，多个环境时明确显示。全局基础设施页面不附加虚假的全局环境。
3. 草稿、发布历史和实际运行各自有明确来源与时间，失败与未知状态可诊断。
4. 复杂配置渐进展开，沿用一致的表单、表格和任务呈现。
5. 样例数据明确作为设计演示，静态图和 Stitch 交互原型不能证明应用交互或实际部署已经通过验收。

## Usability & Interaction

保留正常文字可读性、可见焦点、图标名称、中文字体回退、键盘/输入法、减少动效、窄屏操作与 200% 缩放的常规体验验证。状态同时使用文字与图标表达，不能只靠颜色。

按用户 2026-10-29 的范围调整，无障碍、辅助技术、真实读屏与 WCAG 合规不再属于当前需求或验收门槛（`excluded-by-user`）。既有语义标注、组件实现和历史检查证据保留；历史失败不会因范围调整改为通过。

## Source of Context

依据当前 [PRD](docs/prd.md)、用户确认的技术偏好和项目归属取舍、Ozz 视觉拼图，以及 Zeabur 的项目与服务交互。2026-10-29 已按用户授权在 Chrome 实际打开项目创建、项目内服务、来源选择、Docker 配置、数据库分类和 Git 表单，形成[操作参考记录](designs/console-v3/reference-notes.md)。本轮以可操作原型与真实页面验收，业务模型仍以 PRD 为准。

## Current Design Scope

2026-10-29 用户要求直接采用 Zeabur 的交互，并保留完整功能范围。[v3 完整交互原型](designs/console-v3/index.html)与[覆盖规划](designs/console-v3/coverage-plan.md)取代此前过于简略的创建主路径原型。本轮调整真实 Console：全局导航收敛为项目、服务器、设置；项目内直接切换服务；添加服务在原页面内连续选择来源、配置并核对部署；服务详情使用状态、变量、用量、网络、数据与存储、设置六页签。资源聚合、活动任务、Git/Builder/Registry、凭证、数据维护和旧链接保留可达入口。具体实现与验证范围见[本轮记录](docs/console-v3-interaction.md)。

Environment 用于组织同项目的一组应用、数据库、配置、网络与数据归属，不是数据库类型分类。创建项目仍自动建立 production，环境 CRUD 移到项目设置；只有完整读取后确认单环境才隐藏选择，分页、错误和多环境不会悄悄回落到另一个环境。项目创建名称可选、标识自动生成；保存服务后固定原服务身份，再核对部署，返回编辑与重试不会重新创建。模板目录保留 Docker、Node.js 示例、静态站点示例、PostgreSQL、Redis。原型内尚未接入真实 API 的后续能力明确标为规划演示。

Stitch 全产品 UI 与交互设计已交付，用户已继续授权按文档和设计实施；S1–S4 已通过对应本地产品验收。S5 主库升级、模板、持久化、连接注入、数据保留、三类新目标恢复、真实控制台和失联恢复已通过，固定源码的 Linux ARM64 四镜像、Compose 19 项检查与归档核验已完成。S6 固定 Git 构建到 HTTPS、双状态 Webhook、真实控制台和七类 Linux Builder 故障验证已通过；[OOM 与部分应用保护](docs/acceptance/g-mvp-workload-fault-local-lab.md)、[C 节点/PVC 停启](docs/acceptance/g-mvp-node-persistence-local-lab.md)、[旧/最终备份恢复与原库对账](docs/acceptance/g-mvp-recovery-local-lab.md)也已有分别通过的实测。[恢复后 HTTPS 认证](docs/acceptance/g-mvp-recovery-https-results.json)通过；[独立元数据恢复](docs/acceptance/g-mvp-recovery-timing-results.json)的 14.537213 秒保留为不含远端对账的历史样本。新的[联合恢复](docs/acceptance/g-mvp-recovery-joint-timing.md)完成逻辑快照验证、Builder/K3s 对账与新诊断，完整 RTO 为 21.560 秒，原站返还为 13.993 秒；精确物理快照 RPO 仍未知。[S6 Linux 本地交付](docs/acceptance/S6-deployment.md)已完成四镜像、Builder 安装包、干净安装/生产鉴权、两集群接入和升级回退验证。[历史读屏尝试](docs/acceptance/g-mvp-screen-reader.md)保留失败和状态恢复证据，按上述用户范围调整不再构成验收门槛；外部关口仍待验，当前证据与版本范围见[G-MVP 本地汇总](docs/acceptance/G-MVP.md)，S6 与 G-MVP 总验收尚未完成。

P0/P1/P2 的业务范围与 83 个阶段任务 ID 保留；体验要求按本次用户决定移除无障碍部分，其余要求继续适用。控制台已使用真实 API；具体交付与剩余检查以 [S1](docs/acceptance/S1.md)、[S2](docs/acceptance/S2.md)、[S3](docs/acceptance/S3.md)、[S4](docs/acceptance/S4.md)、[S5](docs/acceptance/S5.md)、[S5 Linux 交付](docs/acceptance/S5-deployment.md)、[S6](docs/acceptance/S6.md)和[本地联合验收矩阵](docs/g-mvp-local-acceptance-plan.md)为准。Stitch 原型的浏览器记录与真实应用、后端和部署验收分开，不能互相替代。

用户暂时没有应用 VPS，已选择先本地开发测试，随后再接真实主机；Oracle 仍只承载控制面。允许为测试停止本机无关运行服务，保留数据，具体拓扑及服务器配置见 [本地测试计划](docs/local-test-and-vps-plan.md)。

早期 v1 的五张浅色桌面静态图保留为历史设计材料；本轮范围已扩展为完整 Stitch 设计，不再受这五张图的页面范围限制。
