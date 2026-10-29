# 控制面备份快照观察增量

日期：2026-10-29。**备份工具增量验证通过**，完整 Builder/K3s 联合恢复计时另行记录，S6/G-MVP 总验收仍在进行。

正式备份现在保存导出快照标识、完整 PostgreSQL MVCC 可见性边界、数据库时间上下界，以及备份进程自己的单调耗时。观察记录与数据库归档摘要一起计算校验和，两份配对清单共同保留；恢复前校验，成功收据沿用该引用。旧格式 1 备份仍可恢复。字段说明及命令见[恢复手册](../control-plane-recovery.md)。

精确的逻辑可见集合不等于无误差的物理时间。`createdAt` 仍为备份完成标签，`exactAcquisitionTimeKnown=false`；墙钟倒退会明确标记，不能据此计算时间界限。

Node 24 的 **6 项边界单测、11 项真实 PostgreSQL 回归**通过，后者执行前后源码一致。真实并发场景使用正式 exporter/dumper，确认导出前已提交的行恢复成功，而导出时未提交及导出后提交的行均被排除；该场景的配对清单由测试组装。正式 CLI 备份/恢复、旧清单兼容、畸形或错配观察在导入前拒绝、截断归档事务回滚另有实际检查。详见[机器结果](g-mvp-snapshot-observation-results.json)。

[备份工具补充包](../../.local/local-lab/linux-build-c/artifacts/s6-recovery-tools-20261029-snapshot-observation.tar.gz)为 22,420 字节，SHA256 为 `b786f370d790453a6aaca329c93b3c83a05285254275646bd309dcba71a10c3b`。七个文件逐字节核对、两个解压后入口加载通过；57 份显式库存形成的 94 个已知秘密模式无命中，不覆盖未知秘密。

此增量晚于 [L07 冻结交付](S6-deployment.md)，单独提供宿主机备份工具。原四镜像、Builder 包、源码归档和历史失败保持不变。
