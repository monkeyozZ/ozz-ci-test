# Ozz CI 运行记录

**当前结果：通过。** 第三轮 GitHub Actions 运行及全部 21 个步骤均为 success，覆盖构建、类型检查、lint、格式检查、单元测试、数据库迁移、API 合约、集成测试、生产依赖审计和浏览器验证。

[第三轮 run 40842129629](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40842129629) 绑定提交 `5abe480bd12f4517e6b5beb7e3d7030856450c61`，`main` 分支 push，attempt 1。工作流为 `S1 control plane`；job `123340757370` 使用 `ubuntu-24.04-arm`，时间为 2026-10-29 08:26:25–08:33:20 UTC（415 秒）。官方 annotations 数量为 0，证据上传与清理成功。

| 运行 | 提交 | 真实结果 |
| --- | --- | --- |
| [首轮 40834582691](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40834582691) | `5befe2df60ce3971b980bd14287974e19f9962b5` | ESLint 失败，后续集成和浏览器步骤跳过 |
| [第二轮 40837555726](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40837555726) | `0f71b3db8c2b87740357da2c89801c486338af95` | 浏览器交互用例超时失败 |
| [第三轮 40842129629](https://github.com/monkeyozZ/ozz-ci-test/actions/runs/40842129629) | `5abe480bd12f4517e6b5beb7e3d7030856450c61` | 全部工作流步骤成功 |

第三轮修复了既有会话失效测试的请求时序；用户取消的 WCAG 专项通过标签从默认运行中排除，普通主题切换和按钮可用性检查保留。真实推送及 `ls-remote` 回执均为 exit 0，并与第三轮 head 一致。原本地提交回执的“未推送”仅是提交创建时的历史状态。

第三轮 Node、unit、integration、e2e 精确执行计数均保留为 `null`。本轮 REST 证明各步骤成功，没有提供精确测试数量；未沿用第二轮计数，也未把本地 Playwright list 的 16 tests / 5 files 当作实际运行结果。

第二轮安全日志诊断及实际计数完整保留：root unit 30 文件/419 测试通过，console unit 7 文件/49 测试通过，integration 16 文件/276 测试通过，browser 17 个中 16 通过、1 失败；Node 计数仍未知。失败位于 `interaction.spec.ts:144`，155 行点击刷新等待 90 秒超时。日志观察是按钮加载时 disabled、随后 detached；时序竞争有证据支持，失败页 URL 未记录，具体提前跳登录未写成已验证事实。

此前审批服务 HTTP 404 引起的未执行推送保留为已解决历史。首轮匿名日志下载 403 与第二轮后续安全日志诊断分开记录。两次失败、第二轮诊断、第二次本地修复对象及全部原始证据绑定均在配套 JSON 中保留。

第三轮 artifact 元数据记录 1 个 `console-browser-evidence`（3,571 字节），本报告未下载其内容。修复后 853 个候选文件对 5 份库存、73 个库存文件、118 个已知模式的扫描零命中；该扫描覆盖范围限于库存中已有值。

| 第三轮证据 | SHA-256 |
| --- | --- |
| run 原始 REST | `50d1240aff1b69f45b59e090e8b2d1379b406ee4644db8c81504a179a0032366` |
| jobs 原始 REST（21 steps） | `7db898b059d9906e8613056fde6ec676092bb6d306ba3b8b72cf43c13b825bdf` |
| check 原始 REST | `3cbaa72ce51cd03ad16b891e6afec77f965fa0f9a6fd51f86ce6d0cea39f990d` |
| annotations 原始 REST | `2ba33ca0557f1bb5b7ba88d67f9d0093c7185a36ec51fe2b7bd9372d3e001d6d` |
| artifacts 元数据原始 REST | `7ef31d4f5dbdcee629f60928060b59fe4baffb1e1f654b8390e9543fb00c7b00` |
| 本地 commit 回执 | `8a31509592a2ee72b834b37aad60c63d159a33ca098d4fcb71967280f4ab1b60` |
| source manifest | `71fab885430b4d05647d364ef8564d2cfbbc4b872ab771d598b030e7e46ed24f` |
| 已知值扫描 | `b050b0267a3017a3e63170be36d011ac843184aaf6acb7199efcdabe49d83f09` |
| push / ls-remote 回执 | `e1c7f69e6e5ffa4acce5ae88cf6ebf7aff1223983ab2d30e000e996ce53a1bff` |

这是仓库默认控制面 CI 的通过记录，不构成产品在真实云资源上的功能验收，也不恢复用户已取消的无障碍专项门槛。本报告汇总运行元数据和具名修复证据，前两轮失败报告保持原样。

[机器结果](g-mvp-ci-results.json)保留步骤与原始回执绑定；本次公开字节见[外置核验收据](../../.local/g-mvp-scope-ci-publication-20261029-5fcd1fb4-1af5-4f0b-8eb6-262f76824771/final-validation.json)。
