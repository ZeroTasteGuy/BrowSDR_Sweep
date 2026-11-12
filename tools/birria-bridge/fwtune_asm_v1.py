"""Firmware half of the on-chip retune (BIRRIASDR_FW_TUNE). Imported by birriasdr_fwtune.py.

The streaming program gains a small RF script interpreter. Control block at
CTRL (MCU data memory, unused in stream mode):
  +0  magic 'FTR1' (firmware -> host, written before boot magic)
  +4  script address (host)        +8  request sequence (host, written last)
  +12 done sequence (firmware)     +16 status: 0 ok, 1 poll timeout,
                                       2 SPI busy timeout, 3 bad opcode
  +20 script time in microseconds  +24..+36 firmware scratch
A script is a list of 3-word ops: w0 = op << 24 | port << 13 | address,
then a, b. Ops: 0 end, 1 write a, 2 read-modify-write (clear a, set b),
3 poll until (value & a) == b (2 ms limit), 4 latch: read the register named
by a (port << 13 | address), write ((it & 7) << 22) into field [24:22] of w0.
Only the Wi-Fi SPI ports (0, 1) are supported. Every op keeps observing the
capture producer, so the existing overrun and timing guards stay active.
"""

EQU = '.equ CTRL, 0x2041000\n.equ CTRL_MAGIC, 0x31525446\n'

INIT = r'''    .ifdef IQ_STREAM
    /* On-chip retune control block: clear, then advertise support. */
    load32 $r1, CTRL
    movi $r0, 0
    movi $r2, 10
clear_ctrl:
    swi.bi $r0, [$r1], 4
    addi $r2, $r2, -1
    bnez $r2, clear_ctrl
    load32 $r1, CTRL
    load32 $r0, CTRL_MAGIC
    swi $r0, [$r1]
    .endif
'''

CHECK = r'''    .ifdef IQ_STREAM
    load32 $r0, CTRL
    lwi $r1, [$r0 + 8]
    lwi $r3, [$r0 + 12]
    bne $r1, $r3, run_script
script_return:
    .endif
'''

INTERPRETER = r'''
    /* Wait for the RF SPI bridge (base in r10) to go idle; scratch r0/r1/r3. */
    .macro spi_idle
    movi $r1, 0
80:
    lwi $r0, [$r10]
    andi $r0, $r0, 2
    beqz $r0, 82f
    addi $r1, $r1, 1
    slti $r3, $r1, 16000
    bnez $r3, 80b
    load32 $r0, CTRL
    movi $r3, 2
    swi $r3, [$r0 + 16]
82:
    .endm

    /* r9 = port << 13 | address. Returns the register value in r2. */
spi_read:
    load32 $r10, 0x7c004000
    spi_idle
    lwi $r0, [$r10 + 16]
    srli $r0, $r0, 16
    slli $r0, $r0, 16
    or $r0, $r0, $r9
    ori $r0, $r0, 0x1000
    swi $r0, [$r10 + 16]
    movi $r0, 0
    swi $r0, [$r10 + 20]
    spi_idle
    lwi $r2, [$r10 + 24]
    ret

    /* r9 = port << 13 | address, r2 = value. */
spi_write:
    load32 $r10, 0x7c004000
    spi_idle
    lwi $r0, [$r10 + 16]
    srli $r0, $r0, 16
    slli $r0, $r0, 16
    or $r0, $r0, $r9
    swi $r0, [$r10 + 16]
    swi $r2, [$r10 + 20]
    spi_idle
    ret

run_script:
    load32 $r0, CTRL
    lwi $r8, [$r0 + 4]
    movi $r1, 0
    swi $r1, [$r0 + 16]
    load32 $r1, 0x89020068
    lwi $r1, [$r1]
    swi $r1, [$r0 + 36]
op_loop:
    observe_source
    lwi $r9, [$r8 + 0]
    srli $r0, $r9, 24
    slli $r9, $r9, 8
    srli $r9, $r9, 8
    beqz $r0, script_end
    movi $r1, 1
    beq $r0, $r1, op_write
    movi $r1, 2
    beq $r0, $r1, op_rmw
    movi $r1, 3
    beq $r0, $r1, op_poll
    movi $r1, 4
    beq $r0, $r1, op_latch
    load32 $r0, CTRL
    movi $r1, 3
    swi $r1, [$r0 + 16]
    j script_end
op_write:
    lwi $r2, [$r8 + 4]
    jal spi_write
    j op_next
op_rmw:
    jal spi_read
    lwi $r1, [$r8 + 4]
    bitc $r2, $r2, $r1
    lwi $r1, [$r8 + 8]
    or $r2, $r2, $r1
    jal spi_write
    j op_next
op_poll:
    load32 $r0, 0x89020068
    lwi $r0, [$r0]
    load32 $r1, CTRL
    swi $r0, [$r1 + 24]
poll_again:
    jal spi_read
    lwi $r1, [$r8 + 4]
    and $r0, $r2, $r1
    lwi $r1, [$r8 + 8]
    beq $r0, $r1, op_next
    load32 $r0, 0x89020068
    lwi $r0, [$r0]
    load32 $r1, CTRL
    lwi $r1, [$r1 + 24]
    sub $r0, $r0, $r1
    movi $r1, 2000
    slt $r0, $r1, $r0
    bnez $r0, poll_timeout
    observe_source
    j poll_again
poll_timeout:
    load32 $r0, CTRL
    movi $r1, 1
    swi $r1, [$r0 + 16]
    j op_next
op_latch:
    load32 $r0, CTRL
    swi $r9, [$r0 + 28]
    lwi $r9, [$r8 + 4]
    jal spi_read
    andi $r2, $r2, 7
    slli $r2, $r2, 22
    load32 $r0, CTRL
    swi $r2, [$r0 + 32]
    lwi $r9, [$r0 + 28]
    jal spi_read
    load32 $r1, 0x01c00000
    bitc $r2, $r2, $r1
    load32 $r0, CTRL
    lwi $r1, [$r0 + 32]
    or $r2, $r2, $r1
    jal spi_write
op_next:
    addi $r8, $r8, 12
    j op_loop
script_end:
    load32 $r0, CTRL
    load32 $r1, 0x89020068
    lwi $r1, [$r1]
    lwi $r3, [$r0 + 36]
    sub $r1, $r1, $r3
    swi $r1, [$r0 + 20]
    dsb
    lwi $r1, [$r0 + 8]
    swi $r1, [$r0 + 12]   /* publish completion last */
    dsb
    j script_return
'''


def patch(source):
    """Return iq_stream.S with the interpreter added (idempotent)."""
    if 'run_script:' in source:
        return source
    anchors = ['.equ PAYLOAD_BYTES, 0x2000\n', '    load32 $r0, BOOT_MAGIC\n',
               'publish:\n    lwi $r0, [$fp + 36]\n    bnez $r0, stopped\n',
               'source_overrun:\n    movi $r10, 9\n    j drain\n']
    for a in anchors:
        if source.count(a) != 1:
            raise SystemExit(f'iq_stream.S: anchor not unique/found: {a!r}')
    source = source.replace(anchors[0], anchors[0] + EQU)
    source = source.replace(anchors[1], INIT + anchors[1])
    source = source.replace(anchors[2], anchors[2] + CHECK)
    source = source.replace(anchors[3], anchors[3] + INTERPRETER)
    return source
