/*
 * HPM5301EVKLite SPI forwarding target for the akaLinkPro USB→SPI bridge.
 *
 * This board is the SPI slave. The probe's SPI2 master is wired pin-for-pin:
 *   PB10 CS, PB11 SCLK, PB13 MOSI, PB12 MISO, plus common GND.
 *
 * Mode 0, 8-bit, full duplex. The first 256-byte transfer returns a fixed
 * signature; after each transfer the received MOSI bytes become the next
 * response. A host can therefore verify MISO on frame 0 and verify the
 * preceding MOSI frame on every later transfer.
 */
#include <stdint.h>

#include "board.h"
#include "hpm_clock_drv.h"
#include "hpm_iomux.h"
#include "hpm_spi_drv.h"

#define SPI_TARGET HPM_SPI2
#define FRAME_BYTES 256U
#define SPI_MAGIC 0x53504945U /* 'SPIE' */
#define SPI_IRQ IRQn_SPI2

ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_magic;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_frames;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_errors;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_last_bytes;
ATTR_PLACE_AT_NONCACHEABLE_BSS volatile uint32_t g_spi_clock_hz;

static uint8_t s_tx_a[FRAME_BYTES];
static uint8_t s_rx_a[FRAME_BYTES];
static uint8_t *s_tx = s_tx_a;
static uint8_t *s_rx = s_rx_a;
static volatile uint32_t s_tx_pos;
static volatile uint32_t s_rx_pos;
static spi_control_config_t s_control;
static void fill_first_reply(uint8_t *tx);

static hpm_stat_t arm_next_transfer(void)
{
    const uint32_t interrupts = spi_tx_fifo_threshold_int |
                                spi_rx_fifo_threshold_int | spi_end_int;
    s_tx_pos = 0;
    s_rx_pos = 0;
    spi_disable_interrupt(SPI_TARGET, interrupts);

    const hpm_stat_t status = spi_control_init(SPI_TARGET, &s_control, FRAME_BYTES, FRAME_BYTES);
    if (status != status_success) return status;

    const uint32_t depth = spi_get_tx_fifo_size(SPI_TARGET);
    /* Wake with two free slots so the RISC-V ISR has margin before TX FIFO underflow. */
    spi_set_tx_fifo_threshold(SPI_TARGET, depth - 2U);
    spi_set_rx_fifo_threshold(SPI_TARGET, depth / 2U);
    spi_clear_interrupt_status(SPI_TARGET, interrupts);

    /* Prime TX before CS falls; polling spi_transfer() times out while an idle slave waits. */
    while (s_tx_pos < depth) SPI_TARGET->DATA = s_tx[s_tx_pos++];
    spi_enable_interrupt(SPI_TARGET, interrupts);
    return status_success;
}

SDK_DECLARE_EXT_ISR_M(SPI_IRQ, spi2_isr)
void spi2_isr(void)
{
    const uint32_t irq = spi_get_interrupt_status(SPI_TARGET);

    if (irq & spi_rx_fifo_threshold_int) {
        while (spi_get_rx_fifo_valid_data_size(SPI_TARGET) && s_rx_pos < FRAME_BYTES) {
            s_rx[s_rx_pos++] = (uint8_t)SPI_TARGET->DATA;
        }
        spi_clear_interrupt_status(SPI_TARGET, spi_rx_fifo_threshold_int);
    }

    if (irq & spi_tx_fifo_threshold_int) {
        const uint32_t depth = spi_get_tx_fifo_size(SPI_TARGET);
        while (spi_get_tx_fifo_valid_data_size(SPI_TARGET) < depth && s_tx_pos < FRAME_BYTES) {
            SPI_TARGET->DATA = s_tx[s_tx_pos++];
        }
        spi_clear_interrupt_status(SPI_TARGET, spi_tx_fifo_threshold_int);
    }

    if (irq & spi_end_int) {
        while (spi_get_rx_fifo_valid_data_size(SPI_TARGET) && s_rx_pos < FRAME_BYTES) {
            s_rx[s_rx_pos++] = (uint8_t)SPI_TARGET->DATA;
        }
        spi_disable_interrupt(SPI_TARGET, spi_tx_fifo_threshold_int |
                              spi_rx_fifo_threshold_int | spi_end_int);
        spi_clear_interrupt_status(SPI_TARGET, spi_end_int);
        if (s_rx_pos != FRAME_BYTES || s_tx_pos != FRAME_BYTES) {
            g_spi_errors++;
            fill_first_reply(s_tx);
        } else {
            /* Swap buffers instead of copying 256 bytes before re-arming the slave. */
            uint8_t *previous_tx = s_tx;
            s_tx = s_rx;
            s_rx = previous_tx;
            g_spi_frames++;
        }

        /* Do not reset the peripheral while the master's CS is still asserted. */
        while (spi_is_active(SPI_TARGET)) __asm volatile("nop");
        if (arm_next_transfer() != status_success) g_spi_errors++;
    }
}

