/* Independent MOSI verification: same RX-only cyclic DMA as probe SPI->CDC.
 * Probe sends 128 x 256 B deterministic frames. g_verify=1 checks all 32 KiB.
 */
#include <stdint.h>
#include <string.h>
#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_dma_mgr.h"
#include "hpm_interrupt.h"
#include "hpm_iomux.h"
#include "hpm_misc.h"
#include "hpm_spi_drv.h"
#define SPI HPM_SPI2
#define SIZE 32768U
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_rx_reset,g_rx_ready,g_verify,g_verified;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_rx_bytes,g_rx_laps,g_rx_errors,g_rx_fifo_errors;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_rx_bad_bytes,g_rx_bad_bits,g_rx_first_bad;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_rx_module_hz;
ATTR_PLACE_AT_NONCACHEABLE_BSS_WITH_ALIGNMENT(16) static uint8_t buffer[SIZE];
static dma_resource_t dma;
static void done(DMA_Type *b,uint32_t c,void *d){(void)b;(void)c;(void)d;g_rx_laps++;}
static void failed(DMA_Type *b,uint32_t c,void *d){(void)b;(void)c;(void)d;g_rx_errors++;}
static uint32_t popcount(uint32_t x){x-=((x>>1)&85);x=(x&51)+((x>>2)&51);return (x+(x>>4))&15;}
static void arm(void)
{
    g_rx_ready=0;spi_disable_rx_dma(SPI);dma_mgr_disable_channel(&dma);
    memset(buffer,0,SIZE);g_rx_laps=g_rx_bytes=g_rx_errors=g_rx_fifo_errors=0;
    g_rx_bad_bytes=g_rx_bad_bits=g_verified=0;g_rx_first_bad=0xffffffffU;
    spi_control_config_t control={0};spi_slave_get_default_control_config(&control);
    control.slave_config.slave_data_only=true;control.common_config.trans_mode=spi_trans_write_read_together;
    control.common_config.data_phase_fmt=spi_single_io_mode;
    if(spi_control_init(SPI,&control,1,1)!=status_success){g_rx_errors++;return;}
    dma_mgr_chn_conf_t c;dma_mgr_get_default_chn_config(&c);
    c.src_width=c.dst_width=DMA_MGR_TRANSFER_WIDTH_BYTE;
    c.src_mode=DMA_MGR_HANDSHAKE_MODE_HANDSHAKE;c.dst_mode=DMA_MGR_HANDSHAKE_MODE_NORMAL;
    c.src_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_FIXED;c.dst_addr_ctrl=DMA_MGR_ADDRESS_CONTROL_INCREMENT;
    c.src_addr=(uint32_t)&SPI->DATA;c.dst_addr=core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)buffer);
    c.size_in_byte=SIZE;c.en_dmamux=true;c.dmamux_src=HPM_DMA_SRC_SPI2_RX;c.en_infiniteloop=true;
    c.priority=DMA_MGR_CHANNEL_PRIORITY_HIGH;c.interrupt_mask=DMA_MGR_INTERRUPT_MASK_ALL;
    if(dma_mgr_setup_channel(&dma,&c)!=status_success){g_rx_errors++;return;}
    dma_mgr_enable_chn_irq(&dma,DMA_MGR_INTERRUPT_MASK_TC|DMA_MGR_INTERRUPT_MASK_ERROR);
    dma_mgr_enable_channel(&dma);spi_enable_rx_dma(SPI);g_rx_reset=0;g_rx_ready=1;
}
int main(void)
{
    board_init();const uint32_t source=get_frequency_for_source(clock_source_pll0_clk0);
    if(source%240000000U || clock_set_source_divider(clock_spi2,clk_src_pll0_clk0,source/240000000U)!=status_success)for(;;){}
    clock_add_to_group(clock_spi2,0);g_rx_module_hz=clock_get_frequency(clock_spi2);
    HPM_IOC->PAD[IOC_PAD_PB10].FUNC_CTL=IOC_PB10_FUNC_CTL_SPI2_CS_0;
    HPM_IOC->PAD[IOC_PAD_PB11].FUNC_CTL=IOC_PB11_FUNC_CTL_SPI2_SCLK|IOC_PAD_FUNC_CTL_LOOP_BACK_MASK;
    HPM_IOC->PAD[IOC_PAD_PB12].FUNC_CTL=IOC_PB12_FUNC_CTL_SPI2_MISO;
    HPM_IOC->PAD[IOC_PAD_PB13].FUNC_CTL=IOC_PB13_FUNC_CTL_SPI2_MOSI;
    const uint32_t pad=IOC_PAD_PAD_CTL_SR_SET(1)|IOC_PAD_PAD_CTL_SPD_SET(3)|IOC_PAD_PAD_CTL_DS_SET(4);
    for(uint32_t p=IOC_PAD_PB11;p<=IOC_PAD_PB13;p++)HPM_IOC->PAD[p].PAD_CTL=pad;
    spi_format_config_t format={0};spi_slave_get_default_format_config(&format);
    format.common_config.data_len_in_bits=8;format.common_config.cpol=spi_sclk_low_idle;format.common_config.cpha=spi_sclk_sampling_odd_clk_edges;
    spi_format_init(SPI,&format);dma_mgr_init();if(dma_mgr_request_resource(&dma)!=status_success)for(;;){}
    dma_mgr_install_chn_tc_callback(&dma,done,NULL);dma_mgr_install_chn_error_callback(&dma,failed,NULL);
    dma_mgr_enable_dma_irq_with_priority(&dma,1);arm();
    for(;;){
        if(g_rx_reset)arm();
        const uint32_t lock=disable_global_irq(CSR_MSTATUS_MIE_MASK);
        uint32_t offset=dma.base->CHCTRL[dma.channel].DSTADDR-core_local_mem_to_sys_address(BOARD_RUNNING_CORE,(uint32_t)buffer);
        if(offset<=SIZE)g_rx_bytes=g_rx_laps*SIZE+offset;
        restore_global_irq(lock);
        if(spi_get_interrupt_status(SPI)&spi_rx_fifo_overflow_int){g_rx_fifo_errors++;spi_clear_interrupt_status(SPI,spi_rx_fifo_overflow_int);}
        if(g_verify){
            uint32_t bad=0,bits=0,first=0xffffffffU;
            for(uint32_t i=0;i<SIZE;i++){
                const uint32_t frame=i/256U,pos=i%256U;
                const uint8_t expected=(uint8_t)(frame*29U+pos*73U+(pos>>1)*11U);
                const uint32_t diff=buffer[i]^expected;
                if(diff){if(first==0xffffffffU)first=i;bad++;bits+=popcount(diff);}
            }
            g_rx_bad_bytes=bad;g_rx_bad_bits=bits;g_rx_first_bad=first;g_verify=0;g_verified=1;
        }
    }
}
