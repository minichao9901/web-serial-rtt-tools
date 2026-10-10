# Copyright (c) 2026 akaInstruments
# SPDX-License-Identifier: BSD-2-Clause
#
# HPM5301EVKLite (RISC-V) 调试器压力测试靶子固件 —— 说明见 README.md

cmake_minimum_required(VERSION 3.13)

find_package(hpm-sdk REQUIRED HINTS $ENV{HPM_SDK_BASE})

project(hpm5301evklite_dbgstress)

sdk_compile_definitions(-DCONFIG_NDEBUG_CONSOLE=1)

# 本地 SDK 的 drivers/src/hpm_enet_drv.c 被改过，无条件 #include "trace_log.h"
# （RTT trace 那套工具的遗留），而该头文件只存在于 lwip_tcpecho 例程里。任何
# 新工程都会因为这个 include 编不过，这里把它的目录加进来（不改 SDK 本身）。
sdk_inc($ENV{HPM_SDK_BASE}/samples/lwip/lwip_tcpecho/src/TRACE_LOG)

sdk_app_src(src/main.c)
sdk_app_src(src/engine.c)
sdk_app_src(src/model.c)
sdk_app_src(../common/dbg_frames.c)

if(DEFINED HPM_FRAME_OPT)
    if(NOT HPM_FRAME_OPT MATCHES "^-O(g|s)$" OR NOT HPM_FRAME_DWARF MATCHES "^[45]$")
        message(FATAL_ERROR "HPM_FRAME_OPT/HPM_FRAME_DWARF must select -Og/-Os and DWARF4/5")
    endif()
    sdk_compile_options(${HPM_FRAME_OPT} -g3 -gdwarf-${HPM_FRAME_DWARF} -fasynchronous-unwind-tables)
endif()
