/**
 * Host↔Client 桥的契约测试。
 *
 * 覆盖两个真实事故点：
 *   1. 面板取不到宿主状态就静默不渲染——修复前客户端 `ctx.get('survivalState')`
 *      在浏览器里永远是 undefined，两者之间没有任何通道。
 *   2. 端点路由 / 请求体字段名 / 信封形状写歪，表现为面板永远停在占位数据，
 *      或按钮点了没反应。
 *
 * 桥是纯逻辑，全部用假 service 驱动：不需要 cordis，也不需要浏览器。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  CHANNEL,
  ENDPOINTS,
  WRITE_FIELDS,
  createHostHandler,
  mountHostBridge,
} from '../lib/bridge.mjs'

/** 造一个记录调用并返回脚本化结果的假状态机。 */
function fakeSurvival() {
  const calls = []
  const snapshot = { hunger: 100, maxHunger: 150, health: 12, maxHealth: 12, stepCount: 3 }
  return {
    calls,
    snapshot: () => ({ ...snapshot }),
    feed: (food) => {
      calls.push(['feed', food])
      return { ok: true, message: '已喂食 ' + food }
    },
    applyPreset: (id) => {
      calls.push(['preset', id])
      return { ok: true, message: '已切换 ' + id }
    },
    configure: (patch) => {
      calls.push(['configure', patch])
      return { ok: true, message: '已保存' }
    },
    reset: () => {
      calls.push(['reset'])
      return { ok: true, message: '已重置' }
    },
    harvest: (source) => {
      calls.push(['harvest', source])
      return { ok: true, gained: { item: 'bread', count: 1 }, message: '村民送了你 1 个面包！' }
    },
    craft: (recipe) => {
      calls.push(['craft', recipe])
      return { ok: true, gained: { item: 'golden_apple', count: 1 }, message: '合成成功：金苹果 ×1！' }
    },
  }
}

test('宿主 handler 覆盖每个端点，信封形状符合传输层约定', async () => {
  const survival = fakeSurvival()
  const handle = createHostHandler(survival, {
    presets: [{ id: 'normal', label: '普通' }],
    foods: [{ key: 'apple', label: '苹果', hunger: 25 }],
  })

  const snap = await handle(ENDPOINTS.snapshot, {})
  assert.equal(snap.ok, true)
  assert.equal(snap.value.hunger, 100)

  const meta = await handle(ENDPOINTS.meta, {})
  assert.equal(meta.ok, true)
  assert.equal(meta.value.presets.length, 1)
  assert.equal(meta.value.foods[0].key, 'apple')

  // 六个写操作都要回传最新快照，客户端据此立即刷新而不必等下一次轮询。
  for (const [endpoint, payload] of [
    [ENDPOINTS.feed, { [WRITE_FIELDS.feed]: 'apple' }],
    [ENDPOINTS.preset, { [WRITE_FIELDS.preset]: 'hard' }],
    [ENDPOINTS.configure, { [WRITE_FIELDS.configure]: { tickSeconds: 1 } }],
    [ENDPOINTS.reset, {}],
    [ENDPOINTS.harvest, { [WRITE_FIELDS.harvest]: 'villager' }],
    [ENDPOINTS.craft, { [WRITE_FIELDS.craft]: 'golden_apple' }],
  ]) {
    const response = await handle(endpoint, payload)
    assert.equal(response.ok, true, endpoint + ' 应该成功')
    assert.ok(response.value.snapshot, endpoint + ' 应回传 snapshot')
    assert.ok(response.value.result, endpoint + ' 应回传 result')
  }
  assert.deepEqual(survival.calls.map((c) => c[0]), ['feed', 'preset', 'configure', 'reset', 'harvest', 'craft'])
})

