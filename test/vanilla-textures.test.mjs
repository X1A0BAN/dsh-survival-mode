/**
 * 原版贴图链路测试。
 *
 * 为什么值得单独一个文件：贴图是「看起来很对但可能整条链断掉」的东西——
 * 构建期注入漏了、data URI 坏了、染色没生效、村民 UV 拼错，这四种情况
 * 都不会让任何现有测试变红，只会让人在界面上看到裂图或发白的树叶。
 * 这里逐环钉住：编解码器 → 贴图产物 → 构建期注入 → 占位行契约。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { decodePng, encodePng, isGrayscale, meanColor } from '../scripts/png.mjs'
import { composeVillager } from '../scripts/vanilla-textures.mjs'
import { wrapClientBundle } from '../scripts/build.mjs'

/** 贴图产物与客户端 bundle 路径。 */
const TEXTURES_URL = new URL('../assets/vanilla/textures.json', import.meta.url)
const CLIENT_URL = new URL('../lib/client.js', import.meta.url)
const RAW_VILLAGER_URL = new URL('../assets/vanilla/raw/villager.png', import.meta.url)

/** 非 16×16 的贴图的期望尺寸（其余一律 16×16）。 */
const EXPECTED_SIZE = {
  villager: [16, 32],
  heart: [9, 9],
  foodFull: [9, 9],
}

/** 把 data URI 解成图。 */
function decodeDataUri(uri) {
  const prefix = 'data:image/png;base64,'
  assert.ok(uri.startsWith(prefix), '贴图必须是 PNG data URI')
  return decodePng(Buffer.from(uri.slice(prefix.length), 'base64'))
}

test('PNG 编解码器能无损往返（自写编解码是整条链的地基）', () => {
  const width = 5
  const height = 3
  const data = Buffer.alloc(width * height * 4)
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 256
  const decoded = decodePng(encodePng({ width, height, data }))
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assert.deepEqual([...decoded.data], [...data])
})

test('原版贴图产物齐全、可解码、尺寸与原版一致', async () => {
  const textures = JSON.parse(await readFile(TEXTURES_URL, 'utf8'))
  const required = [
    'grass', 'dirt', 'leaves', 'log', 'table', 'goldOre',
    'apple', 'bread', 'goldenApple', 'goldIngot', 'villager',
  ]
  for (const key of required) {
    assert.ok(typeof textures[key] === 'string', '缺少贴图 ' + key)
  }
  for (const [key, uri] of Object.entries(textures)) {
    const image = decodeDataUri(uri)
    const [w, h] = EXPECTED_SIZE[key] ?? [16, 16]
    assert.equal(image.width, w, key + ' 宽度应为 ' + String(w))
    assert.equal(image.height, h, key + ' 高度应为 ' + String(h))
  }
})

test('树叶染色真的生效了（灰度图必须被染成绿色）', async () => {
  const textures = JSON.parse(await readFile(TEXTURES_URL, 'utf8'))
  const leaves = decodeDataUri(textures.leaves)
  const [r, g, b] = meanColor(leaves)
  // 原版 oak_leaves.png 是三通道灰度（带 ±4 编码噪声），必须靠容差判定 + 染色；
  // 一旦容差回归成严格相等，这里会看到 g≈r 的灰白树叶。
  assert.ok(g > r + 20, '树叶应偏绿，实测 rgb(' + [r, g, b].join(',') + ')')
  assert.ok(g > b + 20, '树叶应偏绿，实测 rgb(' + [r, g, b].join(',') + ')')
})

