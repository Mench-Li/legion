#!/usr/bin/env python3
# workbench/scripts/derive-avatar-photos.py
# ============================================================================
# 头像**实拍图**的派生与登记：原图 → 256px WebP（桌面 + 手机两端）→ 两张镜像资产表。
#
# ## 为什么要有这个脚本（而不是继续照着文档手工做）
#
# 文档里写的是四步手工动作：「把原图放 `assets/agent-avatars/`，重新派生 256px WebP 到
# 那两个目录，更新资产表（含 from/srcSize/sha256 来源登记），跑 avatar-photo 测试」。
# 四步都靠人记，而 `avatar-photo.test.mjs` 守的那几条**正好就是这四步各自漏掉的形状**：
#
#   · 只往 `workbench/public/` 拷了图，忘了手机那份 ⇒ 桌面正常、手机全裂；
#   · 两端文件内容不同（改了一端忘了另一端）⇒ 同一个人两副面孔；
#   · 加了图**忘了登记** ⇒ 目录里是孤儿图，而界面上什么都不会变；
#   · 有人塞回 2MB 原图 ⇒ 首屏体积失控。
#
#   > 一套"提交时能查出这四种错"的判据，
#   > 与一套"根本不产生这四种错"的流程，在只有一个人、只做一次的时候没有区别 ——
#   > 区别在下一次：判据让你**事后**知道搞砸了，脚本让这件事**没有搞砸的机会**。
#
# 所以这里是"一张表 + 一次运行"：表里一加行，图和两张资产表一起出来。
#
# ## 三个刻意的设计
#
# ① **已有的图绝不重编码**。重编码会改变已提交产物的字节，而那是**用户正在看的脸** ——
#    没有任何理由让它变。已有 = 保持，只校验两端逐字节相同。要换某一张才用 `--force`。
#
# ② **sha256 登记的是派生图（WebP），不是原图**。原图在 `assets/agent-avatars/` 且
#    已 gitignore（原图不入库）⇒ 原图的哈希在别人 clone 出来的仓库里**无法复核**；
#    而入库产物的哈希可以。`from`/`srcSize` 指向原图，是"这图哪来的"的溯源，不承担校验。
#
# ③ **两张表由同一个清单重生成**。桌面 `photo-assets.ts` 与手机 `avatar.mjs` 是镜像，
#    手工同步必然漂移（位面表当年就是为此加了 parity 用例）。这里的做法更狠一点：
#    不是"改完再比对"，而是**根本没有第二处可以改**。
#
# ## 用法
#
#   python workbench/scripts/derive-avatar-photos.py            # 派生缺的图 + 重写两张表
#   python workbench/scripts/derive-avatar-photos.py --check    # 只看差什么，不写盘（CI 友好）
#   python workbench/scripts/derive-avatar-photos.py --force    # 连已有的也重新编码（换图用）
#
# 依赖 Pillow（本仓工作区自带 12.x）。
# ============================================================================
import argparse
import hashlib
import io
import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境缺依赖时说清怎么补
    sys.exit('缺 Pillow：本脚本用 Pillow 编码 WebP。请用带 Pillow 的 Python 运行（本仓工作区自带 12.x）。')

ROOT = Path(__file__).resolve().parents[2]

SRC_DIR = ROOT / 'assets' / 'agent-avatars'
DESKTOP_DIR = ROOT / 'workbench' / 'public' / 'avatars'
MOBILE_DIR = ROOT / 'workbench' / 'mobile' / 'avatars'
DESKTOP_TABLE = ROOT / 'workbench' / 'src' / 'avatar' / 'photo-assets.ts'
MOBILE_TABLE = ROOT / 'workbench' / 'mobile' / 'avatar.mjs'

