#!/usr/bin/env python3
# docs/G-mv7kzgnu-1/T209-evidence/rasterize_svg.py
# 极简 SVG 光栅器（仅覆盖 workbench/mobile/avatar.mjs 生成的子集）：
# rect(rx)/circle/ellipse/path(M L H V C S Q T Z, 相对与绝对)/g(继承 fill)/linear+radialGradient/
# transform(rotate|translate|scale|matrix)/fill-opacity/stop-opacity/stroke。
# 为什么自己写：本会话环境里 headless Chrome 被沙箱命名管道挡住、cairosvg 缺 libcairo 原生库，
# 且禁止联网安装 —— 为了给 E2E-8 的「看得出是人形 / 两两不同」留一份可复核的位图证据。
import json, math, re, sys
import xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SCALE = 4.0
SIZE = int(32 * SCALE)  # viewBox 32 -> 128

def hex2rgb(s):
    s = s.strip()
    if s.startswith('#'):
        h = s[1:]
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return (0, 0, 0)

def mul(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (a1*a2 + c1*b2, b1*a2 + d1*b2, a1*c2 + c1*d2, b1*c2 + d1*d2,
            a1*e2 + c1*f2 + e1, b1*e2 + d1*f2 + f1)

def parse_transform(s):
    mat = (1, 0, 0, 1, 0, 0)
    for m in re.finditer(r'(\w+)\s*\(([^)]*)\)', s or ''):
        name = m.group(1)
        args = [float(x) for x in re.split(r'[\s,]+', m.group(2).strip()) if x]
        if not args:
            continue
        if name == 'rotate':
            ang = math.radians(args[0]); cx, cy = (args[1], args[2]) if len(args) >= 3 else (0.0, 0.0)
            t = (math.cos(ang), math.sin(ang), -math.sin(ang), math.cos(ang),
                 cx - cx*math.cos(ang) + cy*math.sin(ang), cy - cx*math.sin(ang) - cy*math.cos(ang))
        elif name == 'translate':
            t = (1, 0, 0, 1, args[0], args[1] if len(args) > 1 else 0.0)
        elif name == 'scale':
            sx = args[0]; sy = args[1] if len(args) > 1 else sx
            t = (sx, 0, 0, sy, 0, 0)
        elif name == 'matrix':
            t = tuple(args[:6])
        else:
            continue
        mat = mul(mat, t)
    return mat

def apply(mat, pts):
    a, b, c, d, e, f = mat
    return [(a*x + c*y + e, b*x + d*y + f) for (x, y) in pts]

def dev(mat, pts):
    return [(x * SCALE, y * SCALE) for (x, y) in apply(mat, pts)]

NUM = re.compile(r'[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?')
CMD = re.compile(r'[MmLlHhVvCcSsQqTtAaZz]')

def flatten_path(d, n=24):
    toks = re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?', d)
    pts = []
    cur = (0.0, 0.0); start = (0.0, 0.0); prev_c = None; i = 0; cmd = None
    def bez(p0, p1, p2, p3):
        out = []
        for j in range(1, n + 1):
            t = j / n; mt = 1 - t
            out.append((mt**3*p0[0] + 3*mt*mt*t*p1[0] + 3*mt*t*t*p2[0] + t**3*p3[0],
                        mt**3*p0[1] + 3*mt*mt*t*p1[1] + 3*mt*t*t*p2[1] + t**3*p3[1]))
        return out
    def quad(p0, p1, p2):
        out = []
        for j in range(1, n + 1):
            t = j / n; mt = 1 - t
            out.append((mt*mt*p0[0] + 2*mt*t*p1[0] + t*t*p2[0],
                        mt*mt*p0[1] + 2*mt*t*p1[1] + t*t*p2[1]))
        return out
    while i < len(toks):
        if CMD.match(toks[i]):
            cmd = toks[i]; i += 1
        elif cmd is None:
            i += 1; continue
        rel = cmd.islower(); C = cmd.upper()
        def num(k):
            return float(toks[i + k - 1])
        try:
            if C == 'M':
                x, y = num(1), num(2); i += 2
                if rel: x, y = cur[0] + x, cur[1] + y
                cur = (x, y); start = cur; pts.append(cur)
            elif C == 'L':
                x, y = num(1), num(2); i += 2
                if rel: x, y = cur[0] + x, cur[1] + y
                cur = (x, y); pts.append(cur)
            elif C == 'H':
                x = num(1); i += 1; x = cur[0] + x if rel else x
                cur = (x, cur[1]); pts.append(cur)
            elif C == 'V':
                y = num(1); i += 1; y = cur[1] + y if rel else y
                cur = (cur[0], y); pts.append(cur)
            elif C == 'C':
                x1, y1, x2, y2, x, y = [num(k) for k in range(1, 7)]; i += 6
                if rel: x1, y1, x2, y2, x, y = x1+cur[0], y1+cur[1], x2+cur[0], y2+cur[1], x+cur[0], y+cur[1]
                seg = bez(cur, (x1, y1), (x2, y2), (x, y)); pts += seg; prev_c = (x2, y2); cur = (x, y)
            elif C == 'S':
                x2, y2, x, y = [num(k) for k in range(1, 5)]; i += 4
                if rel: x2, y2, x, y = x2+cur[0], y2+cur[1], x+cur[0], y+cur[1]
                x1, y1 = (2*cur[0]-prev_c[0], 2*cur[1]-prev_c[1]) if prev_c else cur
                seg = bez(cur, (x1, y1), (x2, y2), (x, y)); pts += seg; prev_c = (x2, y2); cur = (x, y)
            elif C == 'Q':
                x1, y1, x, y = [num(k) for k in range(1, 5)]; i += 4
                if rel: x1, y1, x, y = x1+cur[0], y1+cur[1], x+cur[0], y+cur[1]
                pts += quad(cur, (x1, y1), (x, y)); prev_c = (x1, y1); cur = (x, y)
            elif C == 'T':
                x, y = num(1), num(2); i += 2
                if rel: x, y = x+cur[0], y+cur[1]
                x1, y1 = (2*cur[0]-prev_c[0], 2*cur[1]-prev_c[1]) if prev_c else cur
                pts += quad(cur, (x1, y1), (x, y)); prev_c = (x1, y1); cur = (x, y)
            elif C == 'A':
                x, y = num(6), num(7); i += 7
                if rel: x, y = x+cur[0], y+cur[1]
                pts.append((x, y)); cur = (x, y)
            elif C == 'Z':
                pts.append(start); cur = start
            else:
                i += 1
        except IndexError:
            break
    return pts

def parse_stops(body):
    stops = []
    for sm in re.finditer(r'<stop\b([^>]*)/?>', body):
        a = sm.group(1)
        mo = re.search(r'offset="([\d.]+)%"', a)
        mc = re.search(r'stop-color="([^"]+)"', a)
        if not mo or not mc:
            continue
        mop = re.search(r'stop-opacity="([\d.]+)"', a)
        stops.append((float(mo.group(1))/100.0, hex2rgb(mc.group(1)), float(mop.group(1)) if mop else 1.0))
    stops.sort(key=lambda x: x[0])
    return stops

def parse_gradients(svg):
    grads = {}
    for m in re.finditer(r'<(radialGradient|linearGradient)\b([^>]*)>(.*?)</\1>', svg, re.S):
        kind, attrs, body = m.group(1), m.group(2), m.group(3)
        gid = re.search(r'id="([^"]+)"', attrs)
        if not gid:
            continue
        d = {}
        for k in ('cx', 'cy', 'r', 'x1', 'y1', 'x2', 'y2'):
            mm = re.search(k + r'="([-\d.]+)"', attrs)
            if mm:
                d[k] = float(mm.group(1))
        grads[gid.group(1)] = (kind, d, parse_stops(body))
    return grads

def grad_layer(grad, bbox, W, H):
    kind, d, stops = grad
    minx, miny, maxx, maxy = bbox
    w = max(maxx - minx, 1e-6); h = max(maxy - miny, 1e-6)
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float64), np.arange(H, dtype=np.float64))
    u = (gx - minx) / w; v = (gy - miny) / h
    if kind == 'linearGradient':
        x1, y1 = d.get('x1', 0.0), d.get('y1', 0.0)
        x2, y2 = d.get('x2', 1.0), d.get('y2', 0.0)
        dx, dy = x2 - x1, y2 - y1
        den = dx*dx + dy*dy or 1e-6
        t = ((u - x1)*dx + (v - y1)*dy) / den
    else:
        cx, cy, r = d.get('cx', 0.5), d.get('cy', 0.5), d.get('r', 0.5)
        t = np.sqrt((u - cx)**2 + (v - cy)**2) / (r or 1e-6)
    t = np.clip(t, 0.0, 1.0)
    r_ = np.zeros_like(t); g_ = np.zeros_like(t); b_ = np.zeros_like(t); a_ = np.ones_like(t)
    if not stops:
        return np.zeros((H, W, 4), dtype=np.uint8)
    for k in range(len(stops) - 1):
        o0, c0, a0 = stops[k]; o1, c1, a1 = stops[k+1]
        seg = (t >= o0) & (t <= o1)
        if not seg.any():
            continue
        f = (t[seg] - o0) / max(o1 - o0, 1e-6)
        r_[seg] = c0[0] + (c1[0]-c0[0])*f; g_[seg] = c0[1] + (c1[1]-c0[1])*f
        b_[seg] = c0[2] + (c1[2]-c0[2])*f; a_[seg] = a0 + (a1-a0)*f
    o0, c0, a0 = stops[0]; o1, c1, a1 = stops[-1]
    for arr, c, a in ((r_, c0, a0),)*0:
        pass
    m0 = t < stops[0][0];  m1 = t > stops[-1][0]
    r_[m0] = c0[0]; g_[m0] = c0[1]; b_[m0] = c0[2]; a_[m0] = a0
    r_[m1] = c1[0]; g_[m1] = c1[1]; b_[m1] = c1[2]; a_[m1] = a1
    return np.dstack([r_, g_, b_, a_*255.0]).astype(np.uint8)

