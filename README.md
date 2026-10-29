# Ozz · 个人 PaaS

基于 K3s 的个人自托管应用管理平台，以项目组织应用和数据库，统一管理 VPS、独立集群、发布、域名、日志与持久化数据。

**本地控制台已可管理集群、从 Git 自动构建发布应用，并保留数据库和文件数据**。S1–S5 对应本地产品验收和 S5 Linux ARM64 四镜像交付已完成。S6 已跑通固定 Git 提交、隔离 Dockerfile 构建、私有 Registry、K3s 健康发布及测试 CA HTTPS，真实控制台、Webhook 自动部署和七类 Builder 故障核验通过；旧/最终备份恢复、原库对账及恢复后 HTTPS 认证已完成，全停与重启后的应用和数据库采样通过。S6 Linux ARM64 四镜像与 Builder 安装包已完成本地交付，干净安装、生产鉴权、两集群接入、升级回退及 OCI/Registry/Docker 互操作均已通过。[本地联合恢复](docs/acceptance/g-mvp-recovery-joint-timing.md)在同一进程计时下完成 Builder/K3s 对账与新诊断，完整 RTO 为 21.560 秒，连同原站返还共 35.584 秒；逻辑快照已验证，精确物理快照 RPO 仍未知。[真实读屏](docs/acceptance/g-mvp-screen-reader.md)因 macOS 旁白自动化未授权而未通过，已恢复测试前状态；外部关口仍待验，S6 与 G-MVP 总验收仍在进行。真实云入口与公开可信 HTTPS 待 VPS 就绪后补验。证据及剩余关口见 [S1](docs/acceptance/S1.md)、[S2](docs/acceptance/S2.md)、[S3](docs/acceptance/S3.md)、[S4](docs/acceptance/S4.md)、[S5](docs/acceptance/S5.md)、[S5 Linux 交付](docs/acceptance/S5-deployment.md)、[S6](docs/acceptance/S6.md)、[S6 Linux 交付](docs/acceptance/S6-deployment.md)和[G-MVP 本地汇总](docs/acceptance/G-MVP.md)。

```sh
pnpm install --frozen-lockfile
pnpm dev:setup
pnpm dev:infra
pnpm db:generate
pnpm db:migrate
pnpm build
pnpm admin:init --username admin --password-file .secrets/admin-password
pnpm dev
```

打开 <http://127.0.0.1:5173>，使用 `admin` 与本机 `.secrets/admin-password` 中的随机密码；已初始化后无需重复创建管理员。Node 24.22.1 由项目 pnpm 配置管理，不修改全局 Node。完整启动、生产预览及测试步骤见 [开发说明](docs/development.md)，恢复步骤见 [备份恢复](docs/control-plane-recovery.md)。

SSH 和 Kubernetes 开发使用已验证的 [本地三集群环境](docs/local-lab.md)：三台独立的 Ubuntu 24.04 / K3s 虚拟机，由项目内 Lima 管理，按需启停并保留磁盘。A/B 验证已有集群导入及应用发布，C 验证产品初始化；关闭后控制台会保留最后观察并显示失联。Ingress 与本地 ACME 已通过 S4 本地验收，公开可信证书仍待云端验证。

Stitch v2 设计包含 **63 个独立页面/变体，加一个 Z00 交互入口**。原型使用演示数据，已实现的应用页面使用真实后端，二者分别留证。

直接打开 [Z00 完整交互原型](https://stitch.withgoogle.com/preview/10685771573457769661?node-id=3906615778218573374)，或查看 [Stitch 完整设计画布](https://stitch.withgoogle.com/projects/10685771573457769661)。画布按 12 个分区排列，已核对 64 个屏幕引用，无空分组或页面重叠。在线原型已在用户登录的 Chrome 中通过 [12 条代表路径](designs/console-v2/verification/stitch-browser-results.json)、[7 条 P2 补充流程](designs/console-v2/verification/stitch-p2-browser-results.json)与 [8 项主题、表单和手机交互检查](designs/console-v2/verification/stitch-presentation-results.json)。

- [v2 设计交付说明：查看方式、页面目录、构建命令与当前验证进度](designs/console-v2/README.md)
- [UI 覆盖矩阵：78 个场景、12 条主要流程与功能映射](designs/console-v2/coverage-matrix.md)
- [Stitch 页面索引：实际屏幕 ID、在线链接与 F01–F50 映射](designs/console-v2/stitch-screen-map.md)
- [完整 PRD：产品范围与业务行为](docs/prd.md)
- [完整开发计划：S1–S9、83 个阶段任务、依赖与验收](docs/development-plan.md)
- [技术方案](docs/technical-plan.md)与[后端选型评估](docs/backend-stack-evaluation.md)
- [产品背景](PRODUCT.md)与[设计规范](DESIGN.md)

统一归属为 **Cluster → Project → Environment → Service**。项目创建时绑定一个集群；环境和服务继承该目标。Server 是 SSH 主机，Node 是集群节点，不能把同一集群的多台主机当成重复的项目部署目标。

控制台沿用浅紫色主视觉，提供深色主题以及 390/1024/1440px 布局。实现基线为 Vue 3、shadcn-vue/Reka、Tailwind CSS 4；服务端为 TypeScript/Node.js 24、NestJS/Fastify、Prisma/PostgreSQL 与 Redis/BullMQ。具体版本已经锁定在 workspace 清单、lockfile 与镜像记录。后续 AI 按 P2 规划，通过模型 API 提供部署助手、日志诊断与知识库问答。

用户已选择先本地开发测试。正式基础设施从 **2 台 VPS** 起步：Oracle **2 核 / 12 GB / 80 GB** 独立控制面，加一台推荐 **4 核 / 8 GB / 80–100 GB SSD** 的应用服务器。应用与卷放在 K3s 集群，源码构建使用独立执行环境。实例尚未创建，权益与架构在建机时核对，详见 [本地测试和 VPS 准备](docs/local-test-and-vps-plan.md)。

从项目根目录可重新打包并查看现有设计：

```sh
node designs/console-v2/build-stitch-pages.mjs
node designs/console-v2/build-prototype.mjs
python3 -m http.server 8765 --bind 127.0.0.1
```

然后访问 [本地 Z00 设计预览](http://127.0.0.1:8765/designs/console-v2/stitch-ready/Z00.html)。以上命令只处理设计文件；当前应用使用前面的 pnpm 启动步骤。原型中的模拟成功不代表相应后端功能已经验收。

历史与调研资料：[v1 五张静态设计](designs/console-v1/README.md)、[原始 PRD](docs/prd-original.md)、[Zeabur 功能对照](docs/zeabur-gap-analysis.md)。需求以统一 PRD 为准，v1 和原始导出保留作追溯。
