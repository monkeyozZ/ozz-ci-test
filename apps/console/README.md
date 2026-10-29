# Ozz Console

控制台使用已确认的 [Stitch 设计](../../designs/console-v2/README.md)，接入同源 `/api`。项目组织环境与服务，镜像发布使用独立执行器处理。页面区分配置草稿、固定发布快照和真实运行观察；服务器或集群登记不会被显示成已验证在线。

## 开发

从仓库根目录按项目开发说明准备 PostgreSQL、Redis、管理员与 API，再运行：

```sh
pnpm --filter @ozz/console dev
pnpm --filter @ozz/console typecheck
pnpm --filter @ozz/console build
```

控制台地址 `http://127.0.0.1:5173`，Vite 默认将 `/api` 代理到 `http://127.0.0.1:3000`。可通过 `OZZ_API_PROXY` 更改代理目标；浏览器仍使用同源入口。部署时由根目录 Caddy 配置负责入口。

技术依赖：Vue 3、Vue Router 4、Pinia 3、Vue Query 5、Reka UI 2、Tailwind CSS 4、Vite 8。`components/ui` 中的本地 shadcn-vue 组件使用 `components.json` 管理，图标来自官方 `@lucide/vue`。版本由包清单和 workspace lockfile 固定。

API 类型从 `@ozz/api-client` 的 OpenAPI 生成 schema 引用。接口修改后运行根目录 `pnpm api:generate`，不手工维护另一份领域模型。

## 当前页面

| 路由                                       | 已实现行为                                                     | 设计来源        |
| ------------------------------------------ | -------------------------------------------------------------- | --------------- |
| `/login`                                   | 管理员登录、会话过期返回、登录失败与初始化说明                 | H01             |
| `/projects`                                | 真实项目列表、筛选、分页、空状态                               | A01             |
| `/projects/new`                            | 先选择已登记集群，再创建项目与 production                      | A02             |
| `/projects/:projectId`                     | 当前环境服务、URL 环境切换、环境 CRUD、项目修改与受限删除      | A03/A04/C04/C06 |
| `/services`                                | 服务汇总、项目与集群筛选，进入所属项目环境                     | A03/B01         |
| `/projects/:projectId/services/new`        | 镜像服务草稿、配置分组、`.env` 导入与秘密引用                  | B02             |
| `/projects/:projectId/services/:serviceId` | 草稿/发布/运行分离、差异预览、实例与日志、服务操作确认         | B03/B04/B05     |
| `/deployments/:deploymentId`               | 真实阶段、固定目标与快照、持久日志、失败采样、取消与原快照重试 | F01/F02         |
| `/infrastructure`                          | 集群和服务器登记列表、分页与搜索                               | D01             |
| `/clusters/new`、`/clusters/:clusterId`    | 集群元数据 CRUD、项目计数、已引用目标连接身份保护              | D04             |
| `/servers/new`、`/servers/:serverId`       | 地址、SSH 用户、端口、凭证引用与标签 CRUD                      | D02             |
| `/settings`                                | 外观偏好、凭证创建/列表/受限删除；内容不回显                   | G03             |
| `/operations`、`/operations/:operationId`  | 独立 Worker 状态、基础设施/服务操作、固定目标、真实日志与结果  | F01/F02/G07     |

接口入口为 `src/lib/api.ts`，处理 Cookie、内存 CSRF、请求超时、Problem Details 和会话代次。响应体完成后仍核对会话代次，防止旧会话的迟到响应影响新会话。变更请求不自动重试，诊断受理和重试复用当前意图的幂等键。

Vue Query 按资源身份和查询参数隔离缓存；项目变化会更新集群引用计数。表单保留自己的编辑快照，后台刷新不覆盖脏数据。保存、显式重新载入和编辑切换互斥，删除确认固定审阅时的 revision。离页后完成的写入可以刷新列表，不能把用户强行导航回原表单。会话清理同时取消旧确认框并清除上下文提示。

