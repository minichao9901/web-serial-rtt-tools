cmake_minimum_required(VERSION 3.13)

set(CONFIG_HPM_SPI 1)
set(CONFIG_DMA_MGR 1)
find_package(hpm-sdk REQUIRED HINTS $ENV{HPM_SDK_BASE})

project(hpm5301evklite_spi_master_dma)

sdk_compile_definitions(-DCONFIG_NDEBUG_CONSOLE=1)
sdk_app_src(src/main.c)
