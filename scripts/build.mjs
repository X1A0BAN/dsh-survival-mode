/**
 * 构建脚本：把 src/ 打成可发布的 lib/ 产物，零依赖（只用 Node 内置模块）。
 *
 * 为什么不用 tsdown / esbuild 等官方预设：官方 client 预设深耦合 monorepo（要从
 * workspace 读 manifest、引用包内的 PLATFORM_MODULES 常量表），外部仓库无法直接复用。
 * 我们对模块表的需求只有两个——React 与 cordis 保持 external——所以自己生成
 * `__ModuleLoader__.load` 闭包工厂反而更可控、也不需要任何构建期依赖。
 *
 * 产物形态（与官方 tsdown.client.ts 的 outputOptions 一致）：
 *   banner: window.__ModuleLoader__.load({ id, factory: (require) => {
 *   intro:  var module = { exports: {} }; var exports = module.exports;
 *   footer: return module.exports; } });
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 原版贴图产物路径（由 scripts/vanilla-textures.mjs 生成）。 */
const VANILLA_TEX_PATH = ['assets', 'vanilla', 'textures.json']

/** 浏览器 bundle 的模块表请求必须保持 external；打进产物会造成第二份实例。 */
const ALLOWED_CLIENT_REQUIRES = new Set(['react'])

/**
 * 把客户端源码包成模块表闭包工厂。
 * @param id 包名，写进 load() 的 id。
 * @param source src/client/index.js 的内容。
 * @param constants 构建期注入的跨面常量：channel、endpoints 与 writeFields。
 * @param vanillaTex 构建期注入的 MC 原版贴图表（键 → PNG data URI）。
 * @returns 可直接被模块系统执行的 CJS 文本。
 */
export function wrapClientBundle(id, source, constants = { channel: '', endpoints: {}, writeFields: {} }, vanillaTex = {}) {
  // 只接受 `export default X` 这一种导出：其它 ESM 语法需要真正的转译器，
  // 与其半吊子支持，不如明确拒绝。
  const stripped = source.replace(/^export default\s/m, 'module.exports = ')
  if (/^\s*(import|export)\s/m.test(stripped)) {
    throw new Error('src/client/index.js 只允许 `export default`；其余 import/export 需要真正的打包器')
  }

  // 跨面常量由构建期从 bridge.mjs 注入：两端共用一个真值来源，不靠人肉同步。
  const injected = stripped.replace(
    /^const INJECTED = .*$/m,
    'const RPC_CHANNEL = ' + JSON.stringify(constants.channel) + ';\n'
    + 'const RPC_ENDPOINTS = ' + JSON.stringify(constants.endpoints) + ';\n'
    + 'const RPC_WRITE_FIELDS = ' + JSON.stringify(constants.writeFields) + ';',
  )
  if (injected === stripped) {
    throw new Error('src/client/index.js 缺少 `const INJECTED = …` 占位行：跨面常量无法注入')
  }

  // 原版贴图同样是构建期注入：源码里只留 `const VANILLA_TEX = {}` 占位行。
  // 注入的是 data URI 而不是文件路径，所以产物依旧自包含——运行期不需要
  // assets/ 目录，也就不会被 npm 的 files 白名单（不含 assets/）影响。
  const withTextures = injected.replace(
    /^const VANILLA_TEX = .*$/m,
    'const VANILLA_TEX = ' + JSON.stringify(vanillaTex) + ';',
  )
  if (withTextures === injected) {
    throw new Error('src/client/index.js 缺少 `const VANILLA_TEX = …` 占位行：原版贴图无法注入')
  }

  const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  for (const specifier of requires) {
    if (!ALLOWED_CLIENT_REQUIRES.has(specifier)) {
      throw new Error(
        '客户端半体请求了模块表之外的依赖 "' + specifier + '"：'
        + '跨插件值导入要么内联出重复实例，要么在运行时抛错。'
        + '需要通过 cordis 服务协作，或把该 specifier 加入 ALLOWED_CLIENT_REQUIRES 并申明为 dsh.client.external。',
      )
    }
  }

  return [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(id) + ',',
    '  factory: (require) => {',
    'var module = { exports: {} }; var exports = module.exports;',
    withTextures,
    'return module.exports;',
    '  },',
    '});',
    '',
  ].join('\n')
}

