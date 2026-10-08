# HPM porting 重构后的 F103ZE 共用路径回归

日期：2026-10-09。测试提交：`890fe0c`。在独立 worktree `E:\web-serial-rtt-tools-hpm-porting` 运行，原目录工作文件没有修改。

## 结果

F103ZE 已通过真实网页和 akaLinkPro 探针完成下列回归。使用现有固件，没有擦写 Flash，没有注入故障。

- 认板：DP IDCODE `0x1BA01477`、CPUID `0x411FC231`、DEV_ID `0x414`，512 KiB Flash。
- 10 MHz SWD 连接成功，读取 23 个寄存器。HPM 板卡选择不会改变 ARM 后端，ARM 页面隐藏 HPM 选择行。
- HardFault 捕获位开启后可恢复完整 DEMCR 原值；异常现场读取前后 PC/LR/xPSR/SP/MSP/PSP 和 SCB 故障寄存器完全一致。
- 20 次继续/暂停全部通过，连续两次单步 PC 均前进；硬件断点比较器安装、删除及清理通过。
- 完整 512 KiB Flash 前后逐字节一致。
- 探针修复和恢复计数没有增加，网页未捕获错误为空；目标已恢复运行，探针已断开。

[机器可读判决](2026-10-09-f103ze-hpm-porting-results.json)。完整原始记录与固件读取副本仅保留在忽略目录 `tmp/f103ze-porting-acceptance/`，原始固件不提交。

## 验收范围

本次是真实 ARM 共用路径回归，不能替代 HPM 的 JTAG/DMI/SBA、ROM/XPI、Flash 算法机器码执行、各型号复位和启动验收。异常面板验证的是现有目标现场的只读性与捕获开关恢复，没有重复注入八种真实故障。

独立本地服务端口 8907、专用浏览器 CDP 9341；认板采用 `tools/selftest/read-idcode.mjs --board=f103ze`。设备选择事件未送达时，仅为本次本地来源复用了上次同一序列号探针的授权。测试脚本遗漏的 `DEV_RE` 导入已补上。
