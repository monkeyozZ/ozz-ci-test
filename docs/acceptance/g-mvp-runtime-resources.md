# 当前本地运行环境资源观察

日期：2026-10-29。**5 次只读采样通过**，首末采样间隔约 20 秒；API/Worker、PostgreSQL/Redis 容器及 Builder 的身份保持，前后均就绪。A/B 与 Builder 运行，C 停止。未启动额外负载。

| 组件 | 观测到的最大内存 | CPU 观察 |
| --- | ---: | --- |
| API | 47.56 MiB RSS | 单进程累计 CPU 差值约占一个核的 0.40% |
| Worker | 203.45 MiB RSS | 单进程累计 CPU 差值约占一个核的 10.46% |
| PostgreSQL | 223 MiB Docker working set | Docker 显示的样本峰值 11.04% |
| Redis | 16.39 MiB Docker working set | Docker 显示的样本峰值 4.61% |
| Builder Node | 62.96 MiB RSS | 整个 Builder cgroup 的累计 CPU 差值约占一个核的 0.12% |

Builder 的 systemd 主进程是 `flock`，其 RSS 为 1.72 MiB；实际 Node 子进程单独采集。整个 Builder 服务 cgroup 的内存最大约 273.38 MiB，包含缓存等其他记账，不能与进程 RSS 直接相加。Builder guest 的最小 MemAvailable 约 1.64 GiB。

Mac RSS、Docker 的近似 working set、服务 cgroup 和整台 guest 的内存属于不同范围；CPU 指标也分别保留累计差值与 Docker 采样口径。[机器结果](g-mvp-runtime-resources-results.json)保存原始样本、限额、磁盘、身份与工具摘要，首轮仅采到 `flock` RSS 的记录保留并注明范围。

这段观察补充 L08 的当前运行环境证据，不替代持续负载、日志增长、Console/Vite/代理或 Docker VM 开销、应用集群容量和 Oracle/VPS 验收，也不把不同层次的数值相加作为控制面的物理内存总量。