主题、导航和命令面板状态在 Pinia 中管理。只有外观偏好写入 localStorage，凭证内容、CSRF 和表单草稿均不持久化到浏览器存储。命令面板只检索当前已加载的资源与实际可用操作。

容器日志最多保留最近 10,000 行或 200,000 个 UTF-16 字符（先到者为准，字节上限严格小于 5 MiB），并保留完整 Unicode 字符边界。TanStack Virtual 仅渲染视口附近的日志行，换行时测量实际行高；裁剪旧行后保持正在阅读的行位置。“复制缓冲日志”复制完整有界缓冲中的纯文本，不限于当前可见行。日志暂停只影响滚动；切换实例、容器、上次退出、服务或会话会中止旧连接并清理输出。运行日志和部署日志均可切换长行换行。每条真实日志连接仍服从 API 的 60 秒 / 1 MiB 限额，结束提示与工具栏使用稳定的布局区域。

运行观察以 mCPU 呈现小于一核的非零采样，最近事件默认显示五条，可展开本次采样的其余事件。部署中的“失败时的运行状态”默认折叠，独立展示失败尝试、采集与采样时间、当时差异和截断范围；后续刷新不会将实时观察写成历史失败证据，服务删除后仍可读保留的部署记录。

## 验证

```sh
pnpm --filter @ozz/console test:unit
PLAYWRIGHT_CHANNEL=chrome node apps/console/scripts/run-e2e.mjs
```

第二条从仓库根运行，使用真实本地 API/数据库/Worker。脚本从 `E2E_PASSWORD` 或根目录受保护的 `.secrets/admin-password` 读取测试密码，默认账号 `admin`；不会打印密码。CI 可安装 Playwright Chromium 并省略 `PLAYWRIGHT_CHANNEL`。测试只应针对隔离的开发环境执行，会创建带 `e2e-` 标识的资源并定向清理，诊断记录按真实任务保留策略保存。

每个 Playwright worker 仅在内存中复用已经登录的会话，每次使用前通过 `/auth/me` 验证；登出和撤销测试后重新通过界面登录。测试不关闭登录限速，也不把会话材料写入文件。

