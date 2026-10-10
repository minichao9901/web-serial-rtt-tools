/*
 * HPM5301EVKLite (RISC-V) · SEGGER RTT 吞吐测试固件
 *
 * 与 script_test/stm32h743_rtt_speed、stm32f103_rtt_speed 同一套量法：
 *   while(1) 里死循环发 "hello world!\n"，不加任何延时；RTT 上行缓冲用
 *   BLOCK_IF_FIFO_FULL —— 缓冲满就阻塞，于是"目标写多快"完全由"主机取多快"
 *   决定，主机读到的字节/秒就是 RTT 的实际交付率。
 *
 * HPM5301EVKLite 侧的三个要点：
 *   1. RTT 控制块与环形缓冲位于 DLM（默认链接地址 0x0008xxxx），对应 HPM5301
 *      RISC-V porting 的 RTT 扫描窗口；该芯片没有 D-cache，不需要做 cache clean。
 *   2. 主频由 board_init() 配置；本程序不额外更改时钟，g_hclk_mhz 上报实测频率。
 *   3. g_bytes/g_loops 是目标侧的产速计，主机除了读 RTT 还能取它来证明
 *      "瓶颈不在目标"。
 *
 * 控制块地址：构建后用 `riscv32-unknown-elf-nm` 查 `_SEGGER_RTT`，交给探针的
 * RTT 桥作为搜索起点（探针 HID CMD_RTT action 1 的 addr/size 参数）。
 */
#include <stdint.h>
#include <stdio.h>

#include "board.h"
#include "SEGGER_RTT.h"
#include "hpm_clock_drv.h"

volatile uint32_t g_bytes;      /* 目标已写入 RTT 的字节数 */
volatile uint32_t g_loops;      /* 写入调用次数 */
volatile uint32_t g_ms;         /* 毫秒计数（1ms 定时器回调） */
volatile uint32_t g_hclk_mhz;   /* 实测 CPU 频率 MHz */
volatile uint32_t g_cb_addr;    /* &_SEGGER_RTT，方便主机确认地址 */

extern SEGGER_RTT_CB _SEGGER_RTT;

static void ms_tick(void)
{
    g_ms++;
}

int main(void)
{
    board_init();
    board_init_led_pins();
    board_timer_create(1, ms_tick);

    g_hclk_mhz = (uint32_t)(clock_get_frequency(clock_cpu0) / 1000000U);
    g_cb_addr = (uint32_t)(uintptr_t)&_SEGGER_RTT;

    SEGGER_RTT_Init();
    SEGGER_RTT_ConfigUpBuffer(0, NULL, NULL, 0, SEGGER_RTT_MODE_BLOCK_IF_FIFO_FULL);
    SEGGER_RTT_WriteString(0, "\r\n=== HPM5301EVKLite RTT flood (BLOCK_IF_FIFO_FULL) ===\r\n");

    static const char msg[] = "hello world!\n";   /* 13 字节 */

    for (;;)
    {
        unsigned n = SEGGER_RTT_Write(0, msg, sizeof(msg) - 1U);

        g_bytes += n;
        g_loops++;
        if (((g_loops & 0x3FFFU) == 0U) && ((g_ms & 0x100U) != 0U))
        {
            board_led_toggle();
        }
    }
}
