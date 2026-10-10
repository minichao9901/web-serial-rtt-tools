/* HPM5301EVKLite SPI2 slave echo using HPM SDK DMA manager.
 *
 * PB10..PB13 and SPI2 slave mode match the akaLinkPro HPM5301 SPI bridge.
 * Every 256-byte Mode-0 transaction uses RX/TX DMA. The next MISO frame echoes
 * the preceding MOSI frame so the browser can verify each byte at every SCLK.
 */
#include <stdint.h>

#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_dma_mgr.h"
#include "hpm_iomux.h"
#include "hpm_spi.h"
#include "hpm_spi_drv.h"

#define SPI_TARGET HPM_SPI2
#define SPI_MODULE_CLOCK_HZ 240000000UL
#define FRAME_BYTES 256U
#define SPI_MAGIC 0x53445049U /* 'IPDS' */
#ifndef SPI_TEST_MODE
#define SPI_TEST_MODE 0
#endif

ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_magic;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_frames;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_errors;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_last_bytes;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_clock_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_rx_fifo_errors;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_irq_status;

ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(16) static uint8_t s_tx_a[FRAME_BYTES];
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(16) static uint8_t s_rx_a[FRAME_BYTES];
static uint8_t *s_tx = s_tx_a;
static uint8_t *s_rx = s_rx_a;
static volatile bool s_tx_done;
static volatile bool s_rx_done;
static dma_resource_t s_tx_dma,s_rx_dma;

static void rx_done(DMA_Type *base,uint32_t channel,void *user)
{
    (void)base;(void)channel;(void)user;
    s_rx_done = true;
}

static void tx_done(DMA_Type *base,uint32_t channel,void *user)
{
    (void)base;(void)channel;(void)user;
    s_tx_done = true;
}

static void dma_failed(DMA_Type *base,uint32_t channel,void *user)
{ (void)base;(void)channel;(void)user;g_spi_errors++; }

static hpm_stat_t arm_dma(bool tx)
{
    dma_resource_t *resource=tx?&s_tx_dma:&s_rx_dma;
    dma_mgr_disable_channel(resource);
    dma_mgr_chn_conf_t c;dma_mgr_get_default_chn_config(&c);
    c.src_width=c.dst_width=DMA_MGR_TRANSFER_WIDTH_WORD;
    c.src_mode=tx?DMA_MGR_HANDSHAKE_MODE_NORMAL:DMA_MGR_HANDSHAKE_MODE_HANDSHAKE;
    c.dst_mode=tx?DMA_MGR_HANDSHAKE_MODE_HANDSHAKE:DMA_MGR_HANDSHAKE_MODE_NORMAL;
    c.src_addr_ctrl=tx?DMA_MGR_ADDRESS_CONTROL_INCREMENT:DMA_MGR_ADDRESS_CONTROL_FIXED;
    c.dst_addr_ctrl=tx?DMA_MGR_ADDRESS_CONTROL_FIXED:DMA_MGR_ADDRESS_CONTROL_INCREMENT;
    c.src_addr=tx?core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)(s_tx+4)):(uint32_t)&SPI_TARGET->DATA;
    c.dst_addr=tx?(uint32_t)&SPI_TARGET->DATA:core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)s_rx);
    c.size_in_byte=tx?FRAME_BYTES-4U:FRAME_BYTES;
    c.en_dmamux=true;c.dmamux_src=tx?HPM_DMA_SRC_SPI2_TX:HPM_DMA_SRC_SPI2_RX;
    c.priority=DMA_MGR_CHANNEL_PRIORITY_HIGH;c.interrupt_mask=DMA_MGR_INTERRUPT_MASK_ALL;
    hpm_stat_t st=dma_mgr_setup_channel(resource,&c);
    if(st!=status_success)return st;
    dma_mgr_enable_chn_irq(resource,DMA_MGR_INTERRUPT_MASK_TC|DMA_MGR_INTERRUPT_MASK_ERROR);
    return dma_mgr_enable_channel(resource);
}

static uint32_t configure_spi2_clock(void)
{
    /* Match the probe: SPI2 module clock is PLL0CLK0 / an exact divider = 240 MHz. */
    const uint32_t source = get_frequency_for_source(clock_source_pll0_clk0);
    if (source < SPI_MODULE_CLOCK_HZ || (source % SPI_MODULE_CLOCK_HZ) != 0U) return 0U;
    const uint32_t divider = source / SPI_MODULE_CLOCK_HZ;
    if (divider > 256U || clock_set_source_divider(clock_spi2, clk_src_pll0_clk0, divider) != status_success) return 0U;
    clock_add_to_group(clock_spi2, 0U);
    const uint32_t actual = clock_get_frequency(clock_spi2);
    return actual == SPI_MODULE_CLOCK_HZ ? actual : 0U;
}

