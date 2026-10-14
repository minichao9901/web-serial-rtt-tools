#include "pipeline.h"
static uint32_t state = 0x3157abcd;
static uint8_t block[96];
static uint16_t values[48];
NOINLINE uint32_t next_random(void) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}
NOINLINE uint32_t crc_step(uint32_t crc, uint8_t value) {
  crc ^= value;
  for (unsigned bit = 0; bit < 8; bit++)
    crc = (crc >> 1) ^ ((0u - (crc & 1)) & 0xedb88320);
  return crc;
}
NOINLINE void pipeline_scan(void) {
  uint32_t crc = g_checksum;
  for (unsigned i = 0; i < 96; i++) {
    block[i] = (uint8_t)next_random();
    crc = crc_step(crc, block[i]);
  }
  g_checksum = crc;
}
NOINLINE void insertion_sort(void) {
  for (unsigned i = 1; i < 48; i++) {
    uint16_t v = values[i];
    unsigned j = i;
    while (j && values[j - 1] > v) {
      values[j] = values[j - 1];
      j--;
    }
    values[j] = v;
  }
}
NOINLINE void pipeline_sort(void) {
  for (unsigned i = 0; i < 48; i++)
    values[i] = (uint16_t)next_random();
  insertion_sort();
  g_checksum ^= values[17];
}
NOINLINE uint32_t branch_leaf_a(uint32_t x) {
  for (unsigned i = 0; i < 130; i++) {
    x = (x << 5) ^ (x >> 2) ^ i;
    __asm volatile("" : "+r"(x));
  }
  return x;
}
NOINLINE uint32_t branch_leaf_b(uint32_t x) {
  for (unsigned i = 0; i < 160; i++) {
    x = x * 1664525 + 1013904223;
    __asm volatile("" : "+r"(x));
  }
  return x;
}
NOINLINE void route_a(void) {
  uint32_t x = g_checksum;
  for (unsigned i = 0; i < 8; i++)
    x = branch_leaf_a(x);
  g_checksum = x;
}
NOINLINE void route_b(void) {
  uint32_t x = g_checksum;
  for (unsigned i = 0; i < 9; i++)
    x = branch_leaf_b(x);
  g_checksum = x;
}
NOINLINE uint32_t encode_word(uint32_t x) {
  uint32_t result = 0;
  for (unsigned i = 0; i < 16; i++) {
    result = (result << 2) | ((x >> i) & 1);
    if (x & (1u << (31 - i)))
      result |= 1;
  }
  return result;
}
NOINLINE void pipeline_pack(void) {
  uint32_t x = g_checksum;
  for (unsigned i = 0; i < 48; i++)
    x ^= encode_word(values[i] + i);
  g_checksum = x;
}
NOINLINE uint32_t recursive_mix(uint32_t x, unsigned depth) {
  if (!depth) {
    for (unsigned i = 0; i < 40; i++)
      x = (x << 1) ^ (x >> 3) ^ i;
    return x;
  }
  uint32_t a = recursive_mix(x ^ 0x5678, depth - 1);
  return a ^ recursive_mix(a + 3, depth - 1);
}
NOINLINE void pipeline_recursive(void) {
  g_checksum = recursive_mix(g_checksum, 4);
}
NOINLINE uint32_t verify_block(void) {
  uint32_t x = 0;
  for (unsigned round = 0; round < 25; round++)
    for (unsigned i = 0; i < 96; i++)
      x += (block[i] ^ round) * (i + 1);
  return x;
}
NOINLINE void pipeline_verify(void) { g_checksum ^= verify_block(); }
