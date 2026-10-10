/* Independent MISO test. Preload FIFO, then TX word DMA across CS windows.
 * Each arm emits exactly the 32 KiB known pattern; RX DMA only drains to a sink.
 */
#include <stdint.h>
#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_dma_mgr.h"
#include "hpm_iomux.h"
#include "hpm_misc.h"
#include "hpm_spi_drv.h"
#ifndef SPI_TEST_MODE
#define SPI_TEST_MODE 0
#endif
#define SPI HPM_SPI2
#define SIZE 32768U
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_tx_reset,g_tx_ready,g_tx_done,g_tx_errors,g_tx_fifo_errors,g_rx_laps,g_tx_module_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(16) static uint8_t buffer[SIZE];
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(4) static uint32_t sink;
static dma_resource_t tx,rx;
static void done(DMA_Type *b,uint32_t c,void *d){(void)b;(void)c;(void)d;g_tx_done=1;}
static void received(DMA_Type *b,uint32_t c,void *d){(void)b;(void)c;(void)d;g_rx_laps++;}
static void failed(DMA_Type *b,uint32_t c,void *d){(void)b;(void)c;(void)d;g_tx_errors++;}
static void arm(void)
{
    g_tx_ready=0;spi_disable_tx_dma(SPI);spi_disable_rx_dma(SPI);dma_mgr_disable_channel(&tx);dma_mgr_disable_channel(&rx);
    g_tx_done=g_tx_errors=g_tx_fifo_errors=g_rx_laps=0;
    spi_control_config_t control={0};spi_slave_get_default_control_config(&control);
    control.slave_config.slave_data_only=true;control.common_config.trans_mode=spi_trans_write_read_together;
    control.common_config.data_phase_fmt=spi_single_io_mode;
    if(spi_control_init(SPI,&control,1,1)!=status_success){g_tx_errors++;return;}
    const uint32_t depth=spi_get_tx_fifo_size(SPI);
    spi_set_tx_fifo_threshold(SPI,depth-4U);spi_set_rx_fifo_threshold(SPI,3U);
    for(uint32_t i=0;i<depth;i+=4U)SPI->DATA=*(uint32_t *)(buffer+i);
    dma_mgr_chn_conf_t c;dma_mgr_get_default_chn_config(&c);
    c.src_width=c.dst_width=DMA_MGR_TRANSFER_WIDTH_WORD;
    c.src_mode=DMA_MGR_HANDSHAKE_MODE_NORMAL;c.dst_mode=DMA_MGR_HANDSHAKE_MODE_HANDSHAKE;
    c.src_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_INCREMENT;c.dst_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_FIXED;
    c.src_addr=core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)(buffer+depth));c.dst_addr=(uint32_t)&SPI->DATA;
    c.size_in_byte=SIZE-depth;c.en_dmamux=true;c.dmamux_src=HPM_DMA_SRC_SPI2_TX;
    c.priority=DMA_MGR_CHANNEL_PRIORITY_HIGH;c.interrupt_mask=DMA_MGR_INTERRUPT_MASK_ALL;
    if(dma_mgr_setup_channel(&tx,&c)!=status_success){g_tx_errors++;return;}
    c.src_mode=DMA_MGR_HANDSHAKE_MODE_HANDSHAKE;c.dst_mode=DMA_MGR_HANDSHAKE_MODE_NORMAL;
    c.src_addr_ctrl=c.dst_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_FIXED;
    c.src_addr=(uint32_t)&SPI->DATA;c.dst_addr=core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)&sink);
    c.size_in_byte=SIZE;c.en_infiniteloop=true;c.dmamux_src=HPM_DMA_SRC_SPI2_RX;
    if(dma_mgr_setup_channel(&rx,&c)!=status_success){g_tx_errors++;return;}
    dma_mgr_enable_chn_irq(&tx,DMA_MGR_INTERRUPT_MASK_TC|DMA_MGR_INTERRUPT_MASK_ERROR);
    dma_mgr_enable_chn_irq(&rx,DMA_MGR_INTERRUPT_MASK_TC|DMA_MGR_INTERRUPT_MASK_ERROR);
    dma_mgr_enable_channel(&rx);dma_mgr_enable_channel(&tx);
    spi_enable_rx_dma(SPI);spi_enable_tx_dma(SPI);g_tx_reset=0;g_tx_ready=1;
}
int main(void)
{
    board_init();const uint32_t source=get_frequency_for_source(clock_source_pll0_clk0);
    if(source%240000000U || clock_set_source_divider(clock_spi2,clk_src_pll0_clk0,source/240000000U)!=status_success)for(;;){}
    clock_add_to_group(clock_spi2,0);g_tx_module_hz=clock_get_frequency(clock_spi2);
    HPM_IOC->PAD[IOC_PAD_PB10].FUNC_CTL=IOC_PB10_FUNC_CTL_SPI2_CS_0;
    HPM_IOC->PAD[IOC_PAD_PB11].FUNC_CTL=IOC_PB11_FUNC_CTL_SPI2_SCLK|IOC_PAD_FUNC_CTL_LOOP_BACK_MASK;
    HPM_IOC->PAD[IOC_PAD_PB12].FUNC_CTL=IOC_PB12_FUNC_CTL_SPI2_MISO;
    HPM_IOC->PAD[IOC_PAD_PB13].FUNC_CTL=IOC_PB13_FUNC_CTL_SPI2_MOSI;
    const uint32_t pad=IOC_PAD_PAD_CTL_SR_SET(1)|IOC_PAD_PAD_CTL_SPD_SET(3)|IOC_PAD_PAD_CTL_DS_SET(4);
    for(uint32_t p=IOC_PAD_PB11;p<=IOC_PAD_PB13;p++)HPM_IOC->PAD[p].PAD_CTL=pad;
    spi_format_config_t format={0};spi_slave_get_default_format_config(&format);
    format.common_config.data_len_in_bits=8;format.common_config.data_merge=true;
    format.common_config.cpol=(SPI_TEST_MODE&2)?spi_sclk_high_idle:spi_sclk_low_idle;
    format.common_config.cpha=(SPI_TEST_MODE&1)?spi_sclk_sampling_even_clk_edges:spi_sclk_sampling_odd_clk_edges;
    spi_format_init(SPI,&format);
    for(uint32_t i=0;i<SIZE;i++){const uint32_t n=i/256U,p=i%256U;buffer[i]=(uint8_t)(n*29U+p*73U+(p>>1)*11U);}
    dma_mgr_init();if(dma_mgr_request_resource(&rx)!=status_success||dma_mgr_request_resource(&tx)!=status_success)for(;;){}
    dma_mgr_install_chn_tc_callback(&tx,done,NULL);dma_mgr_install_chn_tc_callback(&rx,received,NULL);
    dma_mgr_install_chn_error_callback(&tx,failed,NULL);dma_mgr_install_chn_error_callback(&rx,failed,NULL);
    dma_mgr_enable_dma_irq_with_priority(&tx,1);arm();
    for(;;){if(g_tx_reset)arm();if(spi_get_interrupt_status(SPI)&spi_rx_fifo_overflow_int){g_tx_fifo_errors++;spi_clear_interrupt_status(SPI,spi_rx_fifo_overflow_int);}}
}
