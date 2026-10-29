# S4 域名与 HTTPS 实施细化

日期：2026-10-26。本文细化已有 S4.01–S4.07，不代表功能已经实现或公网验收通过。依据为 [PRD F14](prd.md)、[技术方案 3.4](technical-plan.md#34-域名路由与-https)和 [Stitch E01/E02/G03](../designs/console-v2/stitch-screen-map.md)。用户已选择先本地测试，真实 VPS、域名、入口地址与 ACME 联系邮箱准备后再补公网验证。

## 实施顺序与职责

1. 持久化平台域名设置、集群入口设置和 Domain；补 API、OpenAPI、唯一性/引用/恢复锁约束。
2. 实现只读 DNS 诊断和固定目标的路由/证书 Adapter，接入现有 Operation、变更槽、资源回执与 Worker 恢复机制。
3. 完成真实本地 Traefik 路由和 cert-manager 兼容检查、签发/续期/失败状态；本地证书与公网可信证书分别留证。
4. 按 E01/E02/G03 实现平台设置、服务网络面板、分配/诊断/解绑流程，再通过浏览器和跨集群本地验收。
5. 资源就绪后验证真实 DNS、ACME staging、生产证书、续期、80/443 入口及管理域名同源 HTTPS。未完成前保留 S4 公网关口。

领域规则放入 `packages/control-plane` 的 Networking 模块，DNS/Kubernetes/证书协议封装在 `packages/infrastructure`，API 负责鉴权和契约。沿用 TypeScript/Node，不增加独立微服务、第二套队列或第二种服务部署目标。

## 数据与接口约束

| 对象 | 持久信息与约束 |
| --- | --- |
| PlatformSettings | 单例、revision、默认应用后缀、ACME 联系邮箱。管理入口来自现有部署配置，只读展示；保存应用后缀不修改 Caddy 管理域名 |
| 集群入口设置 | Cluster 外键、稳定子后缀、预期 IPv4/IPv6 或 CNAME 目标、Ingress 类与版本观察。未配置不推测公网 IP，不把 Kubernetes API 地址当作应用入口 |
| Domain | 全局唯一规范化 hostname、稳定 ID、目标 ServicePort、分配时的项目/环境/集群身份、期望启用/删除状态、revision、DNS/路由/证书独立观察及时间 |
| 网络资源台账 | Domain/环境归属、kind/namespace/name、UID、创建 nonce、已应用版本和删除确认。与工作负载台账的查询边界明确，不能把 cert-manager 生成的 Secret 当成未知运行期 Secret |
| Operation | 固定 hostname、Domain ID、Service ID、项目/环境/Cluster/kube-system UID、Namespace、具名端口、设置版本及原操作意图；执行时使用当前有效管理凭据 |

现有 `ServicePort` 已有稳定 ID，并按 `(serviceId, name)` 更新；域名应引用该身份，而不是只保存容器端口数字。绑定前核对可信已发布快照中的同名 HTTP 端口，拒绝将 TCP 端口或未发布草稿端口当作可路由后端。域名已绑定时，删除端口或改成 TCP 必须先明确解绑；错误指向具体域名。修改端口数字仍遵守草稿/发布分离，Ingress 按端口名称引用当前 Kubernetes Service。

域名转换为小写 ASCII/IDNA，校验标签与总长度，拒绝 URL、路径、通配符输入、IP 字面量和空标签。分配形如 `<service-slug>-<stable-id>.<cluster-label>.<apps-suffix>`，截短合法标签并有限处理碰撞，结果落库。显示名和 slug 编辑不能重新分配已有 hostname。已有域名时，普通设置修改不能静默迁移后缀；返回明确冲突及受影响对象，迁移另走后续显式流程。

设置读写使用现有 revision/Problem Details；列表按既有 cursor 分页并支持 project/environment/service/cluster 范围。创建/重新同步/解绑/签发环境切换为有幂等键的持久异步请求，返回 Operation 入口。API 接收成功不代表 DNS、路由或证书已经就绪。接口名和最终字段在实现时写入 `api-contract-s4.md` 并生成客户端，本文不冒充已存在的 API。

## 三组独立状态

| 状态 | 需要记录 | 不能据此推导 |
| --- | --- | --- |
| DNS | A/AAAA/CNAME 结果、预期入口、解析器/采集时间、未配置/匹配/错配/未找到/超时；有界跟随 CNAME 并识别循环 | DNS 匹配不能标记 Ingress 或证书成功；一次递归解析不能宣称全球传播完成 |
| 路由 | 受管 Ingress 身份与期望规则、具名端口、目标后端、已应用/等待后端/漂移/失联/删除中及时间 | 对象存在不能代替实际端到端响应；控制面不能成为应用数据流量代理 |
| 证书 | 签发环境、Certificate 条件、到期/续期时间、对应 Order/Challenge 的有界诊断、失败与观察时间 | staging 或本地 CA Ready 不能显示为公网可信；最后一次 Ready 不能覆盖实际过期或续期失败 |

DNS 查询有超时、并发与结果数上限，不从域名设置执行任意 shell。Kubernetes 观察只读，失联保留最后值并标注过期。诊断输出裁剪并脱敏，不返回 TLS 私钥、ACME 账户密钥、原始 kubeconfig 或任意事件/容器全文。

## 路由与证书生命周期

复用标准 `networking.k8s.io/v1` Ingress 和目标集群 Traefik。HTTP 重定向只作用于本次受管应用路由；不改既有集群的全局 entryPoint、CNI 或他人 Ingress。若使用 Traefik RedirectScheme Middleware，必须先确认其 CRD/权限，并让 cert-manager 独立的 HTTP-01 challenge 路由不继承重定向；用实际挑战路径测试验证。

cert-manager 按官方支持矩阵锁定兼容版本和发布资产。先检查已有 CRD、控制器版本、就绪与权限：已有安装不能覆盖重装，缺组件和不兼容分别报错；新安装是可观察、可重试的明确集群 Operation。安装过程中不获取任意远端脚本执行，也不以关闭证书验证解决连接失败。

应用证书由目标集群内 cert-manager 维护。生产配置使用固定的 ACME staging/production URL，首次上线保留 staging 验证记录再切换生产；生产切换是独立操作，不能只改 UI 标签。共享环境 Issuer/账户 Secret 与单个 Domain 的 Certificate/TLS Secret 区分归属，解绑不删除其他域名使用的资源。

网络变更与同服务发布/删除使用共同的持久变更槽，防止配置、端口和路由互相覆盖。任务恢复核对原目标、资源 UID/nonce 和设置版本，不能从当前页面或改后的后缀重新解释旧任务。外部漂移、新 UID 或未知归属必须留下诊断，不盲目覆盖或清理。

解绑先记录删除意图，再删除确认归属的路由和域名专属证书资源，具名读取确认消失后才能释放绑定。失败保留 Domain、资源台账与 Operation，重试原意图。服务删除复用同一清理过程；共享 Namespace、Issuer、账户密钥和手工 DNS 记录保留。只读观察不能重建已经请求删除的资源。

## UI 与本地验证

设置页沿用 G03，区分控制台地址、平台应用后缀和每集群入口；未保存/冲突反馈使用现有组件。服务网络页沿用 E01/E02，持续显示 Project → Environment → Cluster、具名端口、三组状态与更新时间。复制域名、查看 DNS 记录说明、打开可访问入口、检查任务、重试和解绑都有明确结果；未知入口不提供一个看似可用的公网链接。

本地 A/B 使用不同测试后缀和独立真实 Ingress，测试进程显式选择 DNS/Host 与 CA 信任材料，不改宿主机全局 DNS 或系统证书库。可验证默认域名稳定性、冲突、DNS 分类、实际 HTTP/HTTPS 路由、重定向、解绑、失败恢复及多集群隔离。使用本地 CA 或受控 ACME 测试端点时，报告必须写出该范围，不能记为 Let's Encrypt 生产签发成功。

验收至少包含：服务重命名不换域名；不同幂等键并发分配/解绑；绑定端口变更保护；Worker 中断恢复；资源被外部替换/丢失；A/B 路由不串服务；DNS 错配不影响另一组状态；staging/过期/续期失败可辨识；challenge 路径可达；服务删除与解绑部分失败重试；只删除受管对象；浏览器明暗/窄屏/键盘/迟到响应。最终检查与实际证据进入 `docs/acceptance/S4.md`。