test('村民正视图按 16×32 合成，且头/袍/腿落在正确的格子里', async () => {
  const skin = decodePng(await readFile(RAW_VILLAGER_URL))
  const composed = composeVillager(skin)
  assert.equal(composed.width, 16)
  assert.equal(composed.height, 32)

  const opaqueAt = (x, y) => composed.data[(y * composed.width + x) * 4 + 3] > 0
  let opaque = 0
  for (let i = 3; i < composed.data.length; i += 4) {
    if (composed.data[i] > 0) opaque += 1
  }

  // 结构性断言比「像素数够多」更能抓住 UV 裁错：竖直偏移若写成 v+dh，
  // 面片会整体下移 2–6 像素，头会盖到肩膀高度、顶部露出大片透明。
  for (let y = 0; y <= 9; y += 1) {
    for (let x = 4; x <= 11; x += 1) {
      assert.ok(opaqueAt(x, y), '头部区域 (' + x + ',' + y + ') 应不透明')
    }
  }
  // 头只有 8 宽，左右各 4 列必须是空的——否则说明裁到了隔壁的面片。
  assert.ok(!opaqueAt(0, 4), '头部左侧应留空')
  assert.ok(!opaqueAt(15, 4), '头部右侧应留空')
  // 竖直排布对照原版 VillagerModel：头 10 行、身 11 行、腿 11 行，合计正好 32 行且不重叠
  // （推导见 VILLAGER_PARTS 注释：34 模型单位 ×0.9375 ≈ 32 像素）。
  assert.ok(opaqueAt(4, 10) && opaqueAt(11, 20), '长袍应占第 10–20 行')
  assert.ok(opaqueAt(4, 21) && opaqueAt(11, 31), '腿应占第 21–31 行')
  // 手臂：模型里 y=1…9，挂在肩线（袍子顶行之下 1 行）起 8 行，贴在袍子两侧。
  // 缺了它村民就是「没有手」。
  assert.ok(!opaqueAt(0, 10), '手臂不应高过肩线')
  assert.ok(opaqueAt(0, 11) && opaqueAt(3, 18), '左臂应占第 11–18 行')
  assert.ok(opaqueAt(12, 11) && opaqueAt(15, 18), '右臂应占第 11–18 行')
  assert.ok(!opaqueAt(0, 19), '手臂应止于第 18 行')
  // 四角必须留空：任何面片越界都会在这里露出来。
  assert.ok(!opaqueAt(0, 0) && !opaqueAt(15, 0), '顶部两角应留空')
  assert.ok(!opaqueAt(0, 31) && !opaqueAt(15, 31), '底部两角应留空')
  // 头 80 + 袍 88 + 双臂 64 + 双腿 88 = 320（鼻压在头内部，不新增像素）。
  assert.ok(opaque > 300 && opaque < 340, '不透明像素数应在 300–340，实测 ' + String(opaque))
})

test('构建期把原版贴图注入了客户端 bundle，占位行不残留', async () => {
  const textures = JSON.parse(await readFile(TEXTURES_URL, 'utf8'))
  const bundle = await readFile(CLIENT_URL, 'utf8')
  assert.ok(!bundle.includes('const VANILLA_TEX = {}'), '构建期占位行应已被替换掉')
  for (const key of Object.keys(textures)) {
    assert.ok(bundle.includes(textures[key]), 'bundle 里缺少 ' + key + ' 的 data URI')
  }
  // 注入的是内联图而不是文件路径：产物必须自包含。所以数 data URI 的条数，
  // 而不是搜 "assets/" 字符串——注释里正当地提到过那个路径。
  const inlined = bundle.match(/data:image\/png;base64,/g) ?? []
  assert.ok(
    inlined.length >= Object.keys(textures).length,
    '内联 PNG 应不少于贴图数：' + String(inlined.length),
  )
})

test('缺少占位行时构建期直接报错，而不是悄悄出一个手绘包', () => {
  const source = 'const INJECTED = null\nconst REAL = 1\nexport default REAL\n'
  assert.throws(() => wrapClientBundle('x', source, { channel: 'c', endpoints: {}, writeFields: {} }), /VANILLA_TEX/)
})

test('贴图表缺失时注入空对象，客户端回退到手绘像素画', () => {
  const source = 'const INJECTED = null\nconst VANILLA_TEX = {}\nexport default VANILLA_TEX\n'
  const bundle = wrapClientBundle('x', source, { channel: 'c', endpoints: {}, writeFields: {} })
  assert.ok(bundle.includes('const VANILLA_TEX = {};'))
  assert.ok(!bundle.includes('const INJECTED'))
})

test('手绘回退层本身仍是灰度判定安全的（不能被误染色）', () => {
  // isGrayscale 的容差放宽到 8 之后，要确认彩色贴图不会被误判成灰度。
  const image = { width: 2, height: 1, data: Buffer.from([200, 120, 60, 255, 10, 200, 30, 255]) }
  assert.equal(isGrayscale(image), false)
  const nearlyGray = { width: 2, height: 1, data: Buffer.from([180, 184, 180, 255, 100, 96, 100, 255]) }
  assert.equal(isGrayscale(nearlyGray), true)
})
