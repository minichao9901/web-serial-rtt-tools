# Copyright (c) 2026 akaInstruments
# SPDX-License-Identifier: BSD-2-Clause

cmake_minimum_required(VERSION 3.13)

set(CONFIG_SEGGER_RTT 1)

find_package(hpm-sdk REQUIRED HINTS $ENV{HPM_SDK_BASE})

project(hpm5301evklite_rtt_flood)

sdk_compile_definitions(-DCONFIG_NDEBUG_CONSOLE=1)
# 32 KB 上行缓冲：足够大才能把"目标产速"和"探针取速"解耦，测出来的才是交付率
sdk_compile_definitions(-DBUFFER_SIZE_UP=32768)

# 本地 SDK 的 drivers/src/hpm_enet_drv.c 被改过，无条件 #include "trace_log.h"
# （RTT trace 那套工具的遗留），而该头文件只存在于 lwip_tcpecho 例程里。任何
# 新工程都会因为这个 include 编不过，这里把它的目录加进来（不改 SDK 本身）。
sdk_inc($ENV{HPM_SDK_BASE}/samples/lwip/lwip_tcpecho/src/TRACE_LOG)

sdk_app_src(src/main.c)
