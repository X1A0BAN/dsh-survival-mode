/**
 * 原版贴图管线：从 Mojang 官方客户端 jar 取 Minecraft 原版贴图，转成内联 data URI。
 *
 * 为什么是「客户端 jar」而不是资源索引：现代 Minecraft 的公开 assetIndex 里只有音效、
 * 语言、字体（几十上百 MB），方块/物品贴图是直接打在 client.jar 里的。所以取图路径是
 * 官方启动器同款的两段式：
 *   version_manifest_v2.json → 版本 json → downloads.client → ZIP 里 assets/minecraft/textures/**
 * 不解压第三方镜像、不用玩家本地的 .minecraft，全部来自 piston-data.mojang.com。
 *
 * 产物：
 *   assets/vanilla/raw/*.png     原版素材原件（可核对、可复现）
 *   assets/vanilla/textures.json 贴图键 → PNG data URI，构建期由 build.mjs 注入客户端
 *   assets/vanilla/preview/*.png 人工核对用放大拼图（--preview）
 *   assets/vanilla/cache/*.jar   官方 jar 缓存（体积大，已 gitignore）
 *
 * 用法：
 *   node scripts/vanilla-textures.mjs                   # 默认 1.21.4
 *   node scripts/vanilla-textures.mjs --version=26.2    # 换版本
 *   node scripts/vanilla-textures.mjs --force           # 忽略缓存重下 jar
 *   node scripts/vanilla-textures.mjs --preview         # 额外出人工核对拼图
 *
 * 版权提醒：原版贴图是 Mojang 的版权素材，内联进公开仓库属于再分发，官方 usage
 * guidelines 并不允许这么用。这里按仓库所有者的明确要求做；若日后要撤，把
 * assets/vanilla/ 加进 .gitignore 即可，src/ 与构建脚本一行都不用改。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  alphaBlit,
  blit,
  cloneImage,
  createImage,
  crop,
  decodePng,
  encodePng,
  isGrayscale,
  meanColor,
  multiplyTint,
  pasteCell,
  scaleNearest,
  toDataUri,
} from './png.mjs'
import { indexZip, readZipEntry } from './zip.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 原版素材输出目录。 */
const ASSET_DIR = resolve(ROOT, 'assets', 'vanilla')

/** 原版素材缓存目录（下载原件，人工核对与二次生成都靠它）。 */
const RAW_DIR = resolve(ASSET_DIR, 'raw')

/** 官方客户端 jar 缓存目录（几十 MB，不随仓库分发）。 */
const CACHE_DIR = resolve(ASSET_DIR, 'cache')

/**
 * 默认钉死的原版版本。
 *
 * 钉版本而不是「永远取最新」：贴图直接决定成品观感，构建必须可复现；
 * 而且 26.x 把 environment/sun.png 挪走了，跟随最新会莫名少一张图。
 * 要换版本显式 `--version=` 即可。
 */
const DEFAULT_VERSION = '1.21.4'

/** 官方版本清单。 */
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

/** jar 内贴图根路径。 */
const JAR_ROOT = 'assets/minecraft/'

/**
 * 需要的原版贴图。
 *
 * key 是客户端 TEX 的键；path 是 jar 内路径（相对 assets/minecraft/）。
 * required 为 false 的素材缺失只警告——不同版本增删过方块贴图，
 * 不该因为一张可选图让整条管线失败。
 */
