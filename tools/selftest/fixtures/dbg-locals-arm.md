# ARM 局部变量回归快照

`dbg-locals-arm.elf` 取自提交 `0bf30f7` 的
`tools/target-firmware/stm32f103_dbgstress/fw.elf`。局部变量单元测试中的
CFI 序言、尾声和位置列表地址属于这份固定快照。

`make full_flow_f103ze` 会重新构建用户可下载的目标 ELF。编译器版本或
构建参数造成的地址变化不应覆盖单元测试的独立输入。更新此快照时，
应重新用 readelf 核对测试中的 CFI 和变量位置断言。
