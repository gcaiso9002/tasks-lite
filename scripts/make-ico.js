'use strict';
/**
 * 把多张尺寸的 PNG 打包成一个多分辨率 ICO。
 * Vista 之后 ICO 容器里可以直接内嵌 PNG，所以不需要 BMP 编码，省一大堆依赖。
 */
const fs = require('fs');
const path = require('path');

const dir = process.env.ICO_DIR;
if (!dir) {
  console.error('需要设置 ICO_DIR 环境变量');
  process.exit(1);
}

// 从大到小排列，ICO 里按此顺序存
const sizes = [256, 128, 64, 48, 32, 24, 16];
const images = sizes
  .map((s) => ({ size: s, file: path.join(dir, `icon-${s}.png`) }))
  .filter((i) => fs.existsSync(i.file));

if (!images.length) {
  console.error(`目录里没找到 icon-*.png：${dir}`);
  process.exit(1);
}

const HEADER = 6;
const ENTRY = 16;
const buf = Buffer.alloc(HEADER + ENTRY * images.length);

buf.writeUInt16LE(0, 0); // reserved
buf.writeUInt16LE(1, 2); // type = 1 (icon)
buf.writeUInt16LE(images.length, 4);

let offset = HEADER + ENTRY * images.length;
const payloads = [];

images.forEach((img, i) => {
  const data = fs.readFileSync(img.file);
  const base = HEADER + ENTRY * i;
  // 256 在 ICO 目录项里要用 0 表示（宽度/高度各 1 字节，0 = 256）
  buf.writeUInt8(img.size >= 256 ? 0 : img.size, base + 0);
  buf.writeUInt8(img.size >= 256 ? 0 : img.size, base + 1);
  buf.writeUInt8(0, base + 2);  // 调色板数
  buf.writeUInt8(0, base + 3);  // reserved
  buf.writeUInt16LE(1, base + 4); // color planes
  buf.writeUInt16LE(32, base + 5); // bits per pixel
  buf.writeUInt32LE(data.length, base + 8);
  buf.writeUInt32LE(offset, base + 12);
  offset += data.length;
  payloads.push(data);
});

const ico = Buffer.concat([buf, ...payloads]);
const out = path.join(dir, 'icon.ico');
fs.writeFileSync(out, ico);
console.log(`已生成 ${out}  ${ico.length} 字节，含 ${images.length} 种尺寸: ${images.map((i) => i.size).join('/')}`);