export const TEXTURES = [
  // 草方块侧面要 base + overlay 两层合成（见 renderTextures），所以标 composite。
  { key: 'grass', file: 'grass_block_side', path: 'textures/block/grass_block_side.png', composite: true },
  // 游戏内侧面那层草其实是这张灰度 overlay 按生物群系染色后叠上去的，
  // base 自带的绿只是底衬。平原草色取 #91BD59，叠完才是游戏内观感。
  { key: 'grassOverlay', file: 'grass_block_side_overlay', path: 'textures/block/grass_block_side_overlay.png', required: false, internal: true },
  { key: 'dirt', file: 'dirt', path: 'textures/block/dirt.png' },
  { key: 'stone', file: 'stone', path: 'textures/block/stone.png' },
  { key: 'goldOre', file: 'gold_ore', path: 'textures/block/gold_ore.png' },
  { key: 'log', file: 'oak_log', path: 'textures/block/oak_log.png' },
  { key: 'planks', file: 'oak_planks', path: 'textures/block/oak_planks.png' },
  // 原版橡树树叶是灰度图，游戏内由生物群系染色；这里按平原的树叶色 #59AE30 预先染好
  // （客户端拿不到生物群系，也没必要为一个 2D 场景引入染色层）。
  { key: 'leaves', file: 'oak_leaves', path: 'textures/block/oak_leaves.png', tint: [89, 174, 48] },
  { key: 'table', file: 'crafting_table_front', path: 'textures/block/crafting_table_front.png' },
  { key: 'apple', file: 'apple', path: 'textures/item/apple.png' },
  { key: 'goldenApple', file: 'golden_apple', path: 'textures/item/golden_apple.png' },
  { key: 'bread', file: 'bread', path: 'textures/item/bread.png' },
  { key: 'goldIngot', file: 'gold_ingot', path: 'textures/item/gold_ingot.png' },
  { key: 'pickaxe', file: 'iron_pickaxe', path: 'textures/item/iron_pickaxe.png' },
  // HUD 图标：面板上的「饱食度 / 生命」用原版 HUD 贴图，比 🍖 / ❤ 这种 emoji 更像游戏。
  // 这三张都是可选——1.20.2 之后 GUI 贴图才搬到 gui/sprites 下，缺失时客户端自动退回 emoji。
  { key: 'foodFull', file: 'hud_food_full', path: 'textures/gui/sprites/hud/food_full.png', required: false },
  { key: 'heart', file: 'hud_heart_full', path: 'textures/gui/sprites/hud/heart/full.png', required: false },
  // 注：1.21.4 里没有 item/skeleton_skull.png（骷髅头贴图这个版本不在这个路径下），
  // 所以面板的「饿死次数」保留 ☠ emoji —— icon() 就是为这种「可选素材缺失」准备的。
  { key: 'villagerSkin', file: 'villager', path: 'textures/entity/villager/villager.png', internal: true },
]

/** 平原草色（原版草皮 overlay 的染色值）。 */
const GRASS_TINT = [145, 189, 89]

/** 解析命令行参数。 */
export function parseArgs(argv) {
  const options = { version: DEFAULT_VERSION, force: false, preview: false }
  for (const arg of argv) {
    if (arg === '--force') options.force = true
    else if (arg === '--preview') options.preview = true
    else if (arg.startsWith('--version=')) options.version = arg.slice('--version='.length)
  }
  return options
}

/** GET 一个 JSON。 */
async function fetchJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(url + ' → HTTP ' + String(response.status))
  return response.json()
}

/**
 * 取版本对应的官方客户端 jar（带本地缓存）。
 * @param version 版本号。
 * @param force 是否忽略缓存。
 * @returns jar 字节。
 */
async function loadClientJar(version, force) {
  await mkdir(CACHE_DIR, { recursive: true })
  const target = resolve(CACHE_DIR, 'client-' + version + '.jar')
  if (!force && existsSync(target)) return readFile(target)

  const manifest = await fetchJson(MANIFEST_URL)
  const entry = manifest.versions.find((item) => item.id === version)
  if (entry === undefined) throw new Error('版本清单里没有 ' + version)
  const detail = await fetchJson(entry.url)
  const client = detail.downloads.client
  if (client === undefined) throw new Error(version + ' 没有客户端下载项')
  const response = await fetch(client.url)
  if (!response.ok) throw new Error('客户端 jar 下载失败 HTTP ' + String(response.status))
  const bytes = Buffer.from(await response.arrayBuffer())
  await writeFile(target, bytes)
  return bytes
}

/**
 * 村民正视图合成。
 *
 * 村民在原版里是实体模型（头 + 鼻 + 长袍 + 腿），没有「正面站立图」这种现成贴图，
 * 所以按 MC 自己的模型 UV 把皮肤裁成正面各面片再拼成 16×32（一格宽两格高，与场景
 * 网格一致）。各面片的 UV 来自原版 VillagerModel 的 texOffs，逐个贴着注释写死；
 * 换版本时若皮肤布局变了，改这张表即可，不必动渲染代码。
 *
 * @param skin 原版 villager.png（64×64）。
 * @returns 16×32 的成品正视图。
 */
export function composeVillager(skin) {
  const out = createImage(16, 32)
  const parts = VILLAGER_PARTS(skin)
  for (const part of parts) blit(out, part.image, part.x, part.y)
  return out
}

