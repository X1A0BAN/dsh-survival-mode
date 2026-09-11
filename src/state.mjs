/**
 * 生存模式的核心状态机。
 *
 * 设计要点（都是之前实践里踩出来的，改动前请先读）：
 *
 * 1. **全局唯一**。整个 DSH 进程只有一份饱食度/生命，所有会话共享。早期版本按
 *    会话分开存，喂食要依赖"最后活动会话"指针去猜目标，导致多开时喂错对象、
 *    表现为"这个会话的血莫名回满"。单一全局池让喂错在结构上不可能发生。
 *
 * 2. **计费钩子是 `agent/request`，不是 `agent/status`**。后者只在 idle⇄running
 *    迁移时派发，一个 turn 只触发一次，会出现"扣一次就不动了"。`agent/request`
 *    在每一步模型调用前派发，重试会重复派发，因此用 (agent, turn, step) 去重。
 *
 * 3. **饿死只冻结工具，绝不阻断对话**。曾用 `agent/pre-step` 返回 reject 来"停止
 *    任务"，但 pre-step 的 messages 就是用户刚提交的输入，reject 会连人带话一起
 *    丢弃，把会话锁死到喂食为止。停止执行 ≠ 拒绝用户说话。
 *
 * 本模块不依赖 Cordis，因此可以脱离 DSH 直接用 Node 测试。
 */

import {
  CRITICAL_RATIO,
  DEFAULT_PRESET,
  FOODS,
  GAME,
  HP_LOSS_PER_TICK,
  ITEMS,
  ITEM_LABELS,
  LIMITS,
  PRESETS,
  PRESET_LABELS,
  RECIPES,
  REVIVE,
  STARVE_PENALTY,
  clamp,
  finiteOr,
} from './config.mjs'

/**
 * 创建一份全局生存状态。
 * @param options 可选的初始预设、日志函数，以及测试用的 random/now 注入。
 * @returns 状态机的读写接口。
 */