S3 本地双集群验收使用独立配置，从已有的 `.local/local-lab/product-state.json` 和 `service-product-state.json` 读取 A/B 资源身份：

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/run-console-e2e.mjs --config tests/local-lab/s3.playwright.config.ts
```

此命令从仓库根目录运行，要求 API、Worker 和 5173 production preview 已就绪。套件只读核对保留的 A/B 服务，在 A 项目中通过 UI 创建唯一标识的独立服务，完成保存、发布健康、停止、恢复与删除，并核对历史记录保留。日志测试观察真实 fetch 的取消信号，保留原始网络请求与响应；不会用假数据替代后端。明暗主题检查覆盖 11 个页面状态和 390/1024/1440 CSS px。

S3 报告保存到 `tests/artifacts/s3-local-lab/browser-results.json`，截图与明细在 `test-results/s3-local-lab/`。每次正式运行使用一个 worker 复用内存会话；反复启动新进程会消耗真实登录限流额度，达到上限时应等待窗口恢复。此套件不包含长时运行与高负载性能矩阵。

若已有包含持久 `failureObservation` 的真实失败部署，可加 `S3_FAILURE_DEPLOYMENT_ID=<部署 ID>` 运行同一命令，额外核对失败诊断默认折叠、服务删除后的历史可读、事件展开焦点、CPU 精度和日志原文换行。此用例不制造或补写历史证据。

S3 持续前端压力使用独立配置：

```sh
PLAYWRIGHT_CHANNEL=chrome node scripts/run-console-e2e.mjs --config tests/local-lab/s3-performance.playwright.config.ts
```

此测试先真实登录并只读取得模板，随后在测试进程内生成 100 个服务元数据和 10,000 条部署历史。生产 UI 使用正常的 50 条游标分页、搜索、状态筛选、草稿编辑和任务页面。两个浏览器页面持续追加日志十分钟，同时每秒执行一组五个并发受控管理读取。日志源每 100ms 追加一批，每条连接在 55 秒或 1 MiB 结束，通过正常界面重新跟随，不放宽后端限额。长行窗口触发字符裁剪，短行窗口触发行数裁剪；期间核对暂停、横向滚动、换行、中文 IME、回到最新和清理后的堆与 DOM 计数。

受控元数据由测试自有的 `127.0.0.1` 随机端口 HTTP 源返回，浏览器使用原生 fetch 和 JSON 解析；仅日志采用有界 ReadableStream。固定 5ms 数据延迟、分页与数据集保持一致。测试不向该监听转发真实 Cookie 或 CSRF，结束时关闭监听；静态资源继续使用原生 HTTP 缓存。报告记录冷/热缓存、测试机与浏览器、点击到下一帧估计、交互会话 Event Timing/INP 估计、CLS 和内存回收，并分别记录完整缓冲大小与实际渲染行数。测试不写入数据库，也不证明真实 API、数据库或目标服务器容量；真实有限 SSE 由常规 S3 套件另行验证。报告在 `tests/artifacts/s3-performance/browser-results.json`，详细 `frontend-performance.json` 与截图在 `test-results/s3-performance/`。

可用 `S3_PERFORMANCE_DURATION_MS=65000` 跑短探针，但短探针不构成十分钟验收。反馈计时要求浏览器可信输入；Playwright `selectOption` 的合成 change 只用于筛选正确性核对，不计作可信输入延迟。INP 为该自动交互会话的估计，不能替代线上用户数据；内存计数区分清理日志缓冲与切换页面后的新 DOM 分配。

`S3_PERFORMANCE_CONTEXT` 可记录同机并行负载；`S3_PERFORMANCE_PROFILE=1` 仅用于启动 CPU 诊断，会影响采样，不能作为正式成绩。早期方案通过 Playwright binding 回传整棵对象，额外引入框架对象反序列化；现改为原生 HTTP 测试传输。旧长测结果与启动 profile 保留在 `tests/artifacts/s3-performance/`，不会被新的结果冒充为通过。

Playwright 覆盖实际 CRUD/刷新持久化、环境继承、凭证引用保护、诊断与取消、会话撤销、中文 IME、未保存编辑、迟到请求、明暗主题、390/1024/1440 CSS px 和 200% 文字缩放。竞态用例延迟真实 API 响应，核对离页、删除版本及会话清理。请求层单测单独模拟延迟响应体，不作为后端验收证据。

axe 扫描覆盖明暗两主题、桌面/窄屏及主要页面。自动扫描和桌面模拟不替代真实移动设备、读屏器与浏览器级缩放验收。可复现步骤、截图与 JSON 结果写入被忽略的 `test-results/`、`tests/artifacts/`；以实际运行结果为准。

生产体验基线使用 `scripts/measure-browser.mjs`。将 5173 上的开发服务切换为生产预览，再在另一个终端运行采样：

```sh
pnpm --filter @ozz/console build
pnpm --filter @ozz/console preview --port 5173 --strictPort
# 另一个终端，从仓库根运行
PLAYWRIGHT_CHANNEL=chrome node apps/console/scripts/measure-browser.mjs
```

脚本拒绝开发入口，通过一次真实登录读取当前资源数量，记录清空/复用 HTTP 缓存后的导航、键盘和表单反馈、Event Timing 样本、长任务与 CLS，并撤销自己的会话。结果保存在 `tests/artifacts/browser-baseline.json`。记录的测试机、浏览器、视口及本地网络条件随报告保存；短时 S1 样本不能代表 Oracle 目标机容量或全量服务规模下的 INP。