/**
 * 村民各面片的裁切表（单独抽出来，方便对着 preview 调）。
 *
 * UV 公式（原版模型通用）：盒体 (dw, dh, dz) 放在 texOffs(u, v) 时，
 *   顶面 (u+dz, v)          尺寸 dw×dz
 *   底面 (u+dz+dw, v)       尺寸 dw×dz
 *   右侧 (u, v+dz)          尺寸 dz×dh
 *   正面 (u+dz, v+dz)       尺寸 dw×dh   ← 取这个
 *   左侧 (u+dz+dw, v+dz)    尺寸 dz×dh
 *   背面 (u+2dz+dw, v+dz)   尺寸 dw×dh
 * 注意竖直偏移是 **dz（深度）** 而不是 dh——这里最初就写错成 v+dh，
 * 结果整张图各面片都往下错了 2–6 像素，拼出来的「村民」身体是块灰墙。
 *
 * @param skin 原版 villager.png。
 * @returns { image, x, y } 数组，x/y 是贴到 16×32 画布上的位置。
 */
export function VILLAGER_PARTS(skin) {
  // 竖直排布对照原版 VillagerModel 的模型几何（模型单位，y 向下为正）：
  //   头   y = -10 … 0    10 高
  //   鼻   y =  -6 … -2    4 高（向前探出）
  //   身   y =   0 … 12   12 高
  //   臂   y =   1 …  9    8 高（挂在肩线下方）
  //   腿   y =  12 … 24   12 高
  // 总高 34 单位，村民模型整体缩放 0.9375 → 31.9 像素，正好收进 16×32 的画布。
  // 34 → 32 的压缩按部位摊掉（10 / 11 / 11），这样每个面片都能 1:1 贴、不重采样、
  // 也不用靠重叠硬塞：头 0–9 行、袍 10–20 行、腿 21–31 行，行数正好用满且不重叠。
  return [
    // 头 8×10×8 @ texOffs(0,0)：正面 = (0+8, 0+8) = (8,8)，尺寸 8×10 → 第 0–9 行
    // （ASCII 像素图核对：这一块里正好是额头 + 一字眉 + 绿眼）
    { image: crop(skin, 8, 8, 8, 10), x: 4, y: 0 },
    // 鼻 2×4×2 @ texOffs(24,0)：正面 = (24+2, 0+2) = (26,2)，尺寸 2×4
    // 模型里头占 -10…0、鼻占 -6…-2，即鼻在头的中下部 → 第 4–7 行
    { image: crop(skin, 26, 2, 2, 4), x: 7, y: 4 },
    // 腿 4×12×4 @ texOffs(0,22) 及 (16,22)：正面 = (0+4, 22+4) = (4,26) / (16+4, 26) = (20,26)
    // 腿只分到 11 行，砍掉的是被袍子压住的最上面一行 → 从贴图第 27 行起裁
    { image: crop(skin, 4, 27, 4, 11), x: 4, y: 21 },
    { image: crop(skin, 20, 27, 4, 11), x: 8, y: 21 },
    // 长袍 8×12×6 @ texOffs(16,20)：正面 = (16+6, 20+6) = (22,26)，尺寸 8×12 → 第 10–20 行
    // 同样只分到 11 行，砍掉最上面一行（贴着下颌的那道领口接缝，被头压住看不见），
    // 保留底部的腰带/下摆纹路——那是正视图里的视觉锚点。
    { image: crop(skin, 22, 27, 8, 11), x: 4, y: 10 },
    // 手臂 4×8×4 @ texOffs(44,22)：正面 = (44+4, 22+4) = (48,26)，尺寸 4×8。
    // ASCII 像素图核对：皮肤 cols 48-55 / rows 22-25 是顶面+底面的横带，
    // cols 44-59 / rows 26-33 是四个侧面，宽度正好 2×(dw+dz)=2×8=16，与内容范围吻合。
    // 原版两条手臂共用同一个 texOffs（模型里是两个盒体、贴图偏移相同），所以两处同源。
    // 竖直方向按模型 y=1…9 → 第 11–18 行（肩线在袍子顶行之下 1 行）。
    { image: crop(skin, 48, 26, 4, 8), x: 0, y: 11 },
    { image: crop(skin, 48, 26, 4, 8), x: 12, y: 11 },
  ]
}

/**
 * 生成全部成品贴图。
 *
 * 两个 special case：
 * - grass：base（草方块侧面）叠上按平原草色染过的 overlay，还原游戏内观感。
 * - villager：原版没有「正面站立图」，按模型 UV 从皮肤拼一张 16×32。
 * `internal: true` 的素材只做中间层，不进产物（省掉几百字节无用 data URI）。
 *
 * @param raw key → 解码后的图。
 * @returns key → data URI。
 */
