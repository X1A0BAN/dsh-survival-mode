/**
 * 零依赖 PNG 编解码 + 一点点栅格操作。
 *
 * 为什么自己写而不用 sharp/pngjs：这个仓库从 build.mjs 到 verify.mjs 都刻意保持
 * 「只用 node 内置模块」，贴图生成脚本没有理由破例——它是要跟着仓库一起分发的，
 * 一旦依赖 sharp，用户机器上就得先装原生编译链。PNG 本身足够简单：
 * zlib 用内置的，滤波只有 5 种，块结构就是一串 length/type/data/crc。
 *
 * 支持范围：8 位及以下的非隔行 PNG（灰度 / RGB / 索引 / 灰度+Alpha / RGBA）——
 * 覆盖 Minecraft 原版全部方块与物品贴图。隔行扫描直接报错，不做半吊子支持。
 *
 * 图像一律用 { width, height, data } 表示，data 是 width×height×4 的 RGBA 字节。
 */

import { deflateSync, inflateSync } from 'node:zlib'

/** PNG 文件签名。 */
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

/** 颜色类型 → 每像素通道数。 */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** CRC32 查表，首次使用时构建。 */
let crcTable = null

/**
 * 取 CRC32 表（PNG 每个块尾部都要校验）。
 * @returns 256 项的表。
 */
function getCrcTable() {
  if (crcTable !== null) return crcTable
  crcTable = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c
  }
  return crcTable
}

/**
 * 算一段字节的 CRC32。
 * @param buffer 待校验数据。
 * @returns 无符号 32 位校验值。
 */
function crc32(buffer) {
  const table = getCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = table[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * 把 PNG 拆成块序列。
 * @param buffer 完整文件字节。
 * @returns { type, data } 数组。
 */
function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('PNG 签名不匹配')
  }
  const chunks = []
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (offset + 12 + length > buffer.length) throw new Error('PNG 块 ' + type + ' 长度越界')
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) })
    offset += length + 12
    if (type === 'IEND') break
  }
  return chunks
}

/**
 * Paeth 预测器（滤波类型 4）。
 * @param a 左像素。
 * @param b 上像素。
 * @param c 左上像素。
 * @returns 预测值。
 */
function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * 逐扫描线还原滤波后的像素字节。
 * @param raw inflate 出来的原始字节（每行开头 1 字节滤波类型）。
 * @param height 行数。
 * @param stride 每行有效字节数。
 * @param bpp 每像素字节数（滤波的左邻步长）。
 * @returns height×stride 的字节。
 */
function unfilter(raw, height, stride, bpp) {
  const out = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const value = line[x]
      const left = x >= bpp ? cur[x - bpp] : 0
      const up = prev === null ? 0 : prev[x]
      const upLeft = prev === null || x < bpp ? 0 : prev[x - bpp]
      let restored
      if (filter === 0) restored = value
      else if (filter === 1) restored = value + left
      else if (filter === 2) restored = value + up
      else if (filter === 3) restored = value + ((left + up) >> 1)
      else if (filter === 4) restored = value + paeth(left, up, upLeft)
      else throw new Error('未知的 PNG 滤波类型 ' + String(filter))
      cur[x] = restored & 0xff
    }
  }
  return out
}

/**
 * 按位深把一行里的样本解出来（只用于位深 < 8 的灰度/索引图）。
 * @param bytes 行字节。
 * @param width 像素数。
 * @param bitDepth 1/2/4。
 * @returns 长度 width 的样本数组。
 */
function unpackSamples(bytes, width, bitDepth) {
  const perByte = 8 / bitDepth
  const mask = (1 << bitDepth) - 1
  const out = new Array(width)
  for (let x = 0; x < width; x += 1) {
    const byte = bytes[Math.floor(x / perByte)]
    const shift = 8 - bitDepth * ((x % perByte) + 1)
    out[x] = (byte >> shift) & mask
  }
  return out
}

/**
 * 解码一张 PNG。
 * @param buffer 文件字节。
 * @returns { width, height, data }，data 为 RGBA。
 */
