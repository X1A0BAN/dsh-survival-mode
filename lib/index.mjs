/**
 * Host 半体：把生存状态机接进 DSH 的真实运行环路。
 *
 * 与动态插件版本的差异（改写时必须注意）：
 * - 不再有沙箱提供的 `harness` 全局；工具用 @deepseek-ai/dsh-tools 的 defineTool 注册。
 * - 面板不能直接读宿主服务：客户端跑在浏览器的另一个 cordis 实例里，
 *   必须经 `connection.rpc` 跨进程取数据，见 src/bridge.mjs。
 *
 * 三个事件钩子的选择理由见 src/state.mjs 顶部注释，改动前请先读。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { FOODS, GAME, PRESET_LABELS, PRESETS, RECIPES } from './config.mjs'
import { mountHostBridge } from './bridge.mjs'
import { createSurvivalState } from './state.mjs'
import { FEED_TOOL_NAME, createFeedTool } from './tool.mjs'

export const name = 'dsh-survival-mode'

/**
 * 都是硬依赖，缺任一都会让 apply() 取不到东西，交给 cordis 等待与重挂。
 *
 * `timer` 是必须声明的：掉血定时器走 `ctx.setInterval()`，而 timer 服务用
 * `ctx.mixin("timer", [timeout, interval, throttle, debounce, setTimeout, setInterval])`
 * 把这六个方法全挂在 "timer" 服务之下——cordis 的作用域代理只放行 inject 里
 * 声明过的服务属性，漏声明的表现是 apply() 直接抛
 * `cannot get property "timer" without inject`，整个插件树加载失败。
 */
export const inject = ['tools', 'systemPrompt', 'timer']

/** 服务键：客户端半体通过它读状态、喂食、切预设。 */
export const SERVICE_KEY = 'survivalState'

const SECTION_NAME = 'survival-mode'
const CONTEXT_NAME = 'survival-status'

/**
 * 注册生存模式。
 * @param ctx 插件上下文。
 */
