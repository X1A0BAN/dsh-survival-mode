/**
 * 模型可调用的 survival_feed 工具定义。
 *
 * 刻意做成"接受 defineTool 的纯函数"而不是在这里 import 官方包：
 * 官方包由 profile 的 pnpm 闭包在挂载时注入、不进本仓库依赖，因此模块内部 import
 * 会让这个文件在干净 checkout 里无法加载，也就无法在测试里用真实的 defineTool 编译它。
 *
 * 两条 schema 约束是实测踩出来的，改动时务必保持：
 * 1. `parameters` 的根是**隐式开放对象**，不能声明 additionalProperties；
 *    必填只在每个属性上写 `required: true`。
 * 2. `output.schema` 是**值根**，同样不允许根级 required，必填也要逐属性声明；
 *    但它的 object 根必须显式给出 additionalProperties。
 */

/** 工具名。Host 的冻结逻辑会按这个名字放行（其余工具一律拒绝）。 */
export const FEED_TOOL_NAME = 'survival_feed'

/**
 * 构造工具定义。
 * @param defineTool 真实的 @deepseek-ai/dsh-tools defineTool。
 * @param deps 运行时依赖：状态机与食物表。
 * @returns 可直接交给 ctx.tools.register 的定义。
 */
export function createFeedTool(defineTool, deps) {
  const { survival, foods } = deps
  const foodKeys = foods.map((food) => food.key)

  return defineTool({
    name: FEED_TOOL_NAME,
    description: '生存模式（全局共享）：进食恢复饱食度，影响整个 DSH 的所有会话。'
      + '可选：' + foods.map((food) => food.key + '=' + food.label + '(+' + food.hunger + ' 饱食'
        + (food.hp > 0 ? '/+' + food.hp + ' 生命' : '') + ')').join('，') + '。'
      + '通常由用户在面板上喂食；仅当用户在对话中明确要求你进食时才调用。',
    parameters: {
      food: {
        type: 'string',
        required: true,
        enum: foodKeys,
        description: foods.map((food) => food.label).join(' / '),
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          eat: { type: 'string', required: true, description: '进食结果描述' },
          hunger: { type: 'integer', required: true, description: '进食后的全局饱食度' },
          health: { type: 'integer', required: true, description: '进食后的全局生命值' },
          dead: { type: 'boolean', required: true, description: '进食后是否仍处于饿死状态' },
        },
      },
      render(_args, value) {
        return [{
          type: 'text',
          text: String(value.eat) + ' 当前饱食度 ' + String(value.hunger)
            + '，生命 ' + String(value.health) + '。',
        }]
      },
    },
    execute(args) {
      const food = args !== null && args !== undefined && typeof args.food === 'string'
        ? args.food
        : foodKeys[0]
      const result = survival.feed(food)
      const snapshot = survival.snapshot()
      return {
        eat: result.message,
        hunger: snapshot.hunger,
        health: snapshot.health,
        dead: snapshot.dead,
      }
    },
  })
}