/**
 * 执行构建。
 * @returns 写出的文件列表。
 */
export async function build() {
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'))
  const id = manifest.name.replace(/^@[^/]+\//, '')
  const written = []

  await mkdir(resolve(ROOT, 'lib'), { recursive: true })

  // Host 半体是纯 ESM，直接复制（同时把相对导入保持在 src/ 内，lib 只放入口）。
  // lib/ 下的入口需要能 import 到 ../src/*，所以这里复制整棵 src 树。
  await mkdir(resolve(ROOT, 'lib'), { recursive: true })
  for (const file of ['config.mjs', 'state.mjs', 'tool.mjs', 'bridge.mjs', 'index.mjs']) {
    await copyFile(resolve(ROOT, 'src', file), resolve(ROOT, 'lib', file))
    written.push('lib/' + file)
  }

  const clientSource = await readFile(resolve(ROOT, 'src', 'client', 'index.js'), 'utf8')
  // 跨面常量在构建期从 bridge.mjs 注入，避免两端各写一份而悄悄漂移。
  const bridgeSource = await readFile(resolve(ROOT, 'src', 'bridge.mjs'), 'utf8')
  const bundle = wrapClientBundle(id, clientSource, {
    channel: readStringConst(bridgeSource, 'CHANNEL'),
    endpoints: readObjectConst(bridgeSource, 'ENDPOINTS'),
    writeFields: readObjectConst(bridgeSource, 'WRITE_FIELDS'),
  }, await readVanillaTextures())
  await writeFile(resolve(ROOT, 'lib', 'client.js'), bundle, 'utf8')
  written.push('lib/client.js')

  return written
}

/**
 * 读构建期要注入的原版贴图表。
 *
 * 文件缺失**不算错误**：客户端里留着完整的手绘回退层，出一个手绘风的包远好过
 * 让没跑过贴图管线的人直接构建失败。这里只提醒一句，并如实报告注入了多少张。
 *
 * @returns 键 → PNG data URI。
 */
async function readVanillaTextures() {
  const path = resolve(ROOT, ...VANILLA_TEX_PATH)
  if (!existsSync(path)) {
    console.warn('贴图: 没找到 assets/vanilla/textures.json —— 本次构建使用内置手绘像素画。'
      + '要换成 MC 原版贴图请先跑 `npm run textures`。')
    return {}
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('assets/vanilla/textures.json 不是键值对象')
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) {
      throw new Error('assets/vanilla/textures.json 的 "' + key + '" 不是 PNG data URI')
    }
  }
  console.log('贴图: 注入 ' + String(Object.keys(parsed).length) + ' 张 MC 原版贴图（assets/vanilla/textures.json）')
  return parsed
}

/**
 * 从 bridge.mjs 源码里读一个字符串常量。
 *
 * 用正则而非 import：bridge.mjs 是 ESM，而 build.mjs 想保持零依赖、也不想在
 * 构建期执行被测源码。
 *
 * @param source bridge.mjs 内容。
 * @param name 常量名。
 * @returns 常量值。
 */
function readStringConst(source, name) {
  const match = new RegExp('export const ' + name + " = '([^']*)'").exec(source)
  if (match === null) throw new Error('build: bridge.mjs 里找不到字符串常量 ' + name)
  return match[1]
}

/**
 * 从 bridge.mjs 源码里读一个字符串对象常量（`{ a: 'b', … }` 形状）。
 *
 * @param source bridge.mjs 内容。
 * @param name 常量名。
 * @returns 常量对象。
 */
function readObjectConst(source, name) {
  const block = new RegExp('export const ' + name + ' = \\{([\\s\\S]*?)\\}').exec(source)
  if (block === null) throw new Error('build: bridge.mjs 里找不到对象常量 ' + name)
  const result = {}
  for (const [, key, value] of block[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*'([^']*)'/g)) result[key] = value
  if (Object.keys(result).length === 0) throw new Error('build: 对象常量 ' + name + ' 里没解析出字段')
  return result
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const written = await build()
  for (const file of written) console.log('built ' + file)
}