# ── 唯一的清单 ──────────────────────────────────────────────────────────────
# 顺序 = 编号（第 1 行 → agent-avatar-01）。**只许往后追加**：
# 在中间插行会把后面所有人的文件名整体挪一位，而那意味着"每个人的脸都换了一张"。
#
# 现有 25 行对应 11 个内置岗位 + s01..s09 + s11..s15。
#
# ⚠ `s10`（ozon 的 soldier-sourcing / 寻源参谋）**排在第 26 位**，没跟 s09 挨着 ——
#   这是有意的，别"顺手把它挪回去"。它当初没有原图，后来补图时只能**追加**：
#   插回 s09 后面会让 s11..s15 整体挪一位 ⇒ 五张已经被人认下来的脸全部换人。
#   代价只是编号不连续（s10 → agent-avatar-26），而编号是给文件用的、不是给人看的。
SLOT_ORDER = [
    'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer',
    'tester', 'devops', 'assistant', 'research-assistant', 'writer',
    's01', 's02', 's03', 's04', 's05', 's06', 's07', 's08', 's09',
    # 2026-10-14：外部执行者（未入编队、由 tasks.soldier 合成的那几个）也要写实照片。
    # 判据侧的两张冻结表见 team-hub/agent-avatars.mjs 与 workbench/src/avatar/external-agents.ts。
    's11', 's12', 's13', 's14', 's15',
    # 2026-10-14（将军："寻源 Agent 还不是写实 3D 风"）：s10 是**最后一个**没有照片的
    # 编队成员 —— 全仓四个空间的 roster 里，只有它还在走矢量。补上之后就再没有"混着矢量"的人了。
    's10',
]

SOURCE_EXTS = ('.png', '.jpg', '.jpeg', '.webp')
SIZE = 256
# 体积上限与 avatar-photo.test.mjs 的 ⑥ 同一条（64KB）。这里留一半余量：
# 派生时就贴着上限的话，下一次换图很容易越线，而那条判据会在**提交时**才红。
SIZE_BUDGET = 48 * 1024
# ★ 82 不是"随手挑的压缩率"，是**实测能逐字节复现已提交那 20 张**的那个值。
#   同一张 01.png：q80→7646B、**q82→8298B（与已提交文件 sha256 完全相同）**、q84→9286B…
#   20 张全部如此（20/20 逐字节相同）。
#   为什么这件事值得钉住：换一个 quality 不会让任何判据变红（大小都远在 64KB 以内），
#   但会让**换图的人顺手把全库的脸重新压一遍** —— 一次提交里 25 张图全变，
#   而 diff 上只能说"图变了"，说不出"为什么变"。
#   把参数固定在"能复现现状"的那个值上，脚本就只会改动**它该动的那几张**。
WEBP_QUALITY = 82
HASH_LEN = 16


def avatar_name(index: int) -> str:
    """第 index 行（1 起）→ `agent-avatar-NN`。"""
    return f'agent-avatar-{index:02d}'


def find_source(stem: str):
    for ext in SOURCE_EXTS:
        p = SRC_DIR / f'{stem}{ext}'
        if p.exists():
            return p
    return None


def derive_webp(src: Path) -> bytes:
    """
    原图 → 256×256 WebP。

    非正方形**居中裁剪**（不是拉伸）：把一张 4:3 的人像拉成正方形会把脸压扁，
    而头像是最不该变形的那类图。裁剪的代价是边缘被切掉，这比变形好。
    """
    with Image.open(src) as im:
        im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
        w, h = im.size
        side = min(w, h)
        im = im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format='WEBP', quality=WEBP_QUALITY, method=6)
        return buf.getvalue()


def js_key(key: str) -> str:
    """手机端那张表用"需要才加引号"的写法（与文件里已有的 20 行逐字一致）。"""
    return key if re.fullmatch(r'[A-Za-z_$][A-Za-z0-9_$]*', key) else f"'{key}'"


def desktop_line(e: dict) -> str:
    return (
        f"  '{e['key']}': {{ file: '{e['file']}', from: '{e['from']}', "
        f"srcSize: '{e['src_size']}', sha256: '{e['sha256']}' }},"
    )


def mobile_line(e: dict) -> str:
    return f"  {js_key(e['key'])}: '{e['file']}',"


def read_raw(path: Path) -> str:
    """
    按字节读再解码。

    ★ 不能用 `Path.read_text()`：它默认开**通用换行**（`newline=None`），会把 `\\r\\n`
      折成 `\\n` —— 于是下面按 `'\\r\\n'` 切分只能切出一整块，而报出来的却是
      "找不到 `export const AVATAR_PHOTOS`"，读起来像文件被改名了。
      这个坑只在 Windows 检出上出现（那两个文件都是 CRLF）。
    """
    return path.read_bytes().decode('utf-8')


