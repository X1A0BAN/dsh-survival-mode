/**
 * 契约测试：用真实的 @deepseek-ai/dsh-tools 编译本插件的工具定义。
 *
 * 为什么值得单独测：本项目开发期间有两次失败都出在工具 schema 上——
 *   1. `parameters` 根上的 additionalProperties: false 被拒（隐式根是开放的）
 *   2. `output.schema` 根上的 required 被拒（值根的必填必须逐属性声明）
 * 这两条只有让真正的 defineTool 编译一次才能验证，光读代码看不出来。
 *
 * 依赖定位：本仓库刻意不依赖官方包（它们由 profile 的 pnpm 闭包在挂载时注入），
 * 所以这里从 DSH 部署目录里找 dsh-tools。找不到就跳过——不把机器相关路径写成硬失败。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { FOODS } from '../src/config.mjs'
import { createSurvivalState } from '../src/state.mjs'
import { FEED_TOOL_NAME, createFeedTool } from '../src/tool.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 部署目录里 dsh-tools 的候选位置。 */
const CANDIDATES = [
  process.env.DSH_APP_ROOT === undefined
    ? null
    : resolve(process.env.DSH_APP_ROOT, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js'),
  'C:/Users/xiao/AppData/Local/Programs/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  'C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter((candidate) => candidate !== null)

/**
 * 定位真实的 dsh-tools 模块。
 * @returns 可 import 的 URL，或 null 表示本机找不到。
 */
function locateDshTools() {
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return pathToFileURL(candidate).href
  }
  return null
}

test('survival_feed 工具定义能被真实的 defineTool 编译', async (t) => {
  const url = locateDshTools()
  if (url === null) {
    t.skip('本机找不到 @deepseek-ai/dsh-tools；装进 profile 后请以实际挂载为准')
    return
  }
  const { defineTool } = await import(url)

  const survival = createSurvivalState({ preset: 'normal' })
  const foods = Object.keys(FOODS).map((key) => ({ key, ...FOODS[key] }))

  // 这一步就是关键：schema 非法时 defineTool 会直接抛错。
  const tool = createFeedTool(defineTool, { survival, foods })

  assert.equal(tool.name, FEED_TOOL_NAME)
  assert.equal(tool.parameters.type, 'object', '参数根应被编译成 object')
  assert.deepEqual(tool.parameters.required, ['food'], 'food 应是唯一必填参数')
  assert.equal(tool.parameters.additionalProperties, undefined,
    '参数根是隐式开放对象，不得带 additionalProperties')
  assert.equal(tool.output.schema.additionalProperties, false,
    '值根必须显式声明 additionalProperties')

  // 执行一次，确认返回值满足 output.schema 的形状（四个字段都要在）。
  const value = await tool.execute({ food: 'steak' }, {})
  for (const key of ['eat', 'hunger', 'health', 'dead']) {
    assert.notEqual(value[key], undefined, '工具返回值缺少字段 ' + key)
  }
  assert.equal(typeof value.hunger, 'number')
  assert.equal(typeof value.dead, 'boolean')
})

test('Host 半体注册的钩子与提示词符合预期', () => {
  // 用源码静态核对：Host 入口 import 了官方包，在干净 checkout 里无法加载执行，
  // 所以这里核对的是"注册了哪些名字"，而不是运行时行为（那要靠真实挂载验证）。
  const source = readFileSync(resolve(ROOT, 'src/index.mjs'), 'utf8')

  for (const event of ['agent/request', 'agent/pre-step', 'tools/pre-execute']) {
    assert.ok(source.includes("'" + event + "'"), '应监听 ' + event)
  }

  // 这两条是踩过坑的硬约束，用断言把它们钉在这里，防止日后被"顺手改成更直观的写法"。
  assert.ok(!/return\s*\{\s*kind:\s*'reject'/.test(source),
    'pre-step 绝不能返回 reject：那会连用户刚提交的输入一起丢弃')
  assert.ok(source.includes('systemPrompt.context'),
    '应注册动态状态上下文')
  assert.ok(!/systemPrompt[\s\S]{0,200}context\([\s\S]{0,400}return undefined/.test(source),
    '动态上下文不得返回 undefined：那会让所有会话的回合一起失败')
})
