"""Firmware half of the on-chip retune (BIRRIASDR_FW_TUNE). Imported by birriasdr_fwtune.py.

The streaming program gains a non-blocking RF script engine. Control block at
CTRL (MCU data memory, unused in stream mode):
  +0  magic 'FTR1' (firmware -> host, written before boot magic)
  +4  script address (host)        +8  request sequence (host, written last)
  +12 done sequence (firmware)     +16 status: 0 ok, 1 poll timeout, 3 bad opcode
  +20 script time in microseconds  +24..+44 firmware state (poll start, phase,
                                       run start, latch value, current op)
A script is a list of 3-word ops: w0 = op << 24 | port << 13 | address,
then a, b. Ops: 0 end, 1 write a, 2 read-modify-write (clear a, set b),
3 poll until (value & a) == b (2 ms limit), 4 latch: read the register named
by a (port << 13 | address), write ((it & 7) << 22) into field [24:22] of w0.
Only the Wi-Fi SPI ports (0, 1) are supported.

script_step never waits for the SPI bridge: if the bridge is busy it returns,
otherwise it finishes the previous transaction and launches the next one. It
is called once per packet and from both wait loops of the stream, so the RF
work overlaps the USB DMA instead of stalling it (80 MS/s has almost no slack).
It uses only r0, r1, r3, r8, r9 and lp; the stream loop's live registers
(r2, r4-r7, r10, fp) are preserved.
"""

EQU = '.equ CTRL, 0x2041000\n.equ CTRL_MAGIC, 0x31525446\n.equ SPI_BASE, 0x7c004000\n'

INIT = r'''    .ifdef IQ_STREAM
    /* On-chip retune control block: clear, then advertise support. */
    load32 $r1, CTRL
    movi $r0, 0
    movi $r2, 12
clear_ctrl:
    swi.bi $r0, [$r1], 4
    addi $r2, $r2, -1
    bnez $r2, clear_ctrl
    load32 $r1, CTRL
    load32 $r0, CTRL_MAGIC
    swi $r0, [$r1]
    .endif
'''

CHECK = '''    .ifdef IQ_STREAM
    jal script_step
    .endif
'''

