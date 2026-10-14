#!/usr/bin/env python3
# docs/G-mv7kzgnu-1/T209-evidence/verify_sheet.py
# E2E-8 的机器部分：把对照 PNG 的 5 个位面单元格裁出来，证明
#   (a) 每格都有实质图形（非空白）；
#   (b) 5 格两两像素差 > 阈值（对应「5 张两两不同」）；
#   (c) 4 个回退格像素完全一致（对应「非法/缺失/旧 emoji 都落同一张占位人形」）。
import json, sys
from PIL import Image
import numpy as np

png = sys.argv[1] if len(sys.argv) > 1 else 'docs/G-mv7kzgnu-1/T209-evidence/avatar-sheet-s11-s15.png'
SIZE = 128; pad = 18; lab = 30
img = np.asarray(Image.open(png).convert('RGB')).astype(np.int16)
cw = SIZE + pad * 2
report = {'png': png, 'cells': {}, 'pairwiseDiff': {}, 'fallbackIdentical': None}

def crop(row, col):
    x = col * cw + pad; y = 40 + row * (SIZE + lab)
    return img[y:y + SIZE, x:x + SIZE, :]

cells = [crop(0, i) for i in range(5)]
fb = [crop(1, i) for i in range(4)]

for i, c in enumerate(cells):
    bg = np.array([245, 246, 248], dtype=np.int16)
    ink = int(np.sum(np.abs(c - bg).sum(axis=2) > 18))
    report['cells']['s' + str(11 + i)] = {'inkPixels': ink, 'inkRatio': round(ink / (SIZE * SIZE), 4)}

mind = None
for i in range(5):
    for j in range(i + 1, 5):
        d = float(np.abs(cells[i] - cells[j]).mean())
        report['pairwiseDiff']['s%d-vs-s%d' % (11 + i, 11 + j)] = round(d, 3)
        mind = d if mind is None else min(mind, d)
report['minPairwiseMeanDiff'] = round(mind, 3)

fbd = [float(np.abs(fb[i] - fb[0]).mean()) for i in range(4)]
report['fallbackIdentical'] = all(v == 0.0 for v in fbd)
report['fallbackDiffs'] = [round(v, 3) for v in fbd]

ok = (min(report['cells'][k]['inkRatio'] for k in report['cells']) > 0.15
      and mind > 2.0
      and report['fallbackIdentical'])
report['verdict'] = 'PASS' if ok else 'FAIL'
print(json.dumps(report, indent=2, ensure_ascii=False))
sys.exit(0 if ok else 1)