def render_svg(svg):
    grads = parse_gradients(svg)
    root = ET.fromstring(svg)
    base = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

    def draw_shape(tag, a):
        nonlocal base
        mat = parse_transform(a.get('transform', ''))
        fill = a.get('fill', '#000000')
        fop = float(a.get('fill-opacity', '1'))
        stroke = a.get('stroke')
        sw = float(a.get('stroke-width', '1'))
        bbox = None
        if tag == 'rect':
            x = float(a.get('x', 0)); y = float(a.get('y', 0))
            w = float(a.get('width', 0)); h = float(a.get('height', 0))
            rx = float(a.get('rx', 0))
            mask = Image.new('L', (SIZE, SIZE), 0)
            d = ImageDraw.Draw(mask)
            p0 = dev(mat, [(x, y)])[0]; p1 = dev(mat, [(x + w, y + h)])[0]
            d.rounded_rectangle([p0[0], p0[1], p1[0], p1[1]], radius=rx*SCALE, fill=255)
            bbox = (p0[0], p0[1], p1[0], p1[1])
            pts = None
        elif tag in ('circle', 'ellipse'):
            cx = float(a.get('cx', 0)); cy = float(a.get('cy', 0))
            if tag == 'circle':
                rx = ry = float(a.get('r', 0))
            else:
                rx = float(a.get('rx', 0)); ry = float(a.get('ry', 0))
            pts_c = [(cx + rx*math.cos(t/64*2*math.pi), cy + ry*math.sin(t/64*2*math.pi)) for t in range(64)]
            pts = dev(mat, pts_c)
            mask = Image.new('L', (SIZE, SIZE), 0)
            ImageDraw.Draw(mask).polygon(pts, fill=255)
            bbox = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
        elif tag == 'path':
            d_attr = a.get('d', '')
            pts = dev(mat, flatten_path(d_attr))
            if not pts:
                return
            mask = Image.new('L', (SIZE, SIZE), 0)
            if fill != 'none':
                ImageDraw.Draw(mask).polygon(pts, fill=255)
            bbox = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
        else:
            return
        if fill != 'none':
            if fill.startswith('url('):
                gid = re.search(r'#([^)]+)', fill).group(1)
                if gid in grads:
                    arr = grad_layer(grads[gid], bbox, SIZE, SIZE)
                    layer = Image.fromarray(arr, 'RGBA')
                    ma = np.asarray(mask, dtype=np.float64) * fop
                    layer.putalpha(Image.fromarray(ma.astype(np.uint8), 'L'))
                    base = Image.alpha_composite(base, layer)
                else:
                    solid = Image.new('RGBA', (SIZE, SIZE), hex2rgb('#000000') + (int(fop*255),))
                    base = Image.alpha_composite(base, Image.composite(solid, Image.new('RGBA', (SIZE, SIZE), (0,0,0,0)), mask))
            else:
                solid = Image.new('RGBA', (SIZE, SIZE), hex2rgb(fill) + (int(fop*255),))
                base = Image.alpha_composite(base, Image.composite(solid, Image.new('RGBA', (SIZE, SIZE), (0,0,0,0)), mask))
        if stroke and stroke != 'none' and pts and len(pts) > 1:
            ImageDraw.Draw(base).line(pts, fill=hex2rgb(stroke) + (255,), width=max(1, int(round(sw*SCALE))), joint='curve')

    def walk(elem, inh):
        a = dict(inh); a.update(elem.attrib)
        for child in elem:
            tag = child.tag.split('}')[-1]
            if tag == 'defs':
                continue
            ca = dict(a); ca.update(child.attrib)
            if tag == 'g':
                walk(child, ca)
            else:
                draw_shape(tag, ca)

    walk(root, {})
    return base

