/**
 * 包文件清单：复刻 npm 的 `files` 匹配规则，回答"用户装到的到底是什么"。
 *
 * 为什么不用 `npm pack --dry-run`：它会写 npm 缓存（受限环境直接 EPERM），
 * 而且把一个可枚举的规则交给外部命令也不如自己断言来得清楚。
 *
 * 规则（简化到本仓库实际用到的形态）：
 * - `files` 里每一项按仓库根解析；目录表示整棵子树，文件表示单个文件；
 * - 含 `*` 的项按 glob 展开；
 * - package.json / README / LICENSE 即便未列入也总会被打包，所以不靠它们判断漏项。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

/**
 * 递归列出目录下的所有文件（相对路径，统一用 `/`）。
 * @param root 仓库根。
 * @param start 起始目录（相对根）。
 * @returns 相对路径列表。
 */
async function walk(root, start) {
  const found = []
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()
    const absolute = join(root, current)
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const next = join(current, entry.name)
      if (entry.isDirectory()) stack.push(next)
      else if (entry.isFile()) found.push(next.split(sep).join('/'))
    }
  }
  return found
}

/**
 * 把含 `*` 的 glob 转成正则。只支持 `*`（匹配任意层）与 `?`。
 * @param pattern glob 文本。
 * @returns 正则。
 */
function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp('^' + escaped + '$')
}

/**
 * 计算一个包实际会包含的文件清单。
 * @param root 仓库根目录。
 * @returns 排序后的相对路径列表。
 */
export async function listPackedFiles(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const patterns = manifest.files ?? []
  const all = await walk(root, '.')
  const matched = new Set()

  for (const raw of patterns) {
    const pattern = raw.replace(/\/+$/, '')
    if (!pattern.includes('*') && !pattern.includes('?')) {
      // 无通配：可能是文件，也可能是目录
      const absolute = join(root, pattern)
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        for (const file of all) {
          if (file === pattern + '/' || file.startsWith(pattern + '/')) matched.add(file)
        }
      } else {
        matched.add(pattern)
      }
      continue
    }
    const regexp = globToRegExp(pattern)
    for (const file of all) {
      if (regexp.test(file)) matched.add(file)
    }
  }
  return [...matched].sort()
}