export function renderTextures(raw) {
  const out = {}

  if (raw.grass !== undefined) {
    const grass = cloneImage(raw.grass)
    if (raw.grassOverlay !== undefined) {
      const overlay = cloneImage(raw.grassOverlay)
      if (isGrayscale(overlay)) multiplyTint(overlay, GRASS_TINT)
      alphaBlit(grass, overlay, 0, 0)
    }
    out.grass = toDataUri(grass)
  }

  for (const spec of TEXTURES) {
    if (spec.internal === true || spec.composite === true) continue
    const image = raw[spec.key]
    if (image === undefined) continue
    // 树叶这类贴图在不同版本里可能是灰度（等生物群系染色）也可能是成品，
    // 读像素判断，两种都出正确结果。
    if (spec.tint !== undefined && isGrayscale(image)) multiplyTint(image, spec.tint)
    out[spec.key] = toDataUri(image)
  }

  if (raw.villagerSkin !== undefined) out.villager = toDataUri(composeVillager(raw.villagerSkin))
  return out
}

/**
 * 写人工核对用拼图：16×16 贴图按 8 倍最近邻排网格，村民单独一张。
 * 像素画不放大根本看不出对错，这一步是给人眼看的。
 * @param raw key → 解码后的图。
 */
async function writePreview(raw) {
  const cell = 128
  const columns = 5
  const tiles = TEXTURES.filter((spec) => spec.key !== 'villagerSkin' && raw[spec.key] !== undefined)
  const rows = Math.ceil(tiles.length / columns)
  const sheet = createImage(columns * cell, rows * cell)
  tiles.forEach((spec, index) => {
    pasteCell(sheet, raw[spec.key], index % columns, Math.floor(index / columns), 16, 8)
  })
  const previewDir = resolve(ASSET_DIR, 'preview')
  await mkdir(previewDir, { recursive: true })
  await writeFile(resolve(previewDir, 'textures.png'), encodePng(sheet))

  // 村民：皮肤原件 4 倍 + 合成结果 8 倍并排，左边用来读 UV，右边用来验收观感。
  if (raw.villagerSkin !== undefined) {
    const skin = scaleNearest(raw.villagerSkin, 4)
    const composed = scaleNearest(composeVillager(raw.villagerSkin), 8)
    const sheetV = createImage(skin.width + 8 + composed.width, Math.max(skin.height, composed.height))
    blit(sheetV, skin, 0, 0)
    blit(sheetV, composed, skin.width + 8, 0)
    await writeFile(resolve(previewDir, 'villager.png'), encodePng(sheetV))
  }
}

/**
 * 执行整条管线。
 * @param options parseArgs 的结果。
 * @returns { version, report, count }。
 */
export async function buildTextures(options = {}) {
  const version = options.version ?? DEFAULT_VERSION
  await mkdir(RAW_DIR, { recursive: true })
  const jar = await loadClientJar(version, options.force === true)
  const entries = indexZip(jar)

  const raw = {}
  const report = []
  for (const spec of TEXTURES) {
    const jarPath = JAR_ROOT + spec.path
    const bytes = readZipEntry(jar, entries, jarPath)
    if (bytes === null) {
      if (spec.required === false) {
        report.push({ key: spec.key, path: spec.path, missing: true })
        continue
      }
      throw new Error(version + ' 的客户端 jar 里没有 ' + jarPath)
    }
    await writeFile(resolve(RAW_DIR, spec.file + '.png'), bytes)
    const image = decodePng(bytes)
    raw[spec.key] = image
    report.push({
      key: spec.key,
      path: spec.path,
      size: image.width + '×' + image.height,
      mean: meanColor(image),
      grayscale: isGrayscale(image),
      bytes: bytes.length,
    })
  }

  const textures = renderTextures(raw)
  await writeFile(resolve(ASSET_DIR, 'textures.json'), JSON.stringify(textures, null, 2) + '\n', 'utf8')
  if (options.preview === true) await writePreview(raw)
  return { version, report, count: Object.keys(textures).length }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2))
  const result = await buildTextures(options)
  console.log('Minecraft 原版版本: ' + result.version)
  for (const row of result.report) {
    if (row.missing) console.log('  缺失(可选) ' + row.key + '  ' + row.path)
    else console.log('  ' + row.key.padEnd(13) + row.size.padEnd(7) + ' 均值 rgb(' + row.mean.join(',') + ')'
      + (row.grayscale ? ' 灰度' : '     ') + '  ' + row.path)
  }
  console.log('生成 ' + String(result.count) + ' 张贴图 → assets/vanilla/textures.json')
  if (options.preview) console.log('预览 → assets/vanilla/preview/{textures,villager}.png')
}
