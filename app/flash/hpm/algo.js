/**
 * HPM 系列 flashloader（RV32）—— **自动生成，别手改**。
 * 生成：pwsh -File tools/target-firmware/hpm_flash_algo/build.ps1
 * 出处/许可/入口表语义见 tools/target-firmware/hpm_flash_algo/README.md。
 *
 * 尺寸 1388 B（0x56c），加载地址 0x00000000。
 * 🚨 入口表**没有固定步长**（ebreak 汇编成 2 字节的 c.ebreak，实测每项 6 B）——
 *    偏移由 app/flash/hpm/entry.js 在运行时从 blob 里走一遍 jal 发现，
 *    symbols 是构建时从 ELF 取的真值，自测拿它逐项对账。
 */
import { relocateAlgoBytes } from './entry.js';
export const HPM_ALGO = {
  loadAddr: 0x00000000,
  size: 1388,
  /** Internal GOT pointers, generated from ELF .got for runtime relocation. */
  relocations: [
    { offset: 0x554, target: 0x440 },
    { offset: 0x558, target: 0x438 },
    { offset: 0x55c, target: 0x43c },
    { offset: 0x560, target: 0x434 },
  ],
  /** 构建时的符号地址（仅供自测对账，运行时不依赖它）*/
  symbols: {
    flash_init: 0x50,
    flash_erase: 0x126,
    flash_program: 0x23a,
    flash_read: 0x27e,
    flash_get_info: 0x2c2,
    flash_erase_chip: 0x2e0,
    flash_deinit: 0x318,
  },
  /** xpi_nor_config_option_t 头字：words(4bit) | tag(0xfcf90) << 12 */
  headerWords1: 0xFCF90001,
  headerWords2: 0xFCF90002,
  headerWords0: 0xFCF90000,
  b64: [
    '7wAABQKQ7wAAEgKQ7wDgIgKQ7wDAJgKQ7wCgKgKQ7wAgLAKQ7wBALwKQnEEFR72LY3/3AJxFBWcTBwfw+Y8TBwAQY5bnACMg',
    'BQYjIgUGgoA5cUrYFwkAAAMpiVCDRwkAJtoG3iLcTtZS1FbSWtCXBAAAg6QkT5jAwe8ui7KKNoTBIYFHkwnBAFFHs4b5ACOA',
    'BgCFB+Ob5/6BRxcKAAADKqpLEwcAELOGRwEjgAYAhQfjm+f+IsodgAmIlwcAAIOn50mAwzcEAiATBATwXEiIQFrG/EdWyE6G',
    'lwUAAIOlxUeClwXpWEi3BwFWk4f3LxRDY/XXADxbiECCl4hAzoU1N4NHCQAjCgoCgeeFRyMA+QABRfJQYlTSVEJZslkiWpJa',
    'AlshYYKAtwcCIJOHB/DYS3lxStAyiRBDtwcBVgbWItQm0k7OUsxWypOH9y+uhmP0xwCzhqUAFwYAAAMm5j+DVIYCqgRjbpkK',
    'M/qWArOJREFjhzQDlwUAAIOlRT4XBQAAAyVFPhxPjEEIQU6HNsaClyqEUemyRjMJmUBSmc6WSoQ3CQIglwkAAIOpSTsXCgAA',
    'AypKOxMJCfCXCgAAg6rKOWPhhAQtwLcHAiCThwfw3Esih5cFAACDpWU4IlQXBQAAAyVFOLJQklQCWfJJYkrSSpxPjEEIQRcG',
    'AAADJuY1RWGCh4MnSQGDpQkAAyUKANxTVoY2xoKXGeWyRgWMppZNt0qETbcqhLJQIoUiVJJUAlnySWJK0kpFYYKAtoe3BgIg',
    'k4YG8C6HzEq3BgFWk4b2LwOoBQBj8wYBKpcDqIUCFwUAAAMlJTCXBQAAg6UlL4xBCEGyhhcGAAADJgYuAoi2h7cGAiCThgbw',
    'MofQSrcGAVaThvYvAygGAGPzBgEql66GFwUAAAMlBSyXBQAAg6UFKwMoxgKMQQhBFwYAAAMmxikCiAlFic0XBwAAAyfnKBxT',
    'AUWqB5zBg1dnAqoH3MGCgLcHAiCThwfw3EsXBwAAAyfnJgxDFwcAAAMnxybcTwhDQREGxhcGAAADJgYlgpcPEAAAskBBAYKA',
    'goAAAGFkZHJlc3MgJSBIUE1fTDFDX0NBQ0hFTElORV9TSVpFID09IDAAAABFOi9zZGtfZW52X3YxLjExLjAvaHBtX3Nkay9h',
    'cmNoL3Jpc2N2L2wxYy9ocG1fbDFjX2Rydi5jAHNpemUgJSBIUE1fTDFDX0NBQ0hFTElORV9TSVpFID09IDAAAGwxY19pY191',
    'bmxvY2sAAABsMWNfaWNfZmlsbF9sb2NrAAAAAGwxY19pY19pbnZhbGlkYXRlAAAAbDFjX2RjX2ZsdXNoAAAAAGwxY19kY193',
    'cml0ZWJhY2sAAAAAbDFjX2RjX2ludmFsaWRhdGUAAABsMWNfZGNfdW5sb2NrAAAAbDFjX2RjX2ZpbGxfbG9jawAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8yegfImLgceJR3Owp3yCgAAAAABABAAA',
    'OAQAADwEAAA0BAAA/////wAAAAA=',
  ].join(''),
};

/** 解出 blob 字节（每次调用都新建一份，避免被就地改动）*/
export function hpmAlgoBytes(loadAddr = HPM_ALGO.loadAddr){
  const bin = atob(HPM_ALGO.b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return relocateAlgoBytes(out, HPM_ALGO, loadAddr);
}