def label_font(px):
    for path in ('C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf'):
        try:
            return ImageFont.truetype(path, px)
        except Exception:
            continue
    return ImageFont.load_default()

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else 'docs/G-mv7kzgnu-1/T209-evidence/avatar-svgs.json'
    out = sys.argv[2] if len(sys.argv) > 2 else 'docs/G-mv7kzgnu-1/T209-evidence/avatar-sheet-s11-s15.png'
    data = json.load(open(src, encoding='utf-8'))
    cells = data['cells']; fallback = data['fallback']
    pad = 18; lab = 30
    cw = SIZE + pad * 2
    cols = max(len(cells), len(fallback))
    W = cols * cw
    rows = 2
    H = 46 + rows * (SIZE + lab) + 20
    canvas = Image.new('RGB', (W, H), (245, 246, 248))
    d = ImageDraw.Draw(canvas)
    f_title = label_font(17); f_key = label_font(15); f_small = label_font(12)
    d.text((10, 8), 'T-209 / E2E-8 外部执行者头像对照图（s11..s15 + 回退样本）', fill=(29, 36, 48), font=f_title)
    for i, c in enumerate(cells):
        img = render_svg(c['svg'])
        x = i * cw + pad; y = 40
        canvas.paste(img, (x, y), img)
        d.text((x + SIZE // 2, y + SIZE + 6), c['key'], fill=(53, 65, 79), font=f_key, anchor='ma')
    y2 = 40 + SIZE + lab
    for i, c in enumerate(fallback):
        img = render_svg(c['svg'])
        x = i * cw + pad; y = y2
        canvas.paste(img, (x, y), img)
        d.text((x + SIZE // 2, y + SIZE + 6), json.dumps(c['token']), fill=(102, 116, 138), font=f_small, anchor='ma')
    canvas.save(out)
    print('wrote', out, canvas.size)

if __name__ == '__main__':
    main()
