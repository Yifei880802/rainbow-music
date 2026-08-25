#!/usr/bin/env node
/**
 * 生成 Rainbow 占位图标（零依赖，仅用 Node 内置 zlib）：
 * 圆角方块 + 对角彩虹渐变 + 顶部高光。
 *
 * 产物：
 *   fpk/ICON.PNG                 (64x64)
 *   fpk/ICON_256.PNG             (256x256)
 *   fpk/app/ui/images/icon_64.png
 *   fpk/app/ui/images/icon_256.png
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // color type RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 彩虹渐变绘制 ----------

/** 将 hue(0-360) 转为 RGB，饱和度/亮度可调（简化 HSL→RGB） */
function hsl(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r, g, b
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const radius = size * 0.22          // 圆角半径
  const cx = size / 2
  const cy = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 圆角矩形遮罩（SDF 近似，边缘 1px 抗锯齿）
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (size / 2 - radius), 0)
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (size / 2 - radius), 0)
      const dist = Math.hypot(dx, dy)
      const coverage = Math.min(Math.max(radius - dist + 0.5, 0), 1)
      if (coverage <= 0) continue
      // 对角彩虹渐变：左上红 → 右下紫
      const t = (x + y) / (2 * size)              // 0..1
      const hue = t * 300                          // 0..300
      // 顶部轻微提亮，模拟高光
      const light = 0.56 - (y / size) * 0.1 + (x / size) * 0.02
      const [r, g, b] = hsl(hue, 0.85, light)
      const i = (y * size + x) * 4
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = Math.round(255 * coverage)
    }
  }
  return px
}

const targets = [
  [64, 'fpk/ICON.PNG'],
  [256, 'fpk/ICON_256.PNG'],
  [64, 'fpk/app/ui/images/icon_64.png'],
  [256, 'fpk/app/ui/images/icon_256.png'],
]

for (const [size, rel] of targets) {
  const out = join(ROOT, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, encodePng(size, drawIcon(size)))
  console.log(`written: ${rel} (${size}x${size})`)
}