test('写操作字段名与宿主读取的字段端到端对齐', async () => {
  // 这是最容易悄悄写歪的一处：客户端发 { food } 而宿主读 body.food。
  // 用 WRITE_FIELDS 拼请求体，模拟真实客户端，宿主必须认得。
  const survival = fakeSurvival()
  const handle = createHostHandler(survival)
  assert.equal((await handle(ENDPOINTS.feed, { [WRITE_FIELDS.feed]: 'apple' })).ok, true)
  assert.equal((await handle(ENDPOINTS.preset, { [WRITE_FIELDS.preset]: 'hard' })).ok, true)
  assert.equal((await handle(ENDPOINTS.configure, { [WRITE_FIELDS.configure]: { tickSeconds: 2 } })).ok, true)
  assert.equal((await handle(ENDPOINTS.harvest, { [WRITE_FIELDS.harvest]: 'mine' })).ok, true)
  assert.equal((await handle(ENDPOINTS.craft, { [WRITE_FIELDS.craft]: 'golden_apple' })).ok, true)
  assert.deepEqual(survival.calls.map((c) => c[0]), ['feed', 'preset', 'configure', 'harvest', 'craft'])
})

test('非法入参返回失败信封而不是抛出', async () => {
  const handle = createHostHandler(fakeSurvival())
  for (const [endpoint, payload] of [
    [ENDPOINTS.feed, {}],
    [ENDPOINTS.feed, { [WRITE_FIELDS.feed]: '' }],
    [ENDPOINTS.preset, {}],
    [ENDPOINTS.harvest, {}],
    [ENDPOINTS.craft, { [WRITE_FIELDS.craft]: '' }],
    ['nope', {}],
  ]) {
    const response = await handle(endpoint, payload)
    assert.equal(response.ok, false, endpoint + ' 应被拒绝')
    assert.equal(typeof response.error.code, 'string')
    assert.equal(typeof response.error.message, 'string')
    assert.ok(response.error.details !== undefined)
  }
})

test('宿主把 service 抛错转成失败信封，不冒泡打断连接', async () => {
  const handle = createHostHandler({
    snapshot: () => ({}),
    feed: () => {
      throw new Error('厨房炸了')
    },
  })
  const response = await handle(ENDPOINTS.feed, { [WRITE_FIELDS.feed]: 'apple' })
  assert.equal(response.ok, false)
  assert.equal(response.error.message, '厨房炸了')
})

test('mountHostBridge 注册 channel 并在卸载时反注册', () => {
  const registered = []
  let cleanup = null
  const mounted = mountHostBridge({
    survival: fakeSurvival(),
    meta: { presets: [], foods: [] },
    connection: {
      rpc: {
        handle: (channel, handler) => {
          registered.push({ channel, handler })
          return () => registered.pop()
        },
      },
    },
    effect: (fn) => {
      cleanup = fn()
    },
    log: () => {},
  })
  assert.equal(mounted, true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].channel, CHANNEL)
  assert.equal(typeof registered[0].handler, 'function')
  cleanup()
  assert.equal(registered.length, 0, 'effect 清理应反注册 channel')
})

test('mountHostBridge 没有 connection 时安静返回，不影响宿主其余功能', () => {
  const logs = []
  const mounted = mountHostBridge({
    survival: fakeSurvival(),
    connection: undefined,
    effect: () => {},
    log: (message) => logs.push(message),
  })
  assert.equal(mounted, false)
  assert.equal(logs.length, 1, '应留下一条日志便于排查')
})

test('客户端 bundle 注入了与宿主一致的 channel、端点与字段映射', async () => {
  // 客户端是 CommonJS 且构建只允许 require('react')，无法 import 这份 ESM 契约，
  // 所以常量靠构建期注入。这条用例是"两端不漂移"的守门人。
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(
    source.includes('const RPC_CHANNEL = ' + JSON.stringify(CHANNEL)),
    'bundle 里的 channel 必须与 bridge.mjs 一致',
  )
  for (const endpoint of Object.values(ENDPOINTS)) {
    assert.ok(source.includes(JSON.stringify(endpoint)), 'bundle 缺少端点 ' + endpoint)
  }
  for (const field of Object.values(WRITE_FIELDS)) {
    assert.ok(source.includes(field), 'bundle 缺少写字段 ' + field)
  }
  assert.ok(!source.includes('const INJECTED'), '构建期占位行应已被替换掉')
})