export function decodePng(buffer) {
  const chunks = readChunks(buffer)
  const header = chunks.find((chunk) => chunk.type === 'IHDR')
  if (header === undefined) throw new Error('PNG 缺少 IHDR')
  const width = header.data.readUInt32BE(0)
  const height = header.data.readUInt32BE(4)
  const bitDepth = header.data[8]
  const colorType = header.data[9]
  if (header.data[12] !== 0) throw new Error('不支持隔行扫描的 PNG')

  const channels = CHANNELS[colorType]
  if (channels === undefined) throw new Error('不支持的 PNG 颜色类型 ' + String(colorType))
  if (bitDepth !== 8 && !(bitDepth === 1 || bitDepth === 2 || bitDepth === 4)) {
    throw new Error('不支持的 PNG 位深 ' + String(bitDepth))
  }
  if (bitDepth !== 8 && colorType !== 0 && colorType !== 3) {
    throw new Error('位深 ' + String(bitDepth) + ' 只支持灰度与索引图')
  }

  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data))
  const raw = inflateSync(idat)
  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  const pixels = unfilter(raw, height, stride, bpp)

  const paletteChunk = chunks.find((chunk) => chunk.type === 'PLTE')
  const palette = paletteChunk === undefined ? null : paletteChunk.data
  const transparency = chunks.find((chunk) => chunk.type === 'tRNS')

  // 灰度/索引图在低位深时要把样本线性放大到 0–255，否则整图会偏黑。
  const sampleScale = bitDepth === 8 ? 1 : 255 / ((1 << bitDepth) - 1)
  const data = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    const line = pixels.subarray(y * stride, (y + 1) * stride)
    const samples = bitDepth === 8 ? null : unpackSamples(line, width, bitDepth)
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4
      if (colorType === 6) {
        const i = x * 4
        data[at] = line[i]
        data[at + 1] = line[i + 1]
        data[at + 2] = line[i + 2]
        data[at + 3] = line[i + 3]
      } else if (colorType === 2) {
        const i = x * 3
        data[at] = line[i]
        data[at + 1] = line[i + 1]
        data[at + 2] = line[i + 2]
        data[at + 3] = 255
      } else if (colorType === 4) {
        const i = x * 2
        data[at] = line[i]
        data[at + 1] = line[i]
        data[at + 2] = line[i]
        data[at + 3] = line[i + 1]
      } else if (colorType === 0) {
        const gray = bitDepth === 8 ? line[x] : Math.round(samples[x] * sampleScale)
        data[at] = gray
        data[at + 1] = gray
        data[at + 2] = gray
        data[at + 3] = 255
        // 灰度图的 tRNS 是「哪个灰度值当透明」。
        if (transparency !== undefined && transparency.data.length >= 2
          && gray === transparency.data.readUInt16BE(0)) {
          data[at + 3] = 0
        }
      } else {
        const index = bitDepth === 8 ? line[x] : samples[x]
        if (palette === null) throw new Error('索引图缺少 PLTE')
        const p = index * 3
        data[at] = palette[p]
        data[at + 1] = palette[p + 1]
        data[at + 2] = palette[p + 2]
        data[at + 3] = transparency !== undefined && index < transparency.data.length
          ? transparency.data[index]
          : 255
      }
    }
  }

  return { width, height, data }
}

/**
 * 编码一张 RGBA 图为 PNG（统一 8 位 RGBA、滤波 0，保证字节可复现）。
 * @param image { width, height, data }。
 * @returns 文件字节。
 */
export function encodePng(image) {
  const { width, height, data } = image
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const chunk = (type, payload) => {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(payload.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), payload])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([head, body, crc])
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 直接把图编成 data URI（客户端贴图的最终形态）。
 * @param image { width, height, data }。
 * @returns `data:image/png;base64,…`。
 */
export function toDataUri(image) {
  return 'data:image/png;base64,' + encodePng(image).toString('base64')
}

/**
 * 造一张全透明图。
 * @param width 宽。
 * @param height 高。
 * @returns 新图。
 */
export function createImage(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) }
}

/**
 * 从图上裁一块（越界部分视为透明）。
 * @param image 源图。
 * @param x 左上角 x。
 * @param y 左上角 y。
 * @param width 宽。
 * @param height 高。
 * @returns 新图。
 */
export function crop(image, x, y, width, height) {
  const out = createImage(width, height)
  for (let row = 0; row < height; row += 1) {
    const sy = y + row
    if (sy < 0 || sy >= image.height) continue
    for (let col = 0; col < width; col += 1) {
      const sx = x + col
      if (sx < 0 || sx >= image.width) continue
      const from = (sy * image.width + sx) * 4
      const to = (row * width + col) * 4
      image.data.copy(out.data, to, from, from + 4)
    }
  }
  return out
}

/**
 * 把源图直接贴到目标图（源 alpha 为 0 的像素不覆盖，保留目标原样）。
 * @param dest 目标图（原地修改）。
 * @param src 源图。
 * @param dx 目标 x。
 * @param dy 目标 y。
 * @returns dest。
 */
export function blit(dest, src, dx, dy) {
  for (let y = 0; y < src.height; y += 1) {
    const ty = dy + y
    if (ty < 0 || ty >= dest.height) continue
    for (let x = 0; x < src.width; x += 1) {
      const tx = dx + x
      if (tx < 0 || tx >= dest.width) continue
      const from = (y * src.width + x) * 4
      if (src.data[from + 3] === 0) continue
      const to = (ty * dest.width + tx) * 4
      src.data.copy(dest.data, to, from, from + 4)
    }
  }
  return dest
}

