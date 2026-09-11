/**
 * boot 契约测试：`inject` 声明 + 在真 cordis 里加载 Host 半体。
 *
 * 这一层存在的理由：`lib/index.mjs` 能 import、`--dump-config` 能组合出条目，
 * 都**不**证明插件能被真加载器加载。实测过的两个真实事故：
 *
 *   1. 裸包名 `@deepseek-ai/dsh-tools` 解析失败——加载环境缺 node_modules，
 *      插件树加载失败（这条由本文件顶部的 import 直接覆盖）。
 *   2. `ctx.setInterval()` 未声明 `inject: ['timer']`——cordis 作用域代理抛
 *      `cannot get property "timer" without inject`，整个插件树加载失败。
 *
 * 关于第 2 条的诚实说明：cordis 的 `ctx.mixin("timer", [...])` 把 `interval`、
 * `setInterval`、`timeout` 等六个方法全部挂在 **"timer" 服务**之下，因此访问其中
 * 任何一个都必须声明该服务。生产环境的崩溃栈精确指向 `ctx.setInterval`，
 * 而 DSH 的 fiber 层级比这里的测试宿主更深、约束更强，所以**最可靠的判据是
 * 下面的 inject 断言**；真 cordis 加载那段负责保证加载链路本身没坏。
 */

import { Context } from '@deepseek-ai/cordis'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.mjs'

test('inject 声明了 apply() 真正访问的每一个服务', () => {
  // 这是本文件最关键的一条：apply() 会调用 ctx.interval()，而 interval 由
  // "timer" 服务经 ctx.mixin 提供，漏声明会让 apply() 抛错、插件树加载失败。
  assert.ok(
    inject.includes('timer'),
    "inject 必须含 'timer'：ctx.interval() / ctx.setInterval() 都归属 timer 服务",
  )
  // apply() 里 `ctx.tools` / `ctx.systemPrompt` 是硬依赖，且已在顶部取用。
  assert.ok(inject.includes('tools'), "inject 必须含 'tools'")
  assert.ok(inject.includes('systemPrompt'), "inject 必须含 'systemPrompt'")
})

test('Host 半体能在真 cordis 里加载完成（含真实 timer 服务）', async () => {
  assert.equal(name, 'dsh-survival-mode')

  const ctx = new Context()
  // 真 timer 服务；tools/systemPrompt 用最小替身，apply() 对它们只读不写。
  ctx.plugin(TimerService)
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('systemPrompt', { section: () => () => {} })

  try {
    // 同步应用；若 apply() 抛错（如漏 inject）这里会直接冒出来。
    ctx.plugin({ name, inject, apply })
    // 让 cordis 把 fiber 推进到稳定态；期间若有未捕获错误，进程会以非零码退出。
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    await ctx.fiber.dispose()
  }
})
