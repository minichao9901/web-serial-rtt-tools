/* Fixed-address arrays for JScope index/stride tests (GCC DWARF 5). */
struct channel {
    unsigned short value;
    unsigned char flags;
    float gain;
    unsigned int *pointer;
    unsigned short samples[3];
};
volatile unsigned short scope_u16[4];
volatile float scope_matrix[2][3];
volatile unsigned char scope_cube[2][3][4];
volatile struct channel scope_channels[2];
volatile unsigned char scope_big[8 * 1024 * 1024];
void _start(void) {
    for (;;) {
        scope_u16[0]++;
        scope_matrix[1][2] = 1.0f;
        scope_channels[1].value++;
    }
}
