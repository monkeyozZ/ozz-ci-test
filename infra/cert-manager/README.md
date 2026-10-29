# cert-manager 固定安装资产

平台使用 cert-manager **v1.21.3**。该版本于 2026-10-23 发布，官方支持并测试 Kubernetes **1.33–1.36**；本地 K3s 的 Kubernetes 1.35.9 在该范围内。支持范围来自 [官方版本页](https://cert-manager.io/docs/releases/)，版本信息来自 [官方 release](https://github.com/cert-manager/cert-manager/releases/tag/v1.21.3)。

`assets.lock.json` 记录 2026-10-26 核验的安装清单 URL、精确字节数、SHA256 和四个镜像的多架构 index digest，以及实际核验过的 Linux AMD64 / ARM64 子 manifest digest。镜像以 `tag@sha256` 固定，运行节点自行选择适合架构的子镜像。

完整官方 YAML 保存在 `packages/infrastructure/assets/cert-manager-v1.21.3.yaml`。文件保持上游原始字节，已排除 Prettier；不要格式化、追加换行或将其替换为自行精简的清单。文件为 1,034,826 bytes，含 47 个对象。最大的对象 JSON 为 146,637 bytes，安装请求必须显式使用有界的大对象额度，普通 Kubernetes 请求的默认额度保持原值。

上游 Apache-2.0 许可证随资产保存在 `LICENSE.cert-manager`，来源和校验摘要也记录在锁文件中。

运行时 `loadCertManagerManifests()` 只从基础设施包内读取，先校验长度和 SHA256，再解析 YAML，并检查每个对象不超过 1 MiB。它每次返回新的官方对象，adapter 负责添加归属 metadata、镜像 digest 和本地测试所需的 ACME solver 参数。安装时无需从互联网下载 YAML；节点首次拉取镜像仍需要访问镜像仓库。

基础设施包的 `files` 包含 `dist` 和 `assets`，因此 `pnpm deploy` 后安装文件仍与 helper 同包；运行时不依赖仓库根目录的 `infra`。

## 离线校验

从仓库根目录运行：

```sh
pnpm --filter @ozz/infrastructure build
pnpm exec node infra/cert-manager/verify-assets.mjs
pnpm exec vitest run tests/infrastructure/cert-manager-assets.test.ts
```

校验命令核对文件、运行时常量、锁文件、47 个官方对象及镜像引用。它不会访问 Kubernetes，也不会联网；输出的 `recordedPlatforms` 是锁文件内已核验的平台记录，不代表本次重新查询了 registry。

## 升级

升级时重新检查官方 Kubernetes 支持矩阵和 release 状态，按官方安装文档下载完整清单并核验 SHA256。对四个镜像分别获取 registry index，验证其 digest，并确认目标 CPU 架构的子 manifest 及 digest；不要把单一架构的 digest 用作跨架构安装默认值。将 YAML、锁文件、运行时常量和兼容范围作为同一项更改审阅，完成离线校验、adapter 测试和本地真实 K3s 安装验证后再发布。
