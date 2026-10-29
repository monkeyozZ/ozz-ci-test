# Console v3 远端 CI

**当前版本通过。** [GitHub Actions 运行 40892518506](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40892518506) 对提交 `095fc261faa508941ad8a69fc208ae29209a7980` 执行了完整工作流，25 个步骤全部成功，失败与跳过均为 0。分支为 `ci/console-v3-interactions-20261029`，事件为 push，attempt 1，runner 为 `ubuntu-24.04-arm`；job `123512833353` 从 2026-10-29T14:32:43Z 运行至 2026-10-29T14:41:20Z。

本次验证完整 Console v3 交互与后端创建重试修复，更新后的代码已推送到用户提供的 `monkeyozZ/ozz-ci-test`。根工作区保持原有 Git 状态；提交和推送在独立 checkout 中完成。

| 实际执行范围                                         | 结果                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| 构建、类型、lint、格式、迁移、API 合约、生产依赖审计 | 全部通过                                   |
| 根单元测试 / Console 单元测试 / Node 数据维护测试    | 422 / 66 / 70 通过                         |
| PostgreSQL、Redis、安全与恢复集成测试                | 16 文件、283 项通过                        |
| 创建弹窗 / 服务工作区 / 存储 / Git 界面              | 14 + 10 + 15 + 12 = 51 项通过              |
| 原有真实 API 端到端流程                              | 16 项通过                                  |
| 完整原型 index                                       | 18 组通过，脚本错误和 HTTP 请求均为 0      |
| 响应式                                               | 66 + 10 = 76 个唯一组合，最大横向溢出 0 px |

浏览器报告均已下载，实际 `test.results`、reporter stats 与运行时间相互匹配；失败、跳过、不稳定、未执行与预期失败项均为 0。原型的五个运行文件 SHA256 逐项匹配该提交。数量来自实际运行报告和 job 日志，没有使用 `--list` 作为通过证据。

新增的 `test:console-fixtures` 使用 Playwright 自带 Chromium、独占的 production preview 及完整 API 拦截；遗漏拦截也无法访问真实 API。`test:prototype` 在 Linux 使用同一 Chromium，报告输出到独立 artifact。原有 `test:e2e` 继续使用 runner 上一次性生成的 API、Worker、PostgreSQL 和 Redis。原型或受控界面失败时，后续独立浏览器验证仍可执行并保存证据，整体运行保持失败。

本轮首个提交 `f175284450c1531fb44e12e5b9e425e9cac66ade` 的[运行 40891129157](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40891129157) 在 API 合约字节比对失败，浏览器测试没有执行。原因是生成 JSON 被 Prettier 改写了排版；解析后的接口内容相同。修复只恢复生成器输出，并将 `docs/openapi.json` 加入 Prettier 忽略项。首轮失败和原始日志仍保留。

| GitHub 制品                                                                                                            | 下载字节 | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------------------- | -------: | ------------------------------------------------------------------ |
| [console-v3-browser-evidence](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40892518506/artifacts/12904983528) |  1404114 | `71ebe2c282f97dc3d087eda6dea0f3d2d013d7f447ad758912a42eb4831942bb` |
| [console-browser-evidence](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40892518506/artifacts/12905677799)    |   741494 | `030c2a4a2656849b62282e21dcb33cf50c07c1b9ef8b1f84e05b29c6d62a6071` |

两个 ZIP 摘要都与 GitHub artifact digest 一致。原始 REST、日志、下载收据、五份浏览器报告和 source manifest 的本地路径及摘要见[机器结果](console-v3-ci-results.json)。上传制品保留 7 天，本地原始副本另存于 `.local`；验收结果及 Markdown 索引在运行成功后补记，运行代码、测试及 workflow 未再次修改。

本地入口仍为[完整原型](http://127.0.0.1:5198/)和[实际 Console](https://127.0.0.1:51448/)，两者读取返回 200 并匹配当前入口文件；API 为 `read_write`，队列为 `ready`。本轮未对用户数据运行变更测试，也未启动 Builder 或集群虚拟机。

这份记录不替代云主机、公共域名、外部 Registry、Webhook 或恢复切换验收；X01–X05 与正式 S6/G-MVP/S7 关口继续保留。受控页面和原型结果不能冒充真实部署成功。用户取消的旁白与无障碍专项没有恢复；78 场景覆盖映射也不等于 78 场景逐项通过。