/**
 * 把源图按 source-over 混到目标图上（保留半透明过渡）。
 *
 * 和 blit 的区别：blit 是「盖印章」，遇 alpha=0 跳过、其余整像素覆盖，适合把
 * 不透明面片拼成一张图；这里是真正的 alpha 混合，用来叠草方块侧面那种带羽化
 * alpha 的 overlay —— 用 blit 会把羽化边缘变成硬边。
 *
 * @param dest 目标图（原地修改）。
 * @param src 源图。
 * @param dx 目标 x。
 * @param dy 目标 y。
 * @returns dest。
 */
export function alphaBlit(dest, src, dx, dy) {
  for (let y = 0; y < src.height; y += 1) {
    const ty = dy + y
    if (ty < 0 || ty >= dest.height) continue
    for (let x = 0; x < src.width; x += 1) {
      const tx = dx + x
      if (tx < 0 || tx >= dest.width) continue
      const from = (y * src.width + x) * 4
      const alpha = src.data[from + 3]
      if (alpha === 0) continue
      const to = (ty * dest.width + tx) * 4
      if (alpha === 255) {
        src.data.copy(dest.data, to, from, from + 4)
        continue
      }
      const keep = 255 - alpha
      for (let channel = 0; channel < 3; channel += 1) {
        dest.data[to + channel] = Math.round(
          (src.data[from + channel] * alpha + dest.data[to + channel] * keep) / 255,
        )
      }
      dest.data[to + 3] = Math.max(dest.data[to + 3], alpha)
    }
  }
  return dest
}

/**
 * 复制一张图（要原地改图又不想动原件时用）。
 * @param image 源图。
 * @returns 新图。
 */
export function cloneImage(image) {
  return { width: image.width, height: image.height, data: Buffer.from(image.data) }
}

/**
 * 最近邻整数放大（像素画只能最近邻，双线性会把 MC 贴图糊掉）。
 * @param image 源图。
 * @param factor 放大倍数。
 * @returns 新图。
 */
export function scaleNearest(image, factor) {
  if (factor === 1) return image
  const out = createImage(image.width * factor, image.height * factor)
  for (let y = 0; y < out.height; y += 1) {
    for (let x = 0; x < out.width; x += 1) {
      const from = (Math.floor(y / factor) * image.width + Math.floor(x / factor)) * 4
      const to = (y * out.width + x) * 4
      image.data.copy(out.data, to, from, from + 4)
    }
  }
  return out
}

/**
 * 把整图 RGB 乘上一个颜色（模拟 MC 的生物群系染色），alpha 保持不变。
 * @param image 源图（原地修改）。
 * @param rgb [r, g, b]，各 0–255。
 * @returns image。
 */
export function multiplyTint(image, rgb) {
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = Math.round((image.data[i] * rgb[0]) / 255)
    image.data[i + 1] = Math.round((image.data[i + 1] * rgb[1]) / 255)
    image.data[i + 2] = Math.round((image.data[i + 2] * rgb[2]) / 255)
  }
  return image
}

/**
 * 判断一张图是否实质上是灰度图——用来决定要不要染色。
 *
 * 原版树叶/草皮贴图在不同版本里有时是灰度待染色的、有时是已经上色的成品，
 * 与其记「哪个版本是哪种」，不如读像素判断，两种都能正确出图。
 *
 * 必须带容差：原版 oak_leaves.png 是三通道灰度但带 ±4 的编码噪声
 * （实测 185,188,185 与 104,100,104 这类），严格 r==g==b 会把树叶判成彩色，
 * 于是染色被跳过、树叶在场景里发白。容差 8 远小于任何真实彩色贴图的色偏
 * （草方块侧面最大色偏 106），既能放住噪声也不会误判彩色图。
 *
 * @param image 源图。
 * @param tolerance 单像素允许的最大通道差。
 * @returns 所有不透明像素的通道差都在容差内时返回 true。
 */
export function isGrayscale(image, tolerance = 8) {
  let opaque = 0
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue
    opaque += 1
    const spread = Math.max(image.data[i], image.data[i + 1], image.data[i + 2])
      - Math.min(image.data[i], image.data[i + 1], image.data[i + 2])
    if (spread > tolerance) return false
  }
  return opaque > 0
}

/**
 * 统计不透明像素的平均颜色（调试与核对用）。
 * @param image 源图。
 * @returns [r, g, b] 四舍五入的均值；全透明时返回 null。
 */
export function meanColor(image) {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i + 3] === 0) continue
    r += image.data[i]
    g += image.data[i + 1]
    b += image.data[i + 2]
    n += 1
  }
  if (n === 0) return null
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}

/**
 * 把一张图摆进大图的指定格子里（做预览拼图用）。
 * @param dest 目标大图。
 * @param src 源图。
 * @param col 列（以格子为单位）。
 * @param row 行。
 * @param cell 格子边长。
 * @param scale 整数放大倍数。
 * @returns dest。
 */
export function pasteCell(dest, src, col, row, cell, scale = 1) {
  return blit(dest, scaleNearest(src, scale), col * cell * scale, row * cell * scale)
}
