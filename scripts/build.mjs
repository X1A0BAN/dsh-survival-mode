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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 浏览器 bundle 的模块表请求必须保持 external；打进产物会造成第二份实例。 */
const ALLOWED_CLIENT_REQUIRES = new Set(['react'])

/**
 * 把客户端源码包成模块表闭包工厂。
 * @param id 包名，写进 load() 的 id。
 * @param source src/client/index.js 的内容。
 * @returns 可直接被模块系统执行的 CJS 文本。
 */
export function wrapClientBundle(id, source) {
  // 只接受 `export default X` 这一种导出：其它 ESM 语法需要真正的转译器，
  // 与其半吊子支持，不如明确拒绝。
  const stripped = source.replace(/^export default\s/m, 'module.exports = ')
  if (/^\s*(import|export)\s/m.test(stripped)) {
    throw new Error('src/client/index.js 只允许 `export default`；其余 import/export 需要真正的打包器')
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
    stripped,
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
  for (const file of ['config.mjs', 'state.mjs', 'index.mjs']) {
    await copyFile(resolve(ROOT, 'src', file), resolve(ROOT, 'lib', file))
    written.push('lib/' + file)
  }

  const clientSource = await readFile(resolve(ROOT, 'src', 'client', 'index.js'), 'utf8')
  const bundle = wrapClientBundle(id, clientSource)
  await writeFile(resolve(ROOT, 'lib', 'client.js'), bundle, 'utf8')
  written.push('lib/client.js')

  return written
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const written = await build()
  for (const file of written) console.log('built ' + file)
}
