/**
 * 零依赖 ZIP 读取（只读，够取 jar 里的贴图就行）。
 *
 * 为什么需要它：Minecraft 现代版本的方块/物品贴图不在公开资源索引里（索引只有
 * 音效、语言、字体），而是直接打在客户端 jar 内。要从 jar 里取图就得解 ZIP。
 * 自己实现一遍的理由同 png.mjs：仓库坚持只用 node 内置模块，而 ZIP 的读取侧
 * 其实只是「中央目录 + 本地头 + raw deflate」三件事。
 *
 * 支持范围：deflate / stored 两种压缩方式，含 ZIP64 计数与尺寸扩展字段。
 * 加密条目、分卷压缩不支持——jar 里也用不到。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_EOCD_SIGNATURE = 0x06064b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * 从缓冲区尾部找 EOCD（末尾可能带最长 64KB 的注释，所以要往回扫）。
 * @param buffer ZIP 字节。
 * @returns EOCD 的偏移。
 */
function findEndOfCentralDirectory(buffer) {
  const earliest = Math.max(0, buffer.length - 66000)
  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new Error('不是 ZIP：找不到中央目录结尾记录（EOCD）')
}

/**
 * 读出条目总数与中央目录偏移，必要时走 ZIP64。
 * @param buffer ZIP 字节。
 * @param eocd EOCD 偏移。
 * @returns { count, offset }。
 */
function readDirectoryLocation(buffer, eocd) {
  let count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (count !== 0xffff && offset !== 0xffffffff) return { count, offset }

  const locator = eocd - 20
  if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new Error('ZIP 需要 ZIP64 但找不到定位记录')
  }
  const zip64Eocd = Number(buffer.readBigUInt64LE(locator + 8))
  if (buffer.readUInt32LE(zip64Eocd) !== ZIP64_EOCD_SIGNATURE) throw new Error('ZIP64 EOCD 签名不匹配')
  count = Number(buffer.readBigUInt64LE(zip64Eocd + 32))
  offset = Number(buffer.readBigUInt64LE(zip64Eocd + 48))
  return { count, offset }
}

/**
 * 在扩展字段里找 ZIP64 的 8 字节尺寸。
 * @param buffer ZIP 字节。
 * @param start 扩展字段起点。
 * @param length 扩展字段总长。
 * @param needUncompressed 32 位未压缩尺寸是否为哨兵值。
 * @returns { compressedSize, uncompressedSize } 或 null。
 */
function readZip64Extra(buffer, start, length, needUncompressed) {
  let cursor = start
  const end = start + length
  while (cursor + 4 <= end) {
    const id = buffer.readUInt16LE(cursor)
    const size = buffer.readUInt16LE(cursor + 2)
    if (id === 0x0001) {
      let at = cursor + 4
      const uncompressedSize = buffer.readBigUInt64LE(at)
      at += 8
      const compressedSize = needUncompressed ? buffer.readBigUInt64LE(at) : uncompressedSize
      return { compressedSize: Number(compressedSize), uncompressedSize: Number(uncompressedSize) }
    }
    cursor += 4 + size
  }
  return null
}

/**
 * 索引一个 ZIP 的所有条目。
 * @param buffer ZIP 字节。
 * @returns { name → { method, compressedSize, uncompressedSize, localOffset } }。
 */
export function indexZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const { count, offset } = readDirectoryLocation(buffer, eocd)
  const entries = new Map()
  let cursor = offset
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP 中央目录第 ' + String(i) + ' 项签名不匹配')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    let compressedSize = buffer.readUInt32LE(cursor + 20)
    let uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    let localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)

    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const zip64 = readZip64Extra(buffer, cursor + 46 + nameLength, extraLength, true)
      if (zip64 !== null) {
        uncompressedSize = zip64.uncompressedSize
        compressedSize = zip64.compressedSize
      }
    }
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * 从 ZIP 里取出一个条目的内容。
 * @param buffer ZIP 字节。
 * @param entries indexZip 的结果。
 * @param name 条目名。
 * @returns 解压后的字节；条目不存在时返回 null。
 */
export function readZipEntry(buffer, entries, name) {
  const entry = entries.get(name)
  if (entry === undefined) return null
  const at = entry.localOffset
  if (buffer.readUInt32LE(at) !== LOCAL_SIGNATURE) throw new Error('ZIP 本地头签名不匹配：' + name)
  const nameLength = buffer.readUInt16LE(at + 26)
  const extraLength = buffer.readUInt16LE(at + 28)
  const start = at + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return inflateRawSync(raw)
  throw new Error('不支持的 ZIP 压缩方式 ' + String(entry.method) + '：' + name)
}
