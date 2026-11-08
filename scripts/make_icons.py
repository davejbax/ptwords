#!/usr/bin/env python3
"""Render the PNG app icons (same design as client/public/icon.svg) without any deps."""
import struct, sys, zlib

def png(path, n):
    s = n / 64
    def px(x, y):
        X, Y = x / s, y / s
        def rr(x0, y0, w, h, r):
            if not (x0 <= X < x0 + w and y0 <= Y < y0 + h): return False
            cx = min(max(X, x0 + r), x0 + w - r); cy = min(max(Y, y0 + r), y0 + h - r)
            return (X - cx) ** 2 + (Y - cy) ** 2 <= r * r
        if (X - 27) ** 2 + (Y - 32) ** 2 <= 36: return (255, 204, 0)
        if rr(14, 16, 13, 32, 5) or (22 <= X < 27 and 16 <= Y < 48): return (200, 16, 46)
        if rr(14, 16, 36, 32, 5): return (255, 255, 255)
        return (11, 93, 59)  # full-bleed background so the maskable crop works
    raw = b"".join(b"\0" + bytes(c for x in range(n) for c in px(x + .5, y + .5)) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

for n in (192, 512):
    png(f"{sys.argv[1]}/icon-{n}.png", n)
