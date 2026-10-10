/* Continuous SPI2 TX-only benchmark. PB10/11/12/13 match probe SPI2.
 * 32 KiB circular word DMA, 64-byte SPIC sequence records, held CS.
 * Set g_spi_master_request_hz while stopped, then g_spi_master_run=1.
 */
#include <stdint.h>
#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_dma_mgr.h"
#include "hpm_gpio_drv.h"
#include "hpm_interrupt.h"
#include "hpm_iomux.h"
#include "hpm_misc.h"
#include "hpm_mchtmr_drv.h"
#include "hpm_spi_drv.h"

#define SPI HPM_SPI2
#define BUFFER_BYTES 32768U
#define HALF_BYTES (BUFFER_BYTES / 2U)
#define FRAME_BYTES 64U
#define CS_PORT GPIO_GET_PORT_INDEX(IOC_PAD_PB10)
#define CS_PIN GPIO_GET_PIN_INDEX(IOC_PAD_PB10)

ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_run;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_active;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_request_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_magic;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_chunks;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_errors;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_refill_late;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_frames;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_clock_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_sclk_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_source_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_clock_source;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_module_div;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_master_sclk_div;
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(16) static uint8_t s_tx[BUFFER_BYTES];
static dma_resource_t s_dma;
static volatile uint32_t s_pending;
static uint32_t s_sequence;

static void freed_half(uint32_t half)
{
    if (s_pending & (1U << half)) g_spi_master_refill_late++;
    s_pending |= 1U << half;
    g_spi_master_chunks++;
}
static void half_done(DMA_Type *base, uint32_t channel, void *data)
{ (void)base; (void)channel; (void)data; freed_half(0U); }
static void full_done(DMA_Type *base, uint32_t channel, void *data)
{ (void)base; (void)channel; (void)data; freed_half(1U); }
static void failed(DMA_Type *base, uint32_t channel, void *data)
{ (void)base; (void)channel; (void)data; g_spi_master_errors++; g_spi_master_run=0U; }