static void init_spi2_slave_pins(void)
{
    /* Same PB10 CS0, PB11 SCLK input path, PB12 MISO, PB13 MOSI as probe firmware. */
    const uint32_t fast = IOC_PAD_PAD_CTL_PE_SET(0) | IOC_PAD_PAD_CTL_PS_SET(0) |
                          IOC_PAD_PAD_CTL_OD_SET(0) | IOC_PAD_PAD_CTL_SR_SET(1) |
                          IOC_PAD_PAD_CTL_SPD_SET(3) | IOC_PAD_PAD_CTL_DS_SET(4);
    HPM_IOC->PAD[IOC_PAD_PB10].FUNC_CTL = IOC_PB10_FUNC_CTL_SPI2_CS_0;
    HPM_IOC->PAD[IOC_PAD_PB11].FUNC_CTL = IOC_PB11_FUNC_CTL_SPI2_SCLK | IOC_PAD_FUNC_CTL_LOOP_BACK_MASK;
    HPM_IOC->PAD[IOC_PAD_PB12].FUNC_CTL = IOC_PB12_FUNC_CTL_SPI2_MISO;
    HPM_IOC->PAD[IOC_PAD_PB13].FUNC_CTL = IOC_PB13_FUNC_CTL_SPI2_MOSI;
    HPM_IOC->PAD[IOC_PAD_PB11].PAD_CTL = fast;
    HPM_IOC->PAD[IOC_PAD_PB12].PAD_CTL = fast;
    HPM_IOC->PAD[IOC_PAD_PB13].PAD_CTL = fast;
}

static void fill_first_reply(uint8_t *tx)
{
    for (uint32_t i = 0; i < FRAME_BYTES; ++i) tx[i] = (uint8_t)(0x5AU ^ (i * 37U));
}

int main(void)
{
    spi_format_config_t format = {0};
    spi_control_config_t control = {0};
    board_init();
    g_spi_clock_hz = configure_spi2_clock();
    if (!g_spi_clock_hz) {
        g_spi_errors++;
        for (;;) { __asm volatile("wfi"); }
    }
    init_spi2_slave_pins();
    dma_mgr_init();

    /* Match akaLinkPro spi_cdc.start() register configuration exactly. */
    spi_slave_get_default_format_config(&format);
    format.master_config.addr_len_in_bytes = 1U;
    format.common_config.data_len_in_bits = 8U;
    format.common_config.data_merge = true;
    format.common_config.lsb = false;
    format.common_config.cpol = (SPI_TEST_MODE&2)?spi_sclk_high_idle:spi_sclk_low_idle;
    format.common_config.cpha = (SPI_TEST_MODE&1)?spi_sclk_sampling_even_clk_edges:spi_sclk_sampling_odd_clk_edges;
    spi_format_init(SPI_TARGET, &format);

    spi_slave_get_default_control_config(&control);
    control.slave_config.slave_data_only = true;
    control.common_config.trans_mode = spi_trans_write_read_together;
    control.common_config.data_phase_fmt = spi_single_io_mode;
    if (spi_control_init(SPI_TARGET, &control, 1U, 1U) != status_success ||
        dma_mgr_request_resource(&s_rx_dma)!=status_success || dma_mgr_request_resource(&s_tx_dma)!=status_success) {
        g_spi_errors++;
        for (;;) { __asm volatile("wfi"); }
    }
    dma_mgr_install_chn_tc_callback(&s_rx_dma,rx_done,NULL);
    dma_mgr_install_chn_tc_callback(&s_tx_dma,tx_done,NULL);
    dma_mgr_install_chn_error_callback(&s_rx_dma,dma_failed,NULL);
    dma_mgr_install_chn_error_callback(&s_tx_dma,dma_failed,NULL);
    dma_mgr_enable_dma_irq_with_priority(&s_rx_dma,1U);

    g_spi_magic = SPI_MAGIC;
    g_spi_last_bytes = FRAME_BYTES;
    fill_first_reply(s_tx);
    for (;;) {
        s_tx_done = false;
        s_rx_done = false;
        spi_disable_tx_dma(SPI_TARGET);spi_disable_rx_dma(SPI_TARGET);
        if(spi_control_init(SPI_TARGET,&control,FRAME_BYTES,FRAME_BYTES)!=status_success){g_spi_errors++;continue;}
        spi_set_tx_fifo_threshold(SPI_TARGET,spi_get_tx_fifo_size(SPI_TARGET)-4U);
        spi_set_rx_fifo_threshold(SPI_TARGET,3U);
        /* Prime the first four bytes before CS. DATAMERGE preserves 8-bit wire units. */
        SPI_TARGET->DATA=*(const uint32_t *)s_tx;
        if(arm_dma(false)!=status_success||arm_dma(true)!=status_success){g_spi_errors++;continue;}
        spi_enable_rx_dma(SPI_TARGET);spi_enable_tx_dma(SPI_TARGET);
        /* The slave remains armed until the master asserts CS; do not time out or reinit it. */
        while (!s_tx_done || !s_rx_done) {
            g_spi_irq_status=spi_get_interrupt_status(SPI_TARGET);
            if(g_spi_irq_status&spi_rx_fifo_overflow_int){g_spi_rx_fifo_errors++;spi_clear_interrupt_status(SPI_TARGET,spi_rx_fifo_overflow_int);}
        }
        while (spi_is_active(SPI_TARGET)) { __asm volatile("nop"); }
        uint8_t *previous_tx = s_tx;
        s_tx = s_rx;
        s_rx = previous_tx;
        g_spi_frames++;
    }
}
