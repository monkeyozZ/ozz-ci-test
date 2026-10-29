# Railpack 短评估（2026-10-29）

已完成 S7 设计允许提前开展的成熟构建器短评估：Railpack 0.43.0 可以为受控 Node Web 与静态站点样本生成计划，保留为自动构建的候选。锁文件冲突、版本来源冲突和输入身份仍需 Ozz 自行校验；本次没有完成生产接入，也不改变 G-MVP 或 S7 的验收状态。

范围依据：[S7 实施设计第 15 节](../s7-development-experience-implementation.md#15-所有权实施顺序与交接)。本次独立于既有 CI 和验收发布，用户正在使用的本地 API、Worker、HTTPS 入口及浏览器保持运行，未执行会修改产品数据的测试。

## 工具与执行范围

| 项目                        | 本次固定值                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| 上游                        | [railwayapp/railpack v0.43.0](https://github.com/railwayapp/railpack/releases/tag/v0.43.0) |
| 上游提交                    | c71ae09408996068bcc9cf685146f55d428ef816                                                   |
| 执行平台                    | macOS ARM64；不是生产 Linux Builder                                                        |
| Railpack 归档 SHA-256       | 385026934127726fd0f9b5a1431c5ae441062ea9958a5f9dbb0e98a29142d6de                           |
| Railpack 可执行文件 SHA-256 | dd0caa9b9240aab1eb5e78a7b6a5944a6dd0719f654eb92bc9ec22f6f068d032                           |
| Mise                        | 2026.10.14，上游固定的辅助工具版本                                                         |
| Mise 归档 SHA-256           | eb68c824e16af90f61e70e0d785179f335b1b95466606a5e0d8b9da504bb7bb2                           |
| Mise 可执行文件 SHA-256     | 005b32b9c22ca9cb63ff9d35c74b3abe69c433e9ca655fea288ba3dcbe7e4918                           |
| Node Web 样本声明           | Node 24.22.1、pnpm 12.14.0、单一 pnpm 锁文件、无第三方应用依赖                             |

两份归档均从官方 GitHub release 下载，长度与 SHA-256 同 release API、官方校验和清单匹配后才提取、执行。Mise 已验证后预置到本次缓存，所以没有测试 Railpack 首次自动下载安装 Mise 的路径。

真实执行了版本检查以及 15 次以下形式的命令，每次使用独立输出目录：

    railpack prepare --hide-pretty-plan --error-missing-start \
      --plan-out <run>/plan.json --info-out <run>/info.json <fixture>

结果为 12 次退出 0、3 次预期输入拒绝退出 1；这些计数表示样本执行结果，并不表示 15 项生产能力全部通过。未触发超时，全部样本输入文件前后摘要一致，安装/构建脚本的执行标记均未出现。正常退出后的进程组检查为空；没有模拟取消、失联或崩溃，不能用它替代 Builder 结束证明。

原版 CLI 将宿主 Mise 目录固定为 /tmp/railpack/mise，外部缓存环境变量不能替换该路径。本次在该路径原先不存在的前提下，临时链接到独立目录，并用 macOS sandbox-exec 限制文件写入；允许目录内写入、拒绝目录外写入的探针符合预期。执行后核对链接身份并移除，固定路径恢复不存在。启动环境未继承 GitHub 凭据，也未改写宿主 HOME；Mise 自身如何设置子进程 HOME 是上游实现。本次限制不能替代生产 Linux 隔离验证。

## 样本发现

编号对应[机器可读记录](s7-railpack-evaluation-20261029.json)中的 cases。

| 组                | 样本       | 实际结果与接入含义                                                                                                                                                                                                                                                |
| ----------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node Web          | 01         | 解析到 Node 24.22.1、pnpm 12.14.0；计划包含 pnpm install --frozen-lockfile --prefer-offline、pnpm run build、pnpm run start。样本源码声明监听 PORT，默认 8080；没有执行安装、启动或 HTTP 请求。                                                                   |
| 静态站点          | 06、07     | Staticfile 的 public 根目录和 Node 构建后的 dist 目录均生成 Caddy 2.11.7 计划，监听表达式为 :{$PORT:80}。07 包含 pnpm run build、复制 dist 和 /app/dist 映射，但 dist 在规划结束后仍不存在；产物和实际静态服务尚未验证。                                          |
| 锁文件冲突        | 08、09     | 同时存在有效的 pnpm 与 npm 最小锁文件时，未拒绝，选择 pnpm 9.15.9；声明 npm@11.8.0 却只有 pnpm 锁文件时也退出 0，生成 npm install 并建议补 npm 锁。Ozz 必须在进入 planner 前拒绝不明确的输入。                                                                    |
| 无法规划          | 10、11、12 | 空目录、仅 README、缺少启动入口均退出 1，info.success=false，未生成 plan.json，错误可以定位。                                                                                                                                                                     |
| Dockerfile 存在性 | 13         | Node 样本增加 Dockerfile 后仍选择 Node，计划与 01 完全相同。此 Dockerfile 仅用于存在性检测，未验证其可构建性；Ozz 的显式 Dockerfile 模式仍需选择既有构建路径。                                                                                                    |
| 变量与脚本        | 14         | 通过 --env 名称转交的普通变量和构建秘密 canary 均只在计划出现名字，值未出现在 plan、info、stdout、stderr（包含计划内生成资产）。仅存在于进程环境、未转交的 runtime canary 名字和值均未出现。preinstall/build 标记未产生；这是合成样本观察，尚未验证真实秘密挂载。 |
| 输入与计划身份    | 01–05      | 连续两次同输入的原始与规范化计划摘要一致；改变 package.json 内的启动脚本或锁文件内容，输入摘要改变但计划摘要不变。显式 --start-cmd 改变计划摘要。planHash 不能单独代表源代码或锁文件身份。                                                                        |
| 版本来源冲突      | 15         | 显式 RAILPACK_NODE_VERSION=24.22.1 与 engines.node=24.22.1 同时存在时，.nvmrc=22.14.0 仍令最终计划解析到 Node 22.14.0。不能依照官方文档所述的环境变量最高优先级直接承诺行为。                                                                                     |

变量样本只覆盖 CLI 的 --env 路径，没有验证 deploy.variables 普通变量配置，也没有验证构建阶段之间的秘密隔离。

身份样本的关键摘要如下；规范化只排序 JSON 对象键，保留所有字段和数组顺序，没有删除差异字段。

| 样本             | 输入文件清单 SHA-256                                             | 原始 plan.json SHA-256                                           |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| 01、02           | afec3d18108bdb5cd41c61aa8dcebcd688eef2f0e72fa76fddcaf5c8eb21d511 | 6612dc1a7559a0be8f36efc721fa9c57eb42f9bb406a20504020a7a788c48e9d |
| 03，改启动脚本   | 16e86b1f400f53e7373b765b30cdab2c9b3b6460d5d90dd31b558c95002bae20 | 6612dc1a7559a0be8f36efc721fa9c57eb42f9bb406a20504020a7a788c48e9d |
| 04，改锁内容     | 1cb101868d1c83faef89b05680727b31e8429ff7a90d1f7d607d7d856d12da36 | 6612dc1a7559a0be8f36efc721fa9c57eb42f9bb406a20504020a7a788c48e9d |
| 05，显式启动命令 | 与 01 相同，调用参数不同                                         | 8bfe58ca3174367e80941bf5d00439f6fb4f454d025cebbe9e6aacf0c2e58d19 |

## 接入前需要固定的契约

1. 固定源码提交/树、root/context、完整锁文件与声明输入，并共同绑定 planner 版本、计划、构建 profile、平台及秘密版本引用。保持既有 GitSourceRevision/recipeHash 历史语义，不用 planHash 覆盖它们。
2. 在 Ozz 明确选择自动构建或 Dockerfile；拒绝多锁、包管理器与锁不符、版本声明冲突，并核对 planner 最终解析版本。不能将上游退出 0 直接作为输入符合 Ozz 规则的证明。
3. 扩展现有 Builder 协议与阶段，而非直接把 JSON 送入当前 Dockerfile driver。[phase-helper.py](../../infra/builder/phase-helper.py) 当前固定 docker/dockerfile frontend 与 OCI 导出路径；本次没有修改该实现。正式构建需要匹配 planner 的 Railpack frontend，并固定 frontend、builder/runtime 基础镜像 digest。
4. 保留类型明确的普通变量、build secret、runtime secret。普通变量经 --env 也进入上游 secrets 名单；配置变量又可能直接影响生成内容，不能把“值永不进入计划”推广到任意配置。固定源码会把 plan.Secrets 中的全部秘密作为环境秘密挂载到每个 Exec；step.secrets 控制缓存失效选择，不是按阶段授权的名单。因此 runtime-only 秘密不能自动交给 planner 或 Builder；若 Ozz 需要限制 build secret 可进入的具体阶段，也必须额外实现并验证。缓存分租户与秘密变更失效还需按上游 cache-key、secrets-hash 语义接线并真实验证。
5. 区分输入失败、暂时性失败和进程未启动。此次实测退出 1 的负例有 info；固定源码中的初始化/下载错误可提前退出 75，此时 info 可能不存在。平台应使用 prepare；railpack schema 提供的是用户配置 schema，不能当成最终 BuildPlan 的完整兼容契约。

版本固定也不等于产物完全可复现：样本计划仍引用带 tag 的 builder/runtime 镜像，包含未固定版本的 node-gyp、APT 包或 corepack@latest。上述依赖与镜像 digest 尚未解析、构建或验证，不把本次计划摘要等同于最终镜像身份。

剩余实测包括 Linux planner、真正依赖安装与构建、BuildKit solve/export/push、Registry digest、K3s 与 HTTP、实际秘密挂载/缓存失效以及取消/故障后的结束证明。本次未启动容器或 VM、未升级数据库、未改生产代码，也未重跑既有 CI 或无障碍专项。

## 证据与官方资料

- [机器可读记录](s7-railpack-evaluation-20261029.json)：工具校验、15 个输入清单、参数、解析结果、退出码、输出文件字节数与 SHA-256，以及 canary 观察。
- 本机原始证据：.local/s7-builder-evaluation-20261029/native-20261029T091955Z-380000af/，含 evaluate.py、fixtures、runs、下载校验和临时缓存处置记录。原始证据保留在本机，没有上传到远端 CI。
- 固定源码资料：.local/s7-builder-evaluation-20261029/official-review/railpack-20261029T090347Z-9c739ffd/，含 release/tag/commit、官方校验和、源码，以及 railpack-official-review.final.md/.json 和 official-source-inventory.final.json。
- [官方生产运行说明（固定提交）](https://github.com/railwayapp/railpack/blob/c71ae09408996068bcc9cf685146f55d428ef816/docs/src/content/docs/platforms/running-railpack-in-production.mdx)；[prepare 实现](https://github.com/railwayapp/railpack/blob/c71ae09408996068bcc9cf685146f55d428ef816/cli/prepare.go)；[宿主 Mise 实现](https://github.com/railwayapp/railpack/blob/c71ae09408996068bcc9cf685146f55d428ef816/core/mise/mise.go)。
