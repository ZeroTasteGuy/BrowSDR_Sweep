"""Third fast-retune step for BirriaSDR (apply after birriasdr_rfburst.py; idempotent).

Run: python birriasdr_elide.py PATH\\TO\\birriasdr
Both options are opt-in:
  BIRRIASDR_RF_ELIDE=1  during a live retune with BIRRIASDR_RF_SHADOW=1, a
                        read-modify-write whose result equals the shadowed value
                        is skipped (no USB op). Plain writes are never skipped.
  BIRRIASDR_USB_KB=N    bulk transfer size for the sample stream in KiB
                        (16..256, multiple of 16). Default stays 64 KiB at
                        40 MS/s and 256 KiB at 80 MS/s. Smaller transfers
                        deliver samples sooner after a retune.
Without BIRRIASDR_FAST_TUNE=1, each retune's final frequency readback still
checks the result.
"""
import sys
from pathlib import Path

root = Path(sys.argv[1])
def edit(rel, pairs):
    p = root / rel
    s = p.read_text()
    for old, new in pairs:
        marker = next((l for l in new.splitlines() if l.strip() and l not in old), new)
        if new in s or marker in s:
            continue                       # already applied
        if old not in s:
            sys.exit(f'{rel}: anchor not found (apply birriasdr_rfburst.py first?):\n{old}')
        s = s.replace(old, new, 1)
    p.write_text(s)
    print('patched', rel)

edit('src/chips/mt7921_rf.c', [
("""static int rf_opt_shadow = -1, rf_opt_burst, rf_opt_nopoll;""",
 """static int rf_opt_shadow = -1, rf_opt_burst, rf_opt_nopoll, rf_opt_elide;"""),
("""    rf_opt_nopoll = getenv("BIRRIASDR_RF_NOPOLL") != NULL;""",
 """    rf_opt_nopoll = getenv("BIRRIASDR_RF_NOPOLL") != NULL;
    rf_opt_elide = getenv("BIRRIASDR_RF_ELIDE") != NULL;"""),
("""        fprintf(stderr, "rf options: shadow %d burst %d nopoll %d\\n",
                rf_opt_shadow, rf_opt_burst, rf_opt_nopoll);""",
 """        fprintf(stderr, "rf options: shadow %d burst %d nopoll %d elide %d\\n",
                rf_opt_shadow, rf_opt_burst, rf_opt_nopoll, rf_opt_elide);"""),
("""        BS_TRY(mt_rf_read(dev, port, address, &value));
    return mt_rf_write(dev, port, address, (value & ~clear) | set);""",
 """        BS_TRY(mt_rf_read(dev, port, address, &value));
    if (known && rf_opt_elide && ((value & ~clear) | set) == value)
        return 0;                          /* BIRRIASDR_RF_ELIDE: register already holds it */
    return mt_rf_write(dev, port, address, (value & ~clear) | set);"""),
])

edit('src/usb_stream.c', [
("""    reader->transfer_bytes = dev->rate == 80000000 ? BS_USB_BYTES : BS_USB_LOW_RATE_BYTES;""",
 """    reader->transfer_bytes = dev->rate == 80000000 ? BS_USB_BYTES : BS_USB_LOW_RATE_BYTES;
    {   /* BIRRIASDR_USB_KB: bulk transfer size override, 16..256 KiB in 16 KiB steps */
        const char *kb = getenv("BIRRIASDR_USB_KB");
        int n = kb ? atoi(kb) : 0;
        if (n >= 16 && n <= 256 && n % 16 == 0)
            reader->transfer_bytes = (unsigned)n * 1024u;
    }"""),
])
print('done')