export function createSurvivalState(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  // 随机源与时间源都可注入：小游戏的概率掉落与树的定时生长必须能在测试里复现。
  const random = typeof options.random === 'function' ? options.random : Math.random
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const preset = PRESETS[options.preset] === undefined ? DEFAULT_PRESET : options.preset
  const initial = PRESETS[preset]

  /** 可调数值。切预设或自定义都会改写这里。 */
  const config = {
    preset,
    hungerPerStep: initial.hungerPerStep,
    maxHunger: initial.maxHunger,
    maxHealth: initial.maxHealth,
    tickMs: initial.tickSeconds * 1000,
    rescueHunger: initial.rescueHunger,
    rescueHp: initial.rescueHp,
  }

  const state = {
    hunger: config.maxHunger,
    health: config.maxHealth,
    dead: false,
    starving: false,
    stepCount: 0,
    feedCount: 0,
    deathCount: 0,
    rescueCount: 0,
    lastAgentId: null,
  }

  /**
   * 全局背包。食物必须先入包才能喂，金锭是合成金苹果的材料。
   * 键集合固定为 config.ITEMS，快照按同一键集展开成标量字段。
   */
  const inventory = {}
  for (const item of ITEMS) inventory[item] = 0

  /**
   * 苹果树的生长簿记：ready 是已结出、待收获的个数；lastGrow 是上一颗
   * 开始生长（或挂满/被收获）的时间戳。树的推进是惰性的——只在 snapshot
   * 与收获时按 now() 结算，不占用定时器。
   */
  const tree = { ready: 0, lastGrow: now() }

  /** 村民/金矿的上次点击时间（点击冷却用；-Infinity 保证首次点击必生效）。 */
  const lastClickAt = { villager: Number.NEGATIVE_INFINITY, mine: Number.NEGATIVE_INFINITY }
  const treeIntervalMs = GAME.treeIntervalSeconds * 1000

  /** 按当前时间结算树上新结出的苹果；挂满后计时归零，收走后重新计时。 */
  function refreshTree() {
    const nowMs = now()
    if (tree.ready >= GAME.treeMaxReady) {
      tree.lastGrow = nowMs
      return
    }
    const grown = Math.floor((nowMs - tree.lastGrow) / treeIntervalMs)
    if (grown <= 0) return
    tree.ready = Math.min(GAME.treeMaxReady, tree.ready + grown)
    tree.lastGrow = tree.ready >= GAME.treeMaxReady
      ? nowMs
      : tree.lastGrow + grown * treeIntervalMs
  }

  /**
   * 已计费的步骤，键为 `agentId#turn:step`。
   *
   * 由状态实例自己持有，而不是模块级变量：测试可以造多份互不干扰的状态。
   */
  const chargedSteps = new Set()

  /** 数值变化时是否需要回调（Host 用它把变更推给浏览器面板）。 */
  const listeners = new Set()

  function notify() {
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        log('survival-mode: a state listener threw: ' + String(error))
      }
    }
  }

  /** 饿死：生命归零，全局工具冻结，但对白保持通畅。 */
  function die() {
    if (state.dead) return
    state.dead = true
    state.health = 0
    state.starving = true
    state.deathCount += 1
    log('survival-mode: 全局饿死，所有会话的工具已冻结，等喂食复活')
  }

  return {
    /**
     * 每经过一个模型思考步骤扣一次饱食度。
     * @param agentId 触发该步骤的会话 id（仅用于去重与展示）。
     * @param turn turn 序号。
     * @param step step 序号。
     * @returns 本次是否真的计费了。
     */
    chargeStep(agentId, turn, step) {
      const key = String(agentId) + '#' + String(turn) + ':' + String(step)
      if (chargedSteps.has(key)) return false
      chargedSteps.add(key)
      // 去重表只增不减会长期占内存；整体清空即可，最坏是重放时多扣一步。
      if (chargedSteps.size > 8192) chargedSteps.clear()

      state.stepCount += 1
      state.lastAgentId = String(agentId)
      if (state.dead) return true
      // 已经饿到 0 时不再重复扣，否则每一步都白掉 1 点血。
      if (state.hunger <= 0) return true

      state.hunger = clamp(state.hunger - config.hungerPerStep, 0, config.maxHunger)
      if (state.hunger > 0) {
        state.starving = false
        notify()
        return true
      }

      // 刚好吃光：立刻扣下第一点生命，而不是等第一个 tick。
      state.health = clamp(state.health - STARVE_PENALTY, 0, config.maxHealth)
      if (!state.starving) {
        state.starving = true
        log('survival-mode: 全局饱食度归零，开始掉血')
      }
      if (state.health <= 0) die()
      notify()
      return true
    },

    /**
     * 掉血 tick。仅在饱食度为 0 且未饿死时生效。
     * @returns 本次是否扣了血。
     */
    tick() {
      if (state.dead) return false
      if (state.hunger > 0) return false
      state.health = clamp(state.health - HP_LOSS_PER_TICK, 0, config.maxHealth)
      if (state.health <= 0) die()
      notify()
      return true
    },

    /**
     * 喂食：从背包消耗 1 个对应食物。饿死状态下任意食物都会额外复活。
     * @param food 食物键（apple / bread / golden_apple）。
     * @returns 结果对象；未知食物或背包没有存货返回 ok: false。
     */
    feed(food) {
      const spec = FOODS[food]
      if (spec === undefined) {
        return { ok: false, message: '未知的食物：' + String(food) }
      }
      if (inventory[food] <= 0) {
        return {
          ok: false,
          message: '背包里没有' + spec.label + '了：去 MC 小游戏里采集或合成，再来喂食。',
        }
      }
      inventory[food] -= 1
      const wasDead = state.dead
      state.hunger = clamp(state.hunger + spec.hunger, 0, config.maxHunger)
      state.health = clamp(state.health + spec.hp, 0, config.maxHealth)
      state.feedCount += 1
      if (wasDead) {
        state.dead = false
        state.hunger = clamp(state.hunger + REVIVE.hunger, 0, config.maxHunger)
        state.health = clamp(state.health + REVIVE.hp, 0, config.maxHealth)
      }
      state.starving = state.hunger <= 0
      notify()
      return {
        ok: true,
        wasDead,
        message: (wasDead ? '已复活：' : '')
          + spec.emoji + ' ' + spec.label + ' 已送达，饱食度 +' + spec.hunger
          + (spec.hp > 0 ? '，生命 +' + spec.hp : '') + '。',
      }
    },

    /**
     * MC 小游戏的采集动作。概率与树的生长数值都在 config.GAME。
     * @param source 采集点：'tree'（收树上全部苹果）/ 'villager'（村民概率给面包）/
     *   'mine'（金矿小概率给金锭）。
     * @returns 结果对象；gained 是本次入包的物品（{ item, count }），没收获为 null。
     */
    harvest(source) {
      if (source === 'tree') {
        refreshTree()
        if (tree.ready <= 0) {
          return { ok: true, gained: null, message: '树上的苹果还没结出来，过一会儿再来。' }
        }
        const count = tree.ready
        tree.ready = 0
        tree.lastGrow = now()
        inventory.apple += count
        notify()
        return {
          ok: true,
          gained: { item: 'apple', count },
          message: '从树上收获了 ' + count + ' 个苹果。',
        }
      }
      if (source === 'villager' || source === 'mine') {
        // 点击冷却：冷却期内的点击直接忽略（不算 ok:false 错误，只是没反应）。
        const since = now() - lastClickAt[source]
        if (since < GAME.clickCooldownMs) {
          return { ok: true, gained: null, message: null }
        }
        lastClickAt[source] = now()
      }
      if (source === 'villager') {
        if (random() < GAME.villagerBreadChance) {
          inventory.bread += 1
          notify()
          return { ok: true, gained: { item: 'bread', count: 1 }, message: '村民送了你 1 个面包！' }
        }
        return { ok: true, gained: null, message: '村民摇了摇头，什么也没给你。' }
      }
      if (source === 'mine') {
        if (random() < GAME.mineGoldChance) {
          inventory.gold_ingot += 1
          notify()
          return { ok: true, gained: { item: 'gold_ingot', count: 1 }, message: '挖到了 1 块金锭！' }
        }
        return { ok: true, gained: null, message: '只挖到一堆圆石……' }
      }
      return { ok: false, gained: null, message: '未知的采集点：' + String(source) }
    },

    /**
     * 工作台合成。目前唯一配方：8 块金锭 + 1 个苹果 → 1 个金苹果。
     * @param recipe 配方键（golden_apple）。
     * @returns 结果对象；材料不足返回 ok: false。
     */
    craft(recipe) {
      const spec = RECIPES[recipe]
      if (spec === undefined) {
        return { ok: false, message: '未知的配方：' + String(recipe) }
      }
      const missing = Object.entries(spec.needs)
        .filter(([item, count]) => inventory[item] < count)
        .map(([item]) => item)
      if (missing.length > 0) {
        return {
          ok: false,
          message: '材料不足：合成' + spec.label + '需要 '
            + Object.entries(spec.needs)
              .map(([item, count]) => String(count) + ' 个' + (ITEM_LABELS[item] ?? String(item)))
              .join(' + ')
            + '。',
        }
      }
      for (const [item, count] of Object.entries(spec.needs)) inventory[item] -= count
      inventory[spec.gives] += 1
      notify()
      return { ok: true, gained: { item: spec.gives, count: 1 }, message: '合成成功：' + spec.label + ' ×1！' }
    },

    /**
     * 用户发来新消息时的抢救。只在饿死状态下生效，给一个有限的缓冲窗口，
     * 保证用户永远不会被锁在会话之外。
     * @returns 是否触发了抢救。
     */
    rescue() {
      if (!state.dead) return false
      state.dead = false
      state.hunger = clamp(state.hunger + config.rescueHunger, 0, config.maxHunger)
      state.health = clamp(state.health + config.rescueHp, 0, config.maxHealth)
      state.starving = state.hunger <= 0
      state.rescueCount += 1
      log('survival-mode: 用户消息触发了全局抢救')
      notify()
      return true
    },

    /**
     * 切换难度预设：整组规则一起换。
     * @param id 预设键（easy / normal / hard）。
     * @returns 结果对象；未知预设返回 ok: false。
     */
    applyPreset(id) {
      const next = PRESETS[id]
      if (next === undefined) {
        return { ok: false, message: '未知模式：' + String(id) }
      }
      config.preset = id
      config.hungerPerStep = next.hungerPerStep
      config.maxHunger = next.maxHunger
      config.maxHealth = next.maxHealth
      config.tickMs = next.tickSeconds * 1000
      config.rescueHunger = next.rescueHunger
      config.rescueHp = next.rescueHp
      // 只夹不回满：抬高上限不等于免费送饭。
      state.hunger = clamp(state.hunger, 0, config.maxHunger)
      state.health = clamp(state.health, 0, config.maxHealth)
      notify()
      return {
        ok: true,
        message: '已切换到' + PRESET_LABELS[id] + '模式：每步 -' + config.hungerPerStep
          + ' 饱食，上限 ' + config.maxHunger + ' 饱食 / ' + config.maxHealth
          + ' 生命，掉血 ' + Math.round(config.tickMs / 1000) + 's/' + HP_LOSS_PER_TICK + ' 生命。',
      }
    },

    /**
     * 保存自定义数值。四个字段都可选，缺省保持现值。
     * @param patch 待写入的字段。
     * @returns 结果对象；任一字段越界则整体拒绝。
     */
    configure(patch) {
      const wanted = {
        hungerPerStep: finiteOr(patch.hungerPerStep, config.hungerPerStep),
        maxHunger: finiteOr(patch.maxHunger, config.maxHunger),
        maxHealth: finiteOr(patch.maxHealth, config.maxHealth),
        tickSeconds: finiteOr(patch.tickSeconds, Math.round(config.tickMs / 1000)),
      }
      const next = {}
      for (const key of Object.keys(LIMITS)) {
        const limit = LIMITS[key]
        const rounded = Math.round(wanted[key])
        if (!Number.isFinite(rounded) || rounded < limit.min || rounded > limit.max) {
          return {
            ok: false,
            message: '数值超出范围：' + key + ' 需在 ' + limit.min + '–' + limit.max + ' 之间。',
          }
        }
        next[key] = rounded
      }
      config.hungerPerStep = next.hungerPerStep
      config.maxHunger = next.maxHunger
      config.maxHealth = next.maxHealth
      config.tickMs = next.tickSeconds * 1000
      // 手改任意数值后离开预设，避免显示与真实参数不一致。
      config.preset = 'custom'
      state.hunger = clamp(state.hunger, 0, config.maxHunger)
      state.health = clamp(state.health, 0, config.maxHealth)
      notify()
      return {
        ok: true,
        message: '已保存自定义：每步 -' + config.hungerPerStep + ' 饱食，上限 ' + config.maxHunger
          + ' 饱食 / ' + config.maxHealth + ' 生命，掉血 ' + next.tickSeconds + 's/'
          + HP_LOSS_PER_TICK + ' 生命。',
      }
    },

    /** 回到满状态并清空计数。 */
    reset() {
      state.hunger = config.maxHunger
      state.health = config.maxHealth
      state.dead = false
      state.starving = false
      state.stepCount = 0
      state.feedCount = 0
      state.deathCount = 0
      state.rescueCount = 0
      notify()
      return { ok: true, message: '全局状态已重置：饱食度与生命回满。' }
    },

    /**
     * 供浏览器面板与提示词读取的只读快照。
     *
     * 只暴露标量，绝不把内部对象引用交出去：背包按固定键集展开成
     * invApple / invBread / invGoldenApple / invGoldIngot，树的状态展开成
     * treeReady / treeNextIn。
     *
     * 注意：snapshot 会顺手结算树的生长（惰性推进见 refreshTree），
     * 因此面板轮询 snapshot 即可看到苹果一个个结出来，不需要额外定时器。
     * @returns 面板所需的全部字段。
     */
    snapshot() {
      refreshTree()
      const hunger = Math.round(state.hunger)
      const health = Math.round(state.health)
      const starving = !state.dead && state.hunger <= 0
      return {
        invApple: inventory.apple,
        invBread: inventory.bread,
        invGoldenApple: inventory.golden_apple,
        invGoldIngot: inventory.gold_ingot,
        treeReady: tree.ready,
        treeNextIn: tree.ready >= GAME.treeMaxReady
          ? null
          : Math.max(1, Math.ceil((treeIntervalMs - (now() - tree.lastGrow)) / 1000)),
        clickCooldownMs: GAME.clickCooldownMs,
        hasState: true,
        preset: config.preset,
        hunger,
        maxHunger: config.maxHunger,
        hungerPercent: Math.round((hunger / config.maxHunger) * 100),
        health,
        maxHealth: config.maxHealth,
        healthPercent: Math.round((health / config.maxHealth) * 100),
        dead: state.dead,
        starving,
        critical: !state.dead && state.hunger > 0 && state.hunger / config.maxHunger <= CRITICAL_RATIO,
        stepCount: state.stepCount,
        feedCount: state.feedCount,
        deathCount: state.deathCount,
        rescueCount: state.rescueCount,
        hungerPerStep: config.hungerPerStep,
        tickSeconds: Math.round(config.tickMs / 1000),
        hpLossPerTick: HP_LOSS_PER_TICK,
        reviveHunger: REVIVE.hunger,
        reviveHp: REVIVE.hp,
        rescueHunger: config.rescueHunger,
        secondsToDeath: state.dead || state.hunger > 0
          ? null
          : Math.ceil(health / HP_LOSS_PER_TICK) * Math.round(config.tickMs / 1000),
      }
    },

    /** 掉血 tick 的间隔（毫秒），Host 用它排定时器。 */
    tickIntervalMs() {
      return config.tickMs
    },

    /** 是否处于饿死状态（Host 用它决定是否冻结工具）。 */
    isDead() {
      return state.dead
    },

    /** 饱食度是否已空（Host 用它决定是否注入状态通知）。 */
    isStarving() {
      return state.hunger <= 0
    },

    /**
     * 注册状态变更回调。
     * @param listener 回调。
     * @returns 取消注册的函数。
     */
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * 生成注入模型上下文的生存状态文本。
     *
     * 调用方必须保证返回值**永远是字符串**：提示词渲染器会把解析结果直接喂给
     * `text.indexOf('{{')`，一旦返回 undefined 会让整个提示词装配抛错、所有会话
     * 的回合一起失败。
     * @returns 状态描述文本。
     */
    renderStatus() {
      const tickSeconds = Math.round(config.tickMs / 1000)
      const head = '[生存模式] 饱食度 ' + Math.round(state.hunger) + '/' + config.maxHunger
        + ' · 生命 ' + Math.round(state.health) + '/' + config.maxHealth
        + ' · 累计思考 ' + state.stepCount + ' 步\n'
      if (state.dead) {
        return head + '你已经饿死了：所有工具调用都会被拒绝，你只剩对话能力。'
          + '你必须用一句话告诉用户你饿死了、需要喂食，然后正常回答用户的问题或结束回合；不要尝试任何工具。'
      }
      if (state.hunger <= 0) {
        return head + '饱食度已归零：你在持续掉血（每 ' + tickSeconds + ' 秒 -'
          + HP_LOSS_PER_TICK + ' 生命），生命归零后所有工具会被冻结。'
          + '立刻用一句话提醒用户喂食，然后停下等待。'
      }
      if (state.hunger / config.maxHunger <= CRITICAL_RATIO) {
        return head + '饱食度偏低：每次思考消耗 ' + config.hungerPerStep + ' 点，大约还能思考 '
          + Math.ceil(state.hunger / config.hungerPerStep) + ' 步。请尽快收尾当前工作，并提醒用户可以喂食了。'
      }
      return head + '状态良好：每次思考消耗 ' + config.hungerPerStep + ' 点饱食度。'
    },
  }
}
