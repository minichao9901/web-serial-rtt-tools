/** EVKLite J3 physical pin numbers. Shared by SPI, I2C and ADC diagrams.
 * Rows: [J3 pin, label, role, note, SPI auxiliary protocol index]. */
export const EVKLITE_J3 = [
      [1, '3V3', 'pwr', '', 0], [2, '5V0', 'pwr', '', 0],
      [3, 'PB09', 'vcom', 'VCOM RX (UART2)', 0], [4, '5V0', 'pwr', '', 0],
      [5, 'PB08', 'vcom', 'VCOM TX (UART2)', 0], [6, 'GND', 'gnd', '', 0],
      [7, 'PA02', 'aux', '', 5], [8, 'PB15', 'spi', 'D3 / IO3', 0],
      [9, 'GND', 'gnd', '', 0], [10, 'PB14', 'spi', 'D2 / IO2', 0],
      [11, 'PA31', 'aux', 'USB0_ID net', 13], [12, 'NC', 'nc', '', 0],
      [13, 'PB11', 'spi', 'SCLK', 1], [14, 'GND', 'gnd', '', 0],
      [15, 'NC', 'nc', '', 0], [16, 'NC', 'nc', '', 0],
      [17, '3V3', 'pwr', '', 0], [18, 'NC', 'nc', '', 0],
      [19, 'PA29', 'i2c', 'I2C 桥 SCL', 17], [20, 'GND', 'gnd', '', 0],
      [21, 'PA28', 'i2c', 'I2C 桥 SDA', 16], [22, 'NC', 'nc', '', 0],
      [23, 'PA27', 'no', '目标 NRST 专用（开漏/推挽）', 15], [24, 'PA26', 'aux', '原 SPI1 CS0', 14],
      [25, 'GND', 'gnd', '', 0], [26, 'PB10', 'spi', 'CS', 4],
      [27, 'PB12', 'spi', 'D1 / MISO', 2], [28, 'PB13', 'spi', 'D0 / MOSI', 3],
      [29, 'PY00', 'no', 'PIOC domain', 9], [30, 'GND', 'gnd', '', 0],
      [31, 'PY01', 'no', 'PIOC domain', 10], [32, 'PA09', 'aux', 'USER key', 6],
      [33, 'PA10', 'no', 'board LED', 11], [34, 'GND', 'gnd', '', 0],
      [35, 'NC', 'nc', '', 0], [36, 'PA00', 'no', 'log UART0', 7],
      [37, 'PA30', 'no', 'USB0_PWR + Q1', 12], [38, 'PA01', 'no', 'log UART0', 8],
      [39, 'GND', 'gnd', '', 0], [40, 'NC', 'nc', '', 0],
    ].map(pin=>Object.freeze(pin));
Object.freeze(EVKLITE_J3);