def rewrite_table(path: Path, entries: list, render) -> str:
    """
    把 `export const AVATAR_PHOTOS …` 那一块的表体换成 `entries` 渲染出来的行。

    ★ 行尾必须沿用**文件自己的**（这两个文件都是 CRLF）：用 `\\n` 重写会让整文件
      在 git 里变成"每一行都改了"，而真正的改动只是末尾多了几行 ——
      那种 diff 没人能读，也没人愿意读。
    """
    text = read_raw(path)
    lines = text.split('\r\n')
    start = next((i for i, l in enumerate(lines) if l.startswith('export const AVATAR_PHOTOS')), None)
    if start is None:
        raise SystemExit(f'{path} 里找不到 `export const AVATAR_PHOTOS` —— 表改名了，本脚本要跟着改')
    end = next((i for i in range(start + 1, len(lines)) if lines[i] == '})'), None)
    if end is None:
        raise SystemExit(f'{path} 的 AVATAR_PHOTOS 块没有以顶格 `}})` 收尾 —— 形状变了，请复核本脚本')
    body = [render(e) for e in entries]
    return '\r\n'.join(lines[:start + 1] + body + lines[end:])


def main() -> int:
    ap = argparse.ArgumentParser(description='派生头像 WebP 并重生成两张资产表')
    ap.add_argument('--check', action='store_true', help='只报告差异，不写盘')
    ap.add_argument('--force', action='store_true', help='连已有的图也重新编码（换图时用）')
    args = ap.parse_args()

    for d in (DESKTOP_DIR, MOBILE_DIR):
        d.mkdir(parents=True, exist_ok=True)

    entries = []
    derived, kept, problems = [], [], []

    for i, key in enumerate(SLOT_ORDER, start=1):
        stem = avatar_name(i)
        file = f'{stem}.webp'
        d_path = DESKTOP_DIR / file
        m_path = MOBILE_DIR / file
        src = find_source(stem)

        if args.force or not (d_path.exists() and m_path.exists()):
            if src is None:
                problems.append(
                    f'{key}: 缺原图 → 期望 {SRC_DIR / (stem + ".png")}（或 .jpg/.jpeg/.webp）'
                )
                continue
            payload = derive_webp(src)
            if len(payload) > SIZE_BUDGET:
                problems.append(
                    f'{key}: 派生图 {len(payload)}B 超过预算 {SIZE_BUDGET}B —— 换一张更简单的原图，'
                    f'或调低 WEBP_QUALITY（上限是 avatar-photo 用例的 64KB）'
                )
                continue
            if not args.check:
                d_path.write_bytes(payload)
                m_path.write_bytes(payload)
            derived.append(f'{key} → {file}（{len(payload)}B）')
        else:
            # 已有：只校验两端一致，绝不重编码
            payload = d_path.read_bytes()
            if payload != m_path.read_bytes():
                problems.append(f'{key}: 两端 {file} 内容不一致（桌面与手机不是同一张脸）—— 请用 --force 重新派生')
                continue
            kept.append(key)

        # ★ 哈希取**内存里那份**，不回读磁盘：`--check` 不写盘，回读会直接 FileNotFoundError，
        #   而那个报错读起来像"少了一张图"，其实是"这个模式本来就不该读盘"。
        with Image.open(src) as im:
            src_size = f'{im.size[0]}x{im.size[1]}'
        digest = hashlib.sha256(payload).hexdigest()[:HASH_LEN]
        entries.append({
            'key': key, 'file': file,
            'from': f'assets/agent-avatars/{src.name}',
            'src_size': src_size, 'sha256': digest,
        })

    for e in entries:
        print(f"  {e['key']:<20} {e['file']:<24} {e['src_size']:<11} sha256:{e['sha256']}")
    print()
    if derived:
        print(f'新派生 {len(derived)} 张：')
        for d in derived:
            print(f'  · {d}')
    if kept:
        print(f'已有 {len(kept)} 张（保持原字节，未重编码）')
    if problems:
        print('\n问题：', file=sys.stderr)
        for p in problems:
            print(f'  ✗ {p}', file=sys.stderr)

    if args.check:
        print('\n--check：未写盘')
        return 1 if problems else 0
    if problems:
        print('\n有未解决的问题，未写盘（避免写出半套产物）。', file=sys.stderr)
        return 1

    for path, render in ((DESKTOP_TABLE, desktop_line), (MOBILE_TABLE, mobile_line)):
        before = read_raw(path)
        after = rewrite_table(path, entries, render)
        if before == after:
            print(f'{path.relative_to(ROOT)}：无变化')
        else:
            path.write_bytes(after.encode('utf-8'))
            print(f'{path.relative_to(ROOT)}：已更新（{len(entries)} 条）')
    print('\n下一步：node workbench/scripts/avatar-photo.test.mjs')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
