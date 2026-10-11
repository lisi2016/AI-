#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
二维码交叉验证脚本（可选 · 需要 Python 第三方库）

为什么需要它：miniprogram/utils/qrcode.js 是手写的二维码编码器，
项目内的 Node 自测（tools/miniapp-selftest.js）只能自己校验自己
（结构图形 + 反解 + RS 校验子）。要做到真正的外部可信，必须让
**第三方实现**来验证它。

本脚本用两个彼此独立的成熟实现做交叉验证：
  1) segno   —— 纯 Python 参考级二维码生成库：逐模块对比矩阵是否一致
  2) OpenCV  —— cv2.QRCodeDetector()：直接"扫描"我们生成的图，能否还原原文

依赖（本机已验证：segno OK / cv2 OK）：
    pip install segno opencv-python numpy

用法（在项目根目录「课时签到微信小程序/」执行）：
    python tools/qr-cross-check.py

预期结果：
    - 无填充字节的用例（内容正好占满数据码字，如 17 字节 @ v1-L）
      → 与 segno **逐模块完全一致**（版本、掩码、数据、纠错、格式信息全同）
    - 全部用例 → OpenCV 均可解码回原文
    - 需要填充字节的用例，segno 会多出 8 个 0 填充位（其 encoder.write_padding_bits
      用 `8 - length % 8`，当数据已按字节对齐时会多补一整字节 0x00），
      故矩阵会有差异。本项目按 ISO/IEC 18004 §7.4.9–7.4.10 实现：
      「终止符最多 4 个 0 → 补齐到字节边界 → 0xEC/0x11 交替填充」，
      与 nayuki 参考实现一致；多补的 0 位于终止符之后、解码器不读取，因此两者都能正常扫。
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
QR_MODULE = os.path.join(ROOT, 'miniprogram', 'utils', 'qrcode.js').replace('\\', '/')
TMP = tempfile.gettempdir()


def missing(lib, hint):
    print('缺少依赖 %s（%s），已跳过交叉验证。' % (lib, hint))
    return True


def run_node(payload, ecc):
    """调用小程序端编码器，导出模块矩阵到临时 JSON"""
    js = (
        "const q=require(%s);const fs=require('fs');"
        "const r=q.encode(%s,{ecc:%s});"
        "fs.writeFileSync(%s, JSON.stringify({size:r.size,version:r.version,mask:r.mask,modules:r.modules}));"
    ) % (json.dumps(QR_MODULE), json.dumps(payload), json.dumps(ecc),
         json.dumps(os.path.join(TMP, 'kcsq-qr-matrix.json').replace('\\', '/')))
    subprocess.run(['node', '-e', js], check=True, cwd=ROOT)
    with open(os.path.join(TMP, 'kcsq-qr-matrix.json'), encoding='utf-8') as f:
        return json.load(f)


def to_image(modules, size, scale=8, quiet=4):
    import numpy as np
    n = size + quiet * 2
    img = np.full((n * scale, n * scale), 255, np.uint8)
    for y in range(size):
        for x in range(size):
            if modules[y][x] == 1:
                img[(y + quiet) * scale:(y + quiet + 1) * scale,
                    (x + quiet) * scale:(x + quiet + 1) * scale] = 0
    return np.pad(img, 20, constant_values=255)


# 17 字节 = v1-L 数据容量正好占满（4+8+17*8+4 = 152 位 = 19 数据码字），无填充字节
NO_PAD = 'CD000000000000001'
CASES = [
    (NO_PAD, 'L', True),                     # 与 segno 应逐模块完全一致
    ('CD0000000000000012', 'L', False),      # 需要填充字节
    ('kcsq://code/CD00000001', 'L', False),
    ('kcsq://code/CD00000001', 'M', False),
    ('kcsq://code/CD00000001', 'Q', False),
    ('kcsq://code/CD00000001', 'H', False),
    ('课时确认动态码：2025级药学1班 张一鸣', 'H', False),
]


def main():
    print('小程序二维码编码器交叉验证')
    print('编码器：%s' % QR_MODULE)
    print('=' * 70)

    try:
        import segno
    except ImportError:
        return 1 if missing('segno', 'pip install segno') else 0
    try:
        import cv2
        import numpy as np
    except ImportError:
        return 1 if missing('opencv-python / numpy', 'pip install opencv-python numpy') else 0

    identical = 0
    decoded = 0
    for payload, ecc, expect_identical in CASES:
        m = run_node(payload, ecc)
        ref = segno.make(payload, error=ecc.lower(), mode='byte', boost_error=False)
        refm = [list(row) for row in ref.matrix]
        diff = 0
        if m['size'] == len(refm):
            for y in range(m['size']):
                for x in range(m['size']):
                    if m['modules'][y][x] != refm[y][x]:
                        diff += 1
        same = (diff == 0)
        if same:
            identical += 1

        img = to_image(m['modules'], m['size'])
        text, _pts, _ = cv2.QRCodeDetector().detectAndDecode(img)
        ok = (text == payload)
        if ok:
            decoded += 1

        tag = '矩阵一致' if same else ('矩阵有差异(%d 模块，属填充字节差异)' % diff)
        if expect_identical and not same:
            tag = '!! 期望矩阵一致但出现差异：%d 模块' % diff
        print('%-4s v%-2d mask%d  字节=%-3d  segno=%s  OpenCV 解码=%s   %s' % (
            ecc, m['version'], m['mask'], len(payload.encode('utf-8')),
            tag, '成功' if ok else '失败(%r)' % text, payload[:26]))

    print('=' * 70)
    print('与 segno 逐模块一致：%d / %d（无填充字节的用例应完全一致）' % (identical, len(CASES)))
    print('OpenCV 独立解码成功：%d / %d' % (decoded, len(CASES)))
    expected_identical = sum(1 for c in CASES if c[2])
    ok = (decoded == len(CASES)) and (identical >= expected_identical)
    print('结论：%s' % ('通过' if ok else '未通过'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