static void init_spi2_slave_pins(void)
{
    /* Inputs are enabled on SCLK so the slave can sample the external clock. */
    const uint32_t fast_pad = IOC_PAD_PAD_CTL_PE_SET(0) | IOC_PAD_PAD_CTL_OD_SET(0) |
                              IOC_PAD_PAD_CTL_SR_SET(1) | IOC_PAD_PAD_CTL_SPD_SET(3) |
                              IOC_PAD_PAD_CTL_DS_SET(4);

    HPM_IOC->PAD[IOC_PAD_PB10].FUNC_CTL = IOC_PB10_FUNC_CTL_SPI2_CS_0;
    HPM_IOC->PAD[IOC_PAD_PB11].FUNC_CTL = IOC_PB11_FUNC_CTL_SPI2_SCLK | IOC_PAD_FUNC_CTL_LOOP_BACK_MASK;
    HPM_IOC->PAD[IOC_PAD_PB12].FUNC_CTL = IOC_PB12_FUNC_CTL_SPI2_MISO;
    HPM_IOC->PAD[IOC_PAD_PB13].FUNC_CTL = IOC_PB13_FUNC_CTL_SPI2_MOSI;

    HPM_IOC->PAD[IOC_PAD_PB10].PAD_CTL = IOC_PAD_PAD_CTL_PE_SET(1) | IOC_PAD_PAD_CTL_PS_SET(1);
    HPM_IOC->PAD[IOC_PAD_PB11].PAD_CTL = fast_pad;
    HPM_IOC->PAD[IOC_PAD_PB12].PAD_CTL = fast_pad;
    HPM_IOC->PAD[IOC_PAD_PB13].PAD_CTL = fast_pad;
}

static void fill_first_reply(uint8_t *tx)
{
    for (uint32_t i = 0; i < FRAME_BYTES; ++i) {
        tx[i] = (uint8_t)(0x5AU ^ (i * 37U));
    }
}

int main(void)
{
    spi_format_config_t format = {0};
    s_control = (spi_control_config_t){0};

    board_init();
    clock_add_to_group(clock_spi2, 0);
    init_spi2_slave_pins();
    intc_m_enable_irq_with_priority(SPI_IRQ, 1);

    g_spi_magic = SPI_MAGIC;
    g_spi_clock_hz = clock_get_frequency(clock_spi2);
    g_spi_last_bytes = FRAME_BYTES;
    fill_first_reply(s_tx);

    spi_slave_get_default_format_config(&format);
    format.common_config.data_len_in_bits = 8U;
    format.common_config.mode = spi_slave_mode;
    format.common_config.cpol = spi_sclk_low_idle;
    format.common_config.cpha = spi_sclk_sampling_odd_clk_edges;
    format.common_config.lsb = false;
    spi_format_init(SPI_TARGET, &format);

    spi_slave_get_default_control_config(&s_control);
    s_control.slave_config.slave_data_only = true;
    s_control.common_config.trans_mode = spi_trans_write_read_together;
    s_control.common_config.data_phase_fmt = spi_single_io_mode;

    while (arm_next_transfer() != status_success) g_spi_errors++;
    for (;;) __asm volatile("wfi");
}
