/**
 * 难度预设与可调数值的边界。
 *
 * 每个预设是一整组规则（每步扣除、两个上限、掉血节奏、抢救量），不是单个数字——
 * 否则"简单/困难"的差异只会体现在一处，手感是割裂的。
 */

/** 用户可自定义数值的合法区间；越界一律拒绝，避免把状态设成非法值。 */
export const LIMITS = {
  hungerPerStep: { min: 1, max: 100 },
  maxHunger: { min: 10, max: 1000 },
  maxHealth: { min: 1, max: 999 },
  tickSeconds: { min: 1, max: 600 },
}

/**
 * 三档预设。
 *
 * 饱食上限是按"实际能干多少活"定的，不是拍脑袋：一次自主目标回合可能连续思考
 * 30 步以上（本插件在开发过程中实测烧掉 32 步），因此简单模式必须明显高于这个量级，
 * 否则"简单"在长任务里名不副实——第一版给的 120（30 步）就正好卡在这个坑上。
 *
 * @type {Record<'easy'|'normal'|'hard', {
 *   hungerPerStep: number, maxHunger: number, maxHealth: number,
 *   tickSeconds: number, rescueHunger: number, rescueHp: number,
 * }>}
 */
export const PRESETS = {
  easy: {
    hungerPerStep: 4,
    maxHunger: 200,
    maxHealth: 16,
    tickSeconds: 6,
    rescueHunger: 45,
    rescueHp: 4,
  },
  normal: {
    hungerPerStep: 6,
    maxHunger: 150,
    maxHealth: 12,
    tickSeconds: 4,
    rescueHunger: 30,
    rescueHp: 3,
  },
  hard: {
    hungerPerStep: 10,
    maxHunger: 80,
    maxHealth: 8,
    tickSeconds: 2,
    rescueHunger: 18,
    rescueHp: 2,
  },
}

/** 预设的中文显示名。 */
export const PRESET_LABELS = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
}

/**
 * 食物。
 *
 * `hp` 是进食同时恢复的生命；金苹果是唯一在饿死状态下用于复活的选项。
 * 三种食物都只能先进入背包（玩 MC 小游戏获得），喂食时从背包消耗 1 个。
 * @type {Record<'apple'|'bread'|'golden_apple', { label: string, emoji: string, hunger: number, hp: number }>}
 */
export const FOODS = {
  apple: { label: '苹果', emoji: '🍎', hunger: 25, hp: 0 },
  bread: { label: '面包', emoji: '🍞', hunger: 45, hp: 0 },
  golden_apple: { label: '金苹果', emoji: '✨', hunger: 100, hp: 4 },
}

/**
 * MC 小游戏的数值。
 *
 * - 树每隔 treeIntervalSeconds 秒结 1 个苹果，树上最多同时挂 treeMaxReady 个，
 *   挂满后停止计时，点击树一次性收走全部。
 * - 点村民每次有 villagerBreadChance 概率给 1 个面包。
 * - 点金矿每次有 mineGoldChance 概率（小概率）给 1 块金锭。
 * - 村民和金矿有点击冷却 clickCooldownMs，冷却内的点击直接忽略（树不受限）。
 */
export const GAME = {
  treeIntervalSeconds: 20,
  treeMaxReady: 3,
  villagerBreadChance: 0.6,
  mineGoldChance: 0.2,
  clickCooldownMs: 500,
}

/**
 * 合成配方。目前只有金苹果：8 块金锭 + 1 个苹果。
 * @type {Record<'golden_apple', { label: string, needs: Record<string, number>, gives: string }>}
 */
export const RECIPES = {
  golden_apple: {
    label: '金苹果',
    needs: { gold_ingot: 8, apple: 1 },
    gives: 'golden_apple',
  },
}

/** 背包里会出现的全部物品（含合成材料金锭）；键也是快照里库存字段的来源。 */
export const ITEMS = ['apple', 'bread', 'golden_apple', 'gold_ingot']

/** 物品的中文显示名（金锭不是食物，FOODS 里没有它）。 */
export const ITEM_LABELS = {
  apple: '苹果',
  bread: '面包',
  golden_apple: '金苹果',
  gold_ingot: '金锭',
}

/** 饿死状态下被喂食时的额外复活量（在食物本身效果之上叠加）。 */
export const REVIVE = { hunger: 60, hp: 3 }

/** 首次初始化使用哪一档。 */
export const DEFAULT_PRESET = 'normal'

/** 低于此比例（相对饱食上限）视为"偏低"，提示模型收尾并催饭。 */
export const CRITICAL_RATIO = 0.25

/** 每步思考的固定惩罚：饱食度归零的那一刻额外扣 1 点生命。 */
export const STARVE_PENALTY = 1

/** 饿死状态下每次掉血 tick 扣多少生命。 */
export const HP_LOSS_PER_TICK = 1

/**
 * 把数字夹到区间内。
 * @param value 待夹取的值。
 * @param min 下界。
 * @param max 上界。
 * @returns 夹取后的值。
 */
export function clamp(value, min, max) {
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * 只接受有限数字，否则回退。
 * @param value 候选值。
 * @param fallback 非法时的回退值。
 * @returns 可用的有限数字。
 */
export function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