ENGINE = r'''
    /* SPI launch helpers: r3 = port << 13 | address. Scratch r0/r1. */
    .macro spi_launch_read
    load32 $r1, SPI_BASE
    lwi $r0, [$r1 + 16]
    srli $r0, $r0, 16
    slli $r0, $r0, 16
    or $r0, $r0, $r3
    ori $r0, $r0, 0x1000
    swi $r0, [$r1 + 16]
    movi $r0, 0
    swi $r0, [$r1 + 20]
    .endm
    /* r3 = port << 13 | address, r8 = value. */
    .macro spi_launch_write
    load32 $r1, SPI_BASE
    lwi $r0, [$r1 + 16]
    srli $r0, $r0, 16
    slli $r0, $r0, 16
    or $r0, $r0, $r3
    swi $r0, [$r1 + 16]
    swi $r8, [$r1 + 20]
    .endm
    .macro low24 reg
    slli \reg, \reg, 8
    srli \reg, \reg, 8
    .endm
    .macro set_phase value
    movi $r0, \value
    swi $r0, [$r9 + 32]
    .endm

script_step:
    load32 $r9, CTRL
    lwi $r0, [$r9 + 8]
    lwi $r1, [$r9 + 12]
    bne $r0, $r1, step_active
    ret
step_active:
    lwi $r8, [$r9 + 44]
    bnez $r8, step_started
    lwi $r8, [$r9 + 4]
    swi $r8, [$r9 + 44]
    movi $r0, 0
    swi $r0, [$r9 + 16]
    swi $r0, [$r9 + 32]
    load32 $r0, 0x89020068
    lwi $r0, [$r0]
    swi $r0, [$r9 + 36]
step_started:
    load32 $r0, SPI_BASE
    lwi $r0, [$r0]
    andi $r0, $r0, 2
    beqz $r0, step_idle
    ret
step_idle:
    lwi $r3, [$r8]
    srli $r0, $r3, 24
    beqz $r0, step_end
    lwi $r1, [$r9 + 32]
    bnez $r1, step_result
    /* Phase 0: launch the op's first transaction. */
    movi $r1, 1
    beq $r0, $r1, launch_write_a
    movi $r1, 2
    beq $r0, $r1, launch_own_read
    movi $r1, 3
    beq $r0, $r1, launch_poll
    movi $r1, 4
    beq $r0, $r1, launch_latch
    movi $r0, 3
    swi $r0, [$r9 + 16]
    j step_end
launch_write_a:
    low24 $r3
    lwi $r8, [$r8 + 4]
    spi_launch_write
    j step_advance
launch_poll:
    load32 $r0, 0x89020068
    lwi $r0, [$r0]
    swi $r0, [$r9 + 24]
launch_own_read:
    low24 $r3
    spi_launch_read
    set_phase 1
    ret
launch_latch:
    lwi $r3, [$r8 + 4]
    spi_launch_read
    set_phase 1
    ret
step_result:
    /* Phase 1/2: the bridge is idle, so the read result is valid. */
    load32 $r1, SPI_BASE
    lwi $r0, [$r1 + 24]
    lwi $r1, [$r9 + 32]
    movi $r8, 2
    beq $r1, $r8, latch_write
    srli $r1, $r3, 24
    movi $r8, 3
    beq $r1, $r8, poll_result
    movi $r8, 4
    beq $r1, $r8, latch_source
    /* Read-modify-write. */
    lwi $r8, [$r9 + 44]
    lwi $r1, [$r8 + 4]
    bitc $r0, $r0, $r1
    lwi $r1, [$r8 + 8]
    or $r8, $r0, $r1
    low24 $r3
    spi_launch_write
    j step_advance
poll_result:
    lwi $r8, [$r9 + 44]
    lwi $r1, [$r8 + 4]
    and $r0, $r0, $r1
    lwi $r1, [$r8 + 8]
    beq $r0, $r1, step_advance
    load32 $r0, 0x89020068
    lwi $r0, [$r0]
    lwi $r1, [$r9 + 24]
    sub $r0, $r0, $r1
    movi $r1, 2000
    slt $r0, $r1, $r0
    beqz $r0, poll_again
    movi $r0, 1
    swi $r0, [$r9 + 16]
    j step_advance
poll_again:
    low24 $r3
    spi_launch_read
    ret
latch_source:
    andi $r0, $r0, 7
    slli $r0, $r0, 22
    swi $r0, [$r9 + 40]
    low24 $r3
    spi_launch_read
    set_phase 2
    ret
latch_write:
    load32 $r1, 0x01c00000
    bitc $r0, $r0, $r1
    lwi $r1, [$r9 + 40]
    or $r8, $r0, $r1
    low24 $r3
    spi_launch_write
step_advance:
    lwi $r8, [$r9 + 44]
    addi $r8, $r8, 12
    swi $r8, [$r9 + 44]
    set_phase 0
    ret
step_end:
    load32 $r0, 0x89020068
    lwi $r0, [$r0]
    lwi $r1, [$r9 + 36]
    sub $r0, $r0, $r1
    swi $r0, [$r9 + 20]
    movi $r0, 0
    swi $r0, [$r9 + 44]
    dsb
    lwi $r0, [$r9 + 8]
    swi $r0, [$r9 + 12]   /* publish completion last */
    dsb
    ret
'''

ANCHORS = {
    'equ': '.equ PAYLOAD_BYTES, 0x2000\n',
    'init': '    load32 $r0, BOOT_MAGIC\n',
    'publish': 'publish:\n    lwi $r0, [$fp + 36]\n    bnez $r0, stopped\n',
    'space': '    observe_source\n    lwi $r0, [$r6 + 12]\n    .endif\n',
    'source': 'wait_source:\n    lwi $r0, [$fp + 36]\n    bnez $r0, stopped\n',
    'tail': 'source_overrun:\n    movi $r10, 9\n    j drain\n',
}


def _remove_v1(source):
    """Undo the first (blocking) version of this patch."""
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('v1', Path(__file__).with_name('fwtune_asm_v1.py'))
    v1 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(v1)
    for block in (v1.EQU, v1.INIT, v1.CHECK, v1.INTERPRETER):
        if block not in source:
            raise SystemExit('iq_stream.S: unexpected content, restore the original file first')
        source = source.replace(block, '', 1)
    return source


def patch(source):
    """Return iq_stream.S with the script engine added (idempotent)."""
    if 'script_step:' in source:
        return source
    if 'run_script:' in source:
        source = _remove_v1(source)
    for name, a in ANCHORS.items():
        if source.count(a) != 1:
            raise SystemExit(f'iq_stream.S: anchor {name} not unique/found: {a!r}')
    a = ANCHORS
    source = source.replace(a['equ'], a['equ'] + EQU)
    source = source.replace(a['init'], INIT + a['init'])
    source = source.replace(a['publish'], a['publish'] + CHECK)
    source = source.replace(a['space'], '    observe_source\n    jal script_step\n    lwi $r0, [$r6 + 12]\n    .endif\n')
    source = source.replace(a['source'], a['source'] + '    jal script_step\n')
    source = source.replace(a['tail'], a['tail'] + ENGINE)
    return source