static void fill_half(uint32_t half)
{
    uint8_t *dst=&s_tx[half*HALF_BYTES];
    for(uint32_t frame=0;frame<HALF_BYTES/FRAME_BYTES;frame++,dst+=FRAME_BYTES) {
        const uint32_t q=s_sequence++;
        dst[0]='S';dst[1]='P';dst[2]='I';dst[3]='C';
        dst[4]=(uint8_t)q;dst[5]=(uint8_t)(q>>8);dst[6]=(uint8_t)(q>>16);dst[7]=(uint8_t)(q>>24);
        for(uint32_t i=8;i<FRAME_BYTES;i++)dst[i]=(uint8_t)((q+17U*i)^0x5AU);
    }
    g_spi_master_frames=s_sequence;
}
static void init_pins(void)
{
    const uint32_t fast=IOC_PAD_PAD_CTL_SR_SET(1)|IOC_PAD_PAD_CTL_SPD_SET(3)|IOC_PAD_PAD_CTL_DS_SET(4);
    HPM_IOC->PAD[IOC_PAD_PB10].FUNC_CTL=IOC_PB10_FUNC_CTL_GPIO_B_10;
    HPM_IOC->PAD[IOC_PAD_PB11].FUNC_CTL=IOC_PB11_FUNC_CTL_SPI2_SCLK|IOC_PAD_FUNC_CTL_LOOP_BACK_MASK;
    HPM_IOC->PAD[IOC_PAD_PB12].FUNC_CTL=IOC_PB12_FUNC_CTL_SPI2_MISO;
    HPM_IOC->PAD[IOC_PAD_PB13].FUNC_CTL=IOC_PB13_FUNC_CTL_SPI2_MOSI;
    for(uint32_t p=IOC_PAD_PB10;p<=IOC_PAD_PB13;p++)HPM_IOC->PAD[p].PAD_CTL=fast;
    gpio_set_pin_output_with_initial(HPM_GPIO0,CS_PORT,CS_PIN,1U);
}
static void stop_stream(void)
{
    gpio_write_pin(HPM_GPIO0,CS_PORT,CS_PIN,1U);
    spi_disable_tx_dma(SPI);
    dma_mgr_disable_channel(&s_dma);
    spi_reset(SPI);spi_transmit_fifo_reset(SPI);spi_receive_fifo_reset(SPI);
    (void)spi_poll_reset_complete(SPI,spi_reset_all,100000U);
    g_spi_master_active=0U;s_pending=0U;
}
static hpm_stat_t configure_clock(uint32_t want)
{
    uint32_t best=0U,best_module=0U,best_source=0U,best_d=0U,best_n=0U,best_freq=0U;
    /* Use existing PLL outputs only; never change CPU/shared PLL parameters.
     * Limit module clock to 240 MHz and record the actual rational divider. */
    for(uint32_t source=1;source<=7;source++) {
        const uint32_t freq=get_frequency_for_source((clock_source_t)source);
        if(!freq)continue;
        for(uint32_t d=1;d<=256;d++) {
            const uint32_t module=freq/d;
            if(module>240000000U)continue;
            for(uint32_t n=2;n<=510;n+=2) {
                const uint32_t actual=(uint32_t)((uint64_t)freq/((uint64_t)d*n));
                if(actual>want)continue;
                if(actual>best || (actual==best&&module>best_module)) {
                    best=actual;best_module=module;best_source=source;best_d=d;best_n=n;best_freq=freq;
                }
                break;
            }
        }
    }
    if(!best)return status_invalid_argument;
    hpm_stat_t st=clock_set_source_divider(clock_spi2,MAKE_CLK_SRC(CLK_SRC_GROUP_COMMON,best_source),best_d);
    if(st!=status_success)return st;
    clock_add_to_group(clock_spi2,0U);
    g_spi_master_clock_hz=clock_get_frequency(clock_spi2);
    g_spi_master_sclk_hz=best;g_spi_master_source_hz=best_freq;
    g_spi_master_clock_source=best_source;g_spi_master_module_div=best_d;g_spi_master_sclk_div=best_n;
    SPI->TIMING=SPI_TIMING_CS2SCLK_SET(spi_cs2sclk_half_sclk_4)|
                SPI_TIMING_CSHT_SET(spi_csht_half_sclk_12)|SPI_TIMING_SCLK_DIV_SET(best_n/2U-1U);
    return g_spi_master_clock_hz==best_module?status_success:status_fail;
}
static hpm_stat_t start_stream(void)
{
    stop_stream();
    hpm_stat_t st=configure_clock(g_spi_master_request_hz);
    if(st!=status_success)return st;
    s_sequence=0U;s_pending=0U;g_spi_master_chunks=0U;
    g_spi_master_errors=0U;g_spi_master_refill_late=0U;
    fill_half(0U);fill_half(1U);
    spi_format_config_t format={0};
    spi_master_get_default_format_config(&format);
    format.common_config.data_len_in_bits=8U;format.common_config.data_merge=true;
    format.common_config.cpol=spi_sclk_low_idle;format.common_config.cpha=spi_sclk_sampling_odd_clk_edges;
    spi_format_init(SPI,&format);
    spi_control_config_t control={0};spi_master_get_default_control_config(&control);
    control.common_config.trans_mode=spi_trans_write_only;
    st=spi_control_init(SPI,&control,0xFFFFFFFCU,1U);
    if(st!=status_success)return st;
    spi_set_tx_fifo_threshold(SPI,spi_get_tx_fifo_size(SPI)/2U);
    dma_mgr_chn_conf_t cfg;dma_mgr_get_default_chn_config(&cfg);
    cfg.src_width=cfg.dst_width=DMA_MGR_TRANSFER_WIDTH_WORD;
    cfg.src_mode=DMA_MGR_HANDSHAKE_MODE_NORMAL;cfg.dst_mode=DMA_MGR_HANDSHAKE_MODE_HANDSHAKE;
    cfg.src_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_INCREMENT;cfg.dst_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_FIXED;
    cfg.src_addr=core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)s_tx);
    cfg.dst_addr=(uint32_t)&SPI->DATA;cfg.size_in_byte=BUFFER_BYTES;
    cfg.en_dmamux=true;cfg.dmamux_src=HPM_DMA_SRC_SPI2_TX;cfg.en_infiniteloop=true;
    cfg.priority=DMA_MGR_CHANNEL_PRIORITY_HIGH;cfg.interrupt_mask=DMA_MGR_INTERRUPT_MASK_ALL;
    st=dma_mgr_setup_channel(&s_dma,&cfg);
    if(st!=status_success)return st;
    dma_mgr_enable_chn_irq(&s_dma,DMA_MGR_INTERRUPT_MASK_TC|DMA_MGR_INTERRUPT_MASK_HALF_TC|DMA_MGR_INTERRUPT_MASK_ERROR);
    dma_mgr_enable_dma_irq_with_priority(&s_dma,1U);
    dma_mgr_enable_channel(&s_dma);spi_enable_tx_dma(SPI);
    gpio_write_pin(HPM_GPIO0,CS_PORT,CS_PIN,0U);
    mchtmr_delay(HPM_MCHTMR,clock_get_frequency(clock_mchtmr0)/1000000U);
    st=spi_write_command(SPI,spi_master_mode,&control,NULL);
    if(st==status_success)g_spi_master_active=1U;
    return st;
}
int main(void)
{
    board_init();clock_add_to_group(clock_spi2,0U);init_pins();dma_mgr_init();
    g_spi_master_request_hz=20000000U;g_spi_master_magic=0x53504943U;
    if(dma_mgr_request_resource(&s_dma)!=status_success)for(;;){ }
    dma_mgr_install_chn_half_tc_callback(&s_dma,half_done,NULL);
    dma_mgr_install_chn_tc_callback(&s_dma,full_done,NULL);
    dma_mgr_install_chn_error_callback(&s_dma,failed,NULL);
    for(;;) {
        if(!g_spi_master_run&&g_spi_master_active)stop_stream();
        if(g_spi_master_run&&!g_spi_master_active) {
            if(start_stream()!=status_success){g_spi_master_errors++;g_spi_master_run=0U;stop_stream();}
        }
        if(g_spi_master_active) {
            const uint32_t lock=disable_global_irq(CSR_MSTATUS_MIE_MASK);
            const uint32_t pending=s_pending;s_pending=0U;restore_global_irq(lock);
            if(pending==3U)g_spi_master_refill_late++;
            if(pending&1U)fill_half(0U);
            if(pending&2U)fill_half(1U);
        }
    }
}
