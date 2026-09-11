/**
 * 核心状态机的行为测试。
 *
 * 用 Node 内置的 assert 与 test runner，不引入任何依赖——因为这个仓库要能
 * 被任何人在没有私有 registry 配额的情况下直接 clone 下来跑。
 *
 * 这些用例对应的是真实踩过的坑，删掉任何一条都会让那类问题重新出现：
 * - 多会话串状态（喂错对象）
 * - 计费只在状态迁移时触发（扣一次就不动）
 * - 重复扣同一 step
 * - 饱食度为 0 时每步白掉 1 点血
 * - 抬升上限等于免费送饭
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSurvivalState } from '../src/state.mjs'
import { GAME, PRESETS } from '../src/config.mjs'

// 断言值一律从 PRESETS 推导，不抄数字：抄写会在调平衡时悄悄失真，
// 让"测试通过"与"行为正确"脱钩。
const NORMAL = PRESETS.normal

test('每步思考按预设扣除饱食度', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  assert.equal(survival.snapshot().hunger, NORMAL.maxHunger)
  survival.chargeStep('s1', 1, 1)
  assert.equal(survival.snapshot().hunger, NORMAL.maxHunger - NORMAL.hungerPerStep)
  survival.chargeStep('s1', 1, 2)
  assert.equal(survival.snapshot().hunger, NORMAL.maxHunger - 2 * NORMAL.hungerPerStep)
  assert.equal(survival.snapshot().stepCount, 2)
})

test('同一个 step 只计费一次（重试不重复扣）', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  survival.chargeStep('s1', 1, 1)
  survival.chargeStep('s1', 1, 1)
  survival.chargeStep('s1', 1, 1)
  const snapshot = survival.snapshot()
  assert.equal(snapshot.hunger, NORMAL.maxHunger - NORMAL.hungerPerStep)
  assert.equal(snapshot.stepCount, 1)
})

test('不同会话共享同一个池：这是全局模式的核心', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  survival.chargeStep('sessionA', 1, 1)
  survival.chargeStep('sessionB', 1, 1)
  // 两个会话各扣一次，池子一共 -2 步，而不是各自独立
  assert.equal(survival.snapshot().hunger, NORMAL.maxHunger - 2 * NORMAL.hungerPerStep)
  assert.equal(survival.snapshot().stepCount, 2)
})

test('饿死后不再扣饱食度，也不会每步白掉血', () => {
  const survival = createSurvivalState({ preset: 'hard' })
  // 困难模式：80 饱食、每步 10 → 8 步耗尽
  for (let step = 1; step <= 8; step += 1) survival.chargeStep('s1', 1, step)
  const starving = survival.snapshot()
  assert.equal(starving.hunger, 0, '第 8 步应刚好耗尽')
  assert.equal(starving.starving, true)
  // 归零那一刻额外扣 1 点生命
  assert.equal(starving.health, 7)

  const hungerBefore = starving.hunger
  const healthBefore = starving.health
  for (let step = 9; step <= 12; step += 1) survival.chargeStep('s1', 1, step)
  const after = survival.snapshot()
  assert.equal(after.hunger, hungerBefore, '归零后不应继续扣饱食度')
  assert.equal(after.health, healthBefore, '归零后计费不应额外扣血（掉血只由 tick 负责）')
  assert.equal(after.stepCount, 12, '步数仍然累计')
})

test('掉血 tick 只在饱食度为 0 时生效，并最终导致饿死', () => {
  const survival = createSurvivalState({ preset: 'hard' })
  // 未归零时 tick 无效
  assert.equal(survival.tick(), false, '饱食度充足时不应掉血')

  for (let step = 1; step <= 8; step += 1) survival.chargeStep('s1', 1, step)
  assert.equal(survival.snapshot().health, 7)

  // 7 点生命，每次 tick -1
  for (let i = 0; i < 6; i += 1) survival.tick()
  assert.equal(survival.snapshot().health, 1)
  assert.equal(survival.snapshot().dead, false)

  survival.tick()
  const dead = survival.snapshot()
  assert.equal(dead.dead, true, '最后一次 tick 应导致饿死')
  assert.equal(dead.health, 0)
  assert.equal(dead.deathCount, 1)

  // 死后 tick 不再继续扣（生命已是 0）
  assert.equal(survival.tick(), false)
  assert.equal(survival.snapshot().deathCount, 1)
})

test('喂食恢复饱食度，并在饿死状态下额外复活', () => {
  // random 恒 0 → 点村民必给面包，用它把面包喂进背包。
  const survival = createSurvivalState({ preset: 'hard', random: () => 0 })
  for (let step = 1; step <= 8; step += 1) survival.chargeStep('s1', 1, step)
  for (let i = 0; i < 7; i += 1) survival.tick()
  assert.equal(survival.snapshot().dead, true)

  assert.equal(survival.harvest('villager').gained.item, 'bread', '前置：先要到 1 个面包')
  const result = survival.feed('bread')
  assert.equal(result.ok, true)
  assert.equal(result.wasDead, true)
  const revived = survival.snapshot()
  assert.equal(revived.dead, false, '喂食应解除饿死')
  // 面包 +45，复活额外 +60 → 105（上限 80，被夹住）
  assert.equal(revived.hunger, PRESETS.hard.maxHunger)
  assert.equal(revived.health, 3, '复活额外 +3 生命')
  assert.equal(revived.invBread, 0, '喂食应从背包消耗掉这 1 个面包')
})

test('背包为空时喂食被拒绝，状态不被改动', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  const before = survival.snapshot()
  const result = survival.feed('apple')
  assert.equal(result.ok, false)
  const after = survival.snapshot()
  assert.equal(after.hunger, before.hunger, '没货不能白吃')
  assert.equal(after.feedCount, before.feedCount)
  assert.equal(after.invApple, 0)
})

test('树定时结苹果：挂满封顶，点击收获全部', () => {
  let nowMs = 0
  const survival = createSurvivalState({ preset: 'normal', now: () => nowMs })
  assert.equal(survival.harvest('tree').gained, null, '刚开始树上没有苹果')

  nowMs += GAME.treeIntervalSeconds * 1000
  assert.equal(survival.snapshot().treeReady, 1, '到点应结出 1 个')

  nowMs += GAME.treeIntervalSeconds * 1000 * 10
  assert.equal(survival.snapshot().treeReady, GAME.treeMaxReady, '挂满后不再继续结')

  const collected = survival.harvest('tree')
  assert.equal(collected.gained.item, 'apple')
  assert.equal(collected.gained.count, GAME.treeMaxReady)
  assert.equal(survival.snapshot().invApple, GAME.treeMaxReady)
  assert.equal(survival.snapshot().treeReady, 0, '收走后树重新开始计时')
})

test('村民概率给面包，金矿小概率给金锭', () => {
  const lucky = createSurvivalState({ preset: 'normal', random: () => 0 })
  assert.equal(lucky.harvest('villager').gained.item, 'bread')
  assert.equal(lucky.harvest('mine').gained.item, 'gold_ingot')
  assert.equal(lucky.snapshot().invBread, 1)
  assert.equal(lucky.snapshot().invGoldIngot, 1)

  const unlucky = createSurvivalState({ preset: 'normal', random: () => 0.999 })
  assert.equal(unlucky.harvest('villager').gained, null)
  assert.equal(unlucky.harvest('mine').gained, null)
  assert.equal(unlucky.snapshot().invBread, 0)
  assert.equal(unlucky.snapshot().invGoldIngot, 0)

  assert.equal(unlucky.harvest('nope').ok, false, '未知采集点应被拒绝')
})

test('村民和金矿有点击冷却：冷却内静默忽略，冷却结束后恢复', () => {
  let nowMs = 0
  const survival = createSurvivalState({ preset: 'normal', random: () => 0, now: () => nowMs })

  const first = survival.harvest('villager')
  assert.equal(first.gained.item, 'bread', '首次点击正常结算')

  const spam = survival.harvest('villager')
  assert.equal(spam.gained, null, '冷却内的点击不给东西')
  assert.equal(spam.message, null, '冷却内的点击静默处理')
  assert.equal(survival.snapshot().invBread, 1, '冷却内的点击不入账')

  assert.equal(survival.harvest('mine').gained.item, 'gold_ingot', '金矿与村民冷却互相独立')

  nowMs += GAME.clickCooldownMs
  assert.equal(survival.harvest('villager').gained.item, 'bread', '冷却结束后恢复')

  assert.equal(survival.harvest('tree').gained, null, '树不受点击冷却限制（只是还没结果）')
})

test('工作台合成：8 金锭 + 1 苹果 → 1 金苹果，材料不足被拒绝', () => {
  let nowMs = 0
  const survival = createSurvivalState({ preset: 'normal', random: () => 0, now: () => nowMs })
  assert.equal(survival.craft('golden_apple').ok, false, '空背包不能合成')

  // 攒材料：挖 8 次金矿（random 恒 0 必中；每次推进时间以避开点击冷却），树结 1 个苹果。
  for (let i = 0; i < 8; i += 1) {
    survival.harvest('mine')
    nowMs += GAME.clickCooldownMs
  }
  nowMs += GAME.treeIntervalSeconds * 1000
  survival.harvest('tree')

  const result = survival.craft('golden_apple')
  assert.equal(result.ok, true)
  const after = survival.snapshot()
  assert.equal(after.invGoldenApple, 1)
  assert.equal(after.invGoldIngot, 0, '8 块金锭应全部被消耗')
  assert.equal(after.invApple, 0, '1 个苹果应被消耗')

  assert.equal(survival.craft('golden_apple').ok, false, '材料用完后不能再合成')
  assert.equal(survival.craft('nope').ok, false, '未知配方应被拒绝')
})

test('用户消息抢救能解除饿死，保证不会被锁在会话外', () => {
  const survival = createSurvivalState({ preset: 'hard' })
  for (let step = 1; step <= 8; step += 1) survival.chargeStep('s1', 1, step)
  for (let i = 0; i < 7; i += 1) survival.tick()
  assert.equal(survival.snapshot().dead, true)

  assert.equal(survival.rescue(), true)
  const rescued = survival.snapshot()
  assert.equal(rescued.dead, false)
  assert.equal(rescued.hunger, PRESETS.hard.rescueHunger)
  assert.equal(rescued.health, PRESETS.hard.rescueHp)
  assert.equal(rescued.rescueCount, 1)
  // 已复活后再抢救不再叠加
  assert.equal(survival.rescue(), false)
})

test('切换预设会整组换规则，且只夹不回满', () => {
  const survival = createSurvivalState({ preset: 'easy' })
  const easy = PRESETS.easy
  const hard = PRESETS.hard
  // 简单模式：用掉 10 步的量
  for (let step = 1; step <= 10; step += 1) survival.chargeStep('s1', 1, step)
  assert.equal(survival.snapshot().hunger, easy.maxHunger - 10 * easy.hungerPerStep)
  assert.equal(survival.snapshot().health, easy.maxHealth)

  const result = survival.applyPreset('hard')
  assert.equal(result.ok, true)
  const after = survival.snapshot()
  assert.equal(after.preset, 'hard')
  assert.equal(after.maxHunger, hard.maxHunger)
  assert.equal(after.maxHealth, hard.maxHealth)
  assert.equal(after.hungerPerStep, hard.hungerPerStep)
  assert.equal(after.hunger, hard.maxHunger, '当前饱食度被夹到困难上限，但不被抬升')
  assert.equal(after.health, hard.maxHealth, '生命被夹到新上限')

  assert.equal(survival.applyPreset('nope').ok, false, '未知预设应被拒绝')
})

test('抬升上限不会免费送饭', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  for (let step = 1; step <= 5; step += 1) survival.chargeStep('s1', 1, step)
  const before = survival.snapshot().hunger
  assert.equal(before, NORMAL.maxHunger - 5 * NORMAL.hungerPerStep)
  const result = survival.configure({ maxHunger: NORMAL.maxHunger + 400 })
  assert.equal(result.ok, true)
  const after = survival.snapshot()
  assert.equal(after.maxHunger, NORMAL.maxHunger + 400)
  assert.equal(after.hunger, before, '抬高上限不应回填饱食度')
})

test('自定义数值越界时整体拒绝且不写入', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  assert.equal(survival.configure({ hungerPerStep: 0 }).ok, false)
  assert.equal(survival.configure({ maxHealth: 1000 }).ok, false)
  assert.equal(survival.configure({ tickSeconds: 0 }).ok, false)
  // 被拒绝后仍是原值
  assert.equal(survival.snapshot().hungerPerStep, NORMAL.hungerPerStep)
  assert.equal(survival.snapshot().maxHealth, NORMAL.maxHealth)
})

test('手改数值后离开预设档位', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  survival.configure({ hungerPerStep: 8 })
  assert.equal(survival.snapshot().preset, 'custom')
})

test('renderStatus 永远返回字符串（undefined 会让整个提示词管线崩掉）', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  const cases = [survival.renderStatus()]
  survival.chargeStep('s1', 1, 1)
  cases.push(survival.renderStatus())
  // 走到归零：步数由上限推导，避免抄数字
  const stepsToEmpty = Math.ceil(NORMAL.maxHunger / NORMAL.hungerPerStep) + 1
  for (let step = 2; step <= stepsToEmpty; step += 1) survival.chargeStep('s1', 1, step)
  assert.equal(survival.snapshot().hunger, 0, '前置条件：应已归零')
  cases.push(survival.renderStatus())
  while (!survival.snapshot().dead) survival.tick()
  cases.push(survival.renderStatus())

  for (const text of cases) {
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0)
    assert.ok(!text.includes('undefined'), '文本里不应出现 undefined')
  }
})

test('快照只含标量，不泄漏内部对象引用', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  const snapshot = survival.snapshot()
  for (const [key, value] of Object.entries(snapshot)) {
    assert.ok(
      value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
      key + ' 应为标量，实际是 ' + typeof value,
    )
  }
})

test('状态变更回调可注册与注销', () => {
  const survival = createSurvivalState({ preset: 'normal' })
  let calls = 0
  const off = survival.onChange(() => { calls += 1 })
  survival.chargeStep('s1', 1, 1)
  assert.equal(calls, 1)
  off()
  survival.chargeStep('s1', 1, 2)
  assert.equal(calls, 1, '注销后不应再收到通知')
})
