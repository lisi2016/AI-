# 生成 tabBar 图标：81x81 PNG，灰色未选中 / 绿色选中
# 仅用于首版占位，正式版可替换为设计稿切图
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'miniprogram', 'assets', 'icons')
os.makedirs(OUT, exist_ok=True)

S = 81
GRAY = (154, 160, 166, 255)
GREEN = (7, 193, 96, 255)
W = 6


def base():
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def home(d, c):
    # 屋顶
    d.line([(14, 42), (40, 18), (66, 42)], fill=c, width=W, joint='curve')
    # 屋身
    d.line([(22, 38), (22, 64), (58, 64), (58, 38)], fill=c, width=W, joint='curve')
    # 门
    d.line([(34, 64), (34, 50), (46, 50), (46, 64)], fill=c, width=W, joint='curve')


def records(d, c):
    # 文档外框
    d.rounded_rectangle([16, 12, 64, 68], radius=6, outline=c, width=W)
    # 三行
    for y in (28, 42, 56):
        d.line([(28, y), (52, y)], fill=c, width=W)


def mine(d, c):
    # 头
    d.ellipse([30, 16, 51, 37], outline=c, width=W)
    # 肩
    d.arc([16, 40, 65, 76], start=180, end=360, fill=c, width=W)


for name, fn in (('home', home), ('records', records), ('mine', mine)):
    for suffix, color in (('', GRAY), ('_on', GREEN)):
        img, d = base()
        fn(d, color)
        path = os.path.join(OUT, name + suffix + '.png')
        img.save(path)

print('icons written to', OUT)
for f in sorted(os.listdir(OUT)):
    print(' -', f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
