# Copyright (c) 2026 akaInstruments
# SPDX-License-Identifier: BSD-2-Clause

cmake_minimum_required(VERSION 3.13)

find_package(hpm-sdk REQUIRED HINTS $ENV{HPM_SDK_BASE})

project(hpm5301evklite_spi_echo)

sdk_compile_definitions(-DCONFIG_NDEBUG_CONSOLE=1)
sdk_inc($ENV{HPM_SDK_BASE}/samples/lwip/lwip_tcpecho/src/TRACE_LOG)
sdk_app_src(src/main.c)
