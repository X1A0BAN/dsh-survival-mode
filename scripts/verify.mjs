/**
 * 产物自检：发布前跑一遍，确认 lib/ 真的可以被 profile 挂载。
 *
 * 检查的都是实际踩过的坑，而不是形式化的"文件存在"：
 * - client bundle 必须带 __ModuleLoader__ 闭包工厂包裹（否则浏览器侧静默不加载）
 * - client bundle 不得内联模块表之外的依赖（否则出现第二份 React 实例）
 * - Host 入口必须能被 import（语法错误这里就会炸）
 * - 包清单的 dsh.bundle.patch / dsh.client / exports 必须齐备
 * - package.json 里不得出现 OWNER 之类的占位符
 * - files 声明的每一项都必须真实存在（否则 npm pack 后的产物缺文件）
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const notes = []

/**
 * 断言一项检查。
 * @param condition 是否通过。
 * @param message 失败时给出的说明。
 */
function check(condition, message) {
  if (condition) notes.push('  ok   ' + message)
  else failures.push(message)
}

/**
 * 读取文件内容，不存在时返回 null。
 * @param relative 相对仓库根的路径。
 */
async function readIfExists(relative) {
  try {
    return await readFile(resolve(ROOT, relative), 'utf8')
  } catch {
    return null
  }
}

/**
 * 判断路径是否存在。
 * @param relative 相对仓库根的路径。
 */
async function exists(relative) {
  try {
    await stat(resolve(ROOT, relative))
    return true
  } catch {
    return false
  }
}

export async function verify() {
  const manifestText = await readIfExists('package.json')
  check(manifestText !== null, 'package.json 存在')
  if (manifestText === null) return { failures, notes }

  const manifest = JSON.parse(manifestText)

  // 占位符没替换会让安装说明与既有元数据直接对不上号。
  check(!/OWNER/.test(manifestText), 'package.json 里没有 OWNER 占位符')
  check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 指向 cordis.patch.yml')
  check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform 是 web')
  check(Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0,
    'dsh.client.inject 声明了客户端模块请求')
  check(manifest.exports?.['./client'] === './lib/client.js', 'exports["./client"] 指向 lib/client.js')
  check(typeof manifest.main === 'string' && manifest.main.startsWith('lib/'), 'main 指向 lib/')

  // files 声明漏项会让 npm pack / git 安装的产物不完整。
  for (const entry of manifest.files ?? []) {
    check(await exists(entry), 'files 声明的 ' + entry + ' 存在')
  }
  check(await exists('cordis.patch.yml'), 'cordis.patch.yml 存在')
  check(await exists('LICENSE'), 'LICENSE 存在')

  const patch = await readIfExists('cordis.patch.yml')
  check(patch !== null && patch.includes('insert:'), 'cordis.patch.yml 含 insert 行')
  check(patch !== null && patch.includes(String(manifest.name)), 'cordis.patch.yml 引用了包名')

  // 纯逻辑模块没有任何外部依赖，可以真正 import 进来——这同时是语法校验。
  // 不用 `node --check` 子进程：受限沙箱会以 EPERM 拒绝 spawn，那会被误读成语法错误。
  for (const module of ['config.mjs', 'state.mjs']) {
    try {
      const loaded = await import(pathToFileURL(resolve(ROOT, 'lib', module)).href)
      check(Object.keys(loaded).length > 0, 'lib/' + module + ' 可加载且导出成员')
    } catch (error) {
      failures.push('lib/' + module + ' 无法加载：' + String(error))
    }
  }

  // Host 入口：用动态 import 真正加载一次，语法/导出错误在这里就会暴露。
  //
  // Windows 上 import() 只接受 file:// URL，裸盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
  //
  // Host 半体 import 了 @deepseek-ai/dsh-tools，而官方包由 profile 的 pnpm 闭包在挂载时
  // 注入、刻意不进本仓库依赖，因此在未安装依赖的干净 checkout 里必然解析不到。这种情况
  // 记为"跳过"而不是失败，但源码必须仍然通过静态检查——否则等于悄悄放弃这项验证。
  let hostLoaded = false
  try {
    const host = await import(pathToFileURL(resolve(ROOT, 'lib', 'index.mjs')).href)
    hostLoaded = true
    check(typeof host.apply === 'function', 'lib/index.mjs 导出 apply 函数')
    check(typeof host.name === 'string' && host.name.length > 0, 'lib/index.mjs 导出 name')
    check(Array.isArray(host.inject) && host.inject.includes('tools'), 'Host 声明 inject 含 tools')
  } catch (error) {
    const message = String(error)
    if (message.includes('ERR_MODULE_NOT_FOUND')) {
      notes.push('  skip lib/index.mjs 运行时加载（@deepseek-ai/dsh-tools 未安装，属预期）')
    } else {
      failures.push('lib/index.mjs 无法加载：' + message)
    }
  }

  // 与运行时无关的静态检查：这两项在干净 checkout 里也必须成立。
  const hostSource = await readIfExists('lib/index.mjs')
  check(hostSource !== null && /export function apply\s*\(/.test(hostSource),
    'lib/index.mjs 声明导出 apply')
  check(hostSource !== null && /export const inject\s*=/.test(hostSource),
    'lib/index.mjs 声明导出 inject')
  if (!hostLoaded) notes.push('  note Host 运行时加载未经本次校验，装进 profile 后请以实际挂载为准')

  // 客户端 bundle：包裹形态与模块表纯净度。
  const bundle = await readIfExists('lib/client.js')
  check(bundle !== null, 'lib/client.js 存在')
  if (bundle !== null) {
    check(bundle.includes('window.__ModuleLoader__.load('), 'client bundle 带 __ModuleLoader__.load 包裹')
    check(bundle.includes('factory: (require) =>'), 'client bundle 使用闭包工厂形态')
    check(/return module\.exports;\s*\}/.test(bundle), 'client bundle 正确返回 module.exports')

    // 模块系统会直接执行这段文本，语法错要到浏览器里才暴露——这里就地编译一次。
    try {
      // eslint-disable-next-line no-new-func -- 仅用于编译校验，不执行
      new Function(bundle)
      check(true, 'client bundle 语法有效')
    } catch (error) {
      failures.push('client bundle 语法错误：' + String(error))
    }

    const requires = [...bundle.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
    const allowed = new Set(['react'])
    const offending = requires.filter((specifier) => !allowed.has(specifier))
    check(offending.length === 0,
      'client bundle 只用模块表依赖' + (offending.length > 0 ? '（越界：' + offending.join(', ') + '）' : ''))

    // 打包器若把 React 内联进来，产物里会出现 jsx 运行时特征。
    check(!/react\.production\.min\.js|__SECRET_INTERNALS/.test(bundle), 'client bundle 未内联 React 实现')
  }

  return { failures, notes }
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const result = await verify()
  for (const line of result.notes) console.log(line)
  if (result.failures.length > 0) {
    console.error('\n产物自检未通过：')
    for (const line of result.failures) console.error('  FAIL ' + line)
    process.exit(1)
  }
  console.log('\n产物自检通过（' + result.notes.length + ' 项）')
}