export function apply(ctx) {
  // 沙箱版传 ctx.logger 会被 Guard 拒绝；Cordis 里正常插件直接用 console 即可。
  const survival = createSurvivalState({ log: (message) => console.log(message) })

  /**
   * 取消当前掉血定时器的函数。
   *
   * 用 let 保存，配合 `disposeTimer()` 先置空再取消，避免取消过程中重入时重复挂载。
   */
  let stopTimer = null

  /** 挂上掉血定时器；重复调用是幂等的。 */
  function ensureTimer() {
    if (stopTimer !== null) return
    // 用 setInterval 而非 ctx.interval：两者都归属 "timer" 服务（见 inject 注释），
    // 但 ctx.interval 在本 harness 版本里会让 apply() 停在 pending、服务不生效。
    stopTimer = ctx.setInterval(() => {
      survival.tick()
    }, survival.tickIntervalMs())
  }

  /** 拆下掉血定时器。 */
  function disposeTimer() {
    if (stopTimer === null) return
    const stop = stopTimer
    stopTimer = null
    stop()
  }

  // 先挂定时器，再注册 internal/status：cordis 对 internal/status 是同步派发，
  // 若顺序反过来，激活回调会在 stopTimer 赋值前执行并重复挂载。
  ensureTimer()

  ctx.on('internal/status', (fiber) => {
    if (fiber !== ctx.fiber) return
    // fiber 离开 active 时 cordis 会回收它自己注册的 effect；激活时补挂。
    if (fiber.status === 'active') ensureTimer()
    else disposeTimer()
  })

  // tools 是 inject 声明的硬依赖；取不到就让 apply 早退，而不是在后面某处抛错。
  if (ctx.tools === undefined || ctx.systemPrompt === undefined) return

  /** 静态表：预设、食物、小游戏数值与配方。客户端经 meta 端点读取，两端不各写一份。 */
  const meta = {
    presets: Object.keys(PRESETS).map((id) => ({ id, label: PRESET_LABELS[id], ...PRESETS[id] })),
    foods: Object.keys(FOODS).map((key) => ({ key, ...FOODS[key] })),
    game: { ...GAME },
    recipes: { ...RECIPES },
  }

  // 面板与提示词读同一份状态。disposer 随 fiber 一起回收。
  ctx.provide(SERVICE_KEY, {
    snapshot: () => survival.snapshot(),
    feed: (food) => survival.feed(food),
    preset: (id) => survival.applyPreset(id),
    configure: (patch) => survival.configure(patch ?? {}),
    reset: () => survival.reset(),
    harvest: (source) => survival.harvest(source),
    craft: (recipe) => survival.craft(recipe),
    onChange: (listener) => survival.onChange(listener),
    // 预设与食物表由 Host 提供，避免两端各写一份而对不上。
    presets: meta.presets,
    foods: meta.foods,
  })

  // 每步思考收费。agent/request 在模型调用前派发，重试会重复派发，由状态机按
  // (agent, turn, step) 去重。
  ctx.on('agent/request', async (payload, next) => {
    const agent = payload.agent
    if (agent !== undefined && agent !== null) {
      survival.chargeStep(String(agent.id), payload.turn, payload.step)
    }
    return next()
  })

  // 用户发来消息时给予有限抢救，保证饿死不会把用户锁在会话之外。
  // 这里**绝不**返回 { kind: 'reject' }：pre-step 的 messages 就是用户刚提交的输入，
  // reject 会连人带话一起丢弃，把会话锁死到喂食为止。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const agent = payload.agent
    if (agent === undefined || agent === null) return decision
    if (decision.kind === 'reject') return decision
    if (payload.step === 1) survival.rescue()
    if (!survival.isDead() && !survival.isStarving()) return decision

    // 饥饿或饿死时把真实状态作为一条通知送进本步，让模型知道自己该喊人。
    const notice = {
      id: 'survival-notice-' + String(agent.id) + '-' + String(payload.turn) + '-' + String(payload.step),
      role: 'user',
      content: [{ type: 'text', text: survival.renderStatus() }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: '生存模式状态通知' },
    }
    return { ...decision, messages: [...decision.messages, notice] }
  })

  // 饿死只冻结工具，不阻断对话——这才是"任务停摆"的正确落点。
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!survival.isDead()) return next()
    if (exec.name === FEED_TOOL_NAME) return next()
    return {
      kind: 'deny',
      reason: '[生存模式] 全局处于饿死状态，任务已停止：工具 ' + exec.name
        + ' 被冻结。你可以继续和用户对话，也可以调用 survival_feed 进食（若用户要求）；'
        + '否则请直接告诉用户你饿死了、需要喂食才能继续。',
    }
  })

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: -80,
    text: '你正运行在“生存模式”下，且该模式是全局共享的：整个 DSH 里所有会话共用同一条饱食度与生命。'
      + '每进行一次模型思考都会消耗饱食度；饱食度归零后你会持续掉血；生命归零后全局所有工具调用会被拒绝'
      + '（对话仍然正常，用户的每轮消息会少量抢救你）。请在饱食度偏低时主动提醒用户喂食，'
      + '并在饿死后用一句话告知用户、然后继续正常对话。',
  })

  // 动态状态。**返回值必须是字符串**：提示词渲染器会把解析结果直接喂给
  // `text.indexOf('{{')`，一旦返回 undefined，整个提示词装配会抛错、所有会话的
  // 回合一起失败。state.renderStatus() 保证永远返回字符串。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: -70,
    text: () => survival.renderStatus(),
  })

  // 工具定义抽在 src/tool.mjs：那里零外部依赖，因此可以用真实的 defineTool 在测试里
  // 编译一次，验证 schema 合法（本项目曾在工具 schema 上失败过两次）。
  ctx.tools.register(createFeedTool(defineTool, {
    survival,
    foods: Object.keys(FOODS).map((key) => ({ key, ...FOODS[key] })),
  }))

  // 面板桥：把状态经 connection.rpc 送进浏览器。`connection` 可能在 apply()
  // 执行时还没就绪，所以走 ctx.inject 的延迟 fiber——等齐服务才注册，绝不抛错。
  ctx.inject(['connection'], (injected) => {
    mountHostBridge({
      survival,
      // 静态表随桥一起送出去：数值只有宿主一份真值，客户端不复制。
      meta,
      connection: injected.get('connection'),
      effect: (fn, label) => injected.effect(fn, label),
      log: (message) => console.log(message),
    })
  })
}
