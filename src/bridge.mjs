/**
 * Host ↔ Client 桥：把宿主进程里的生存状态送到浏览器。
 *
 * 为什么必须有它：客户端半体运行在**浏览器**里的另一个 cordis 实例中，
 * `ctx.get('survivalState')` 永远拿不到宿主用 `ctx.provide` 注册的服务——
 * 两者之间没有任何自动通道。实测症状就是面板静默不渲染（客户端原本在取不到
 * service 时 `return`）。
 *
 * 通道机制照抄同目录下已跑通的打包插件 `dsh-context`：
 *   宿主：`ctx.connection.rpc.handle(CHANNEL, handler)`，handler 收 (endpoint, payload)
 *   客户端：`ctx.connection.rpc.call(CHANNEL, endpoint, payload)`
 * 返回信封必须是 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`，
 * 这是 ConnectionRpc 传输层约定的形状。
 *
 * 注意：不要照抄官方 skill 文档里的 `harness.handle` / `host.call`——那是动态
 * Cordis 插件沙箱专用的 API，打包插件里不存在。
 */

/** RPC 通道名，客户端必须用同一个字符串。 */
export const CHANNEL = '/dsh-survival-mode'

/** 端点名：一个读状态，一个读静态表，六个写（喂食/预设/自定义/重置/采集/合成）。 */
export const ENDPOINTS = {
  snapshot: 'snapshot',
  meta: 'meta',
  feed: 'feed',
  preset: 'preset',
  configure: 'configure',
  reset: 'reset',
  harvest: 'harvest',
  craft: 'craft',
}

/**
 * 包一个成功信封。
 *
 * @param value 返回给客户端的数据。
 * @returns RPC 成功信封。
 */
export function ok(value) {
  return { ok: true, value }
}

/**
 * 包一个失败信封。
 *
 * @param code 稳定错误码。
 * @param message 人可读原因。
 * @returns RPC 失败信封。
 */
export function fail(code, message) {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * 造宿主侧的 RPC handler。
 *
 * 纯函数、无外部 import：因此可以在测试里直接喂一个假 service 验证路由与
 * 信封形状，不需要启动 cordis，也不需要真实浏览器。
 *
 * @param survival 生存状态机（snapshot / feed / applyPreset / configure / reset）。
 * @param meta 静态表（presets / foods），只在 meta 端点用到；缺省则为空表。
 * @returns `(endpoint, payload) => Promise<信封>`。
 */
export function createHostHandler(survival, meta) {
  const tables = meta !== null && typeof meta === 'object' ? meta : { presets: [], foods: [] }
  return async function handle(endpoint, payload) {
    const body = payload !== null && typeof payload === 'object' ? payload : {}
    try {
      switch (endpoint) {
        case ENDPOINTS.snapshot:
          return ok(survival.snapshot())
        case ENDPOINTS.meta:
          // 预设数值、食物表与小游戏数值只有宿主一份真值，客户端不复制，避免两处漂移。
          return ok({
            presets: Array.isArray(tables.presets) ? tables.presets : [],
            foods: Array.isArray(tables.foods) ? tables.foods : [],
            game: tables.game !== null && typeof tables.game === 'object' ? tables.game : null,
            recipes: tables.recipes !== null && typeof tables.recipes === 'object' ? tables.recipes : {},
          })
        case ENDPOINTS.feed: {
          if (typeof body.food !== 'string' || body.food === '') {
            return fail('survival-mode/bad-request', 'feed 需要字符串 food')
          }
          const result = survival.feed(body.food)
          // 喂食结果与最新状态一起回传，客户端可立即刷新，不必等下一次轮询。
          return ok({ result, snapshot: survival.snapshot() })
        }
        case ENDPOINTS.preset: {
          if (typeof body.id !== 'string' || body.id === '') {
            return fail('survival-mode/bad-request', 'preset 需要字符串 id')
          }
          const result = survival.applyPreset(body.id)
          return ok({ result, snapshot: survival.snapshot() })
        }
        case ENDPOINTS.configure: {
          const patch = body.patch !== null && typeof body.patch === 'object' ? body.patch : {}
          const result = survival.configure(patch)
          return ok({ result, snapshot: survival.snapshot() })
        }
        case ENDPOINTS.reset: {
          const result = survival.reset()
          return ok({ result, snapshot: survival.snapshot() })
        }
        case ENDPOINTS.harvest: {
          if (typeof body.source !== 'string' || body.source === '') {
            return fail('survival-mode/bad-request', 'harvest 需要字符串 source')
          }
          const result = survival.harvest(body.source)
          return ok({ result, snapshot: survival.snapshot() })
        }
        case ENDPOINTS.craft: {
          if (typeof body.recipe !== 'string' || body.recipe === '') {
            return fail('survival-mode/bad-request', 'craft 需要字符串 recipe')
          }
          const result = survival.craft(body.recipe)
          return ok({ result, snapshot: survival.snapshot() })
        }
        default:
          return fail('survival-mode/unknown-endpoint', '未知端点: ' + String(endpoint))
      }
    } catch (error) {
      return fail('survival-mode/internal', error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * 把桥挂到宿主连接上。
 *
 * `connection` 由 `ctx.inject(['connection'], cb)` 在服务就绪后传入；本函数只做
 * 注册与清理，注册失败（例如没有连接服务）时安静返回，不影响宿主半体其余功能。
 *
 * @param deps 依赖包：survival 状态机、meta 静态表、connection 服务、effect 注册器、日志函数。
 * @returns 是否注册成功。
 */
export function mountHostBridge({ survival, meta, connection, effect, log }) {
  const handle = typeof connection?.rpc?.handle === 'function'
    ? connection.rpc.handle.bind(connection.rpc)
    : undefined
  if (handle === undefined) {
    log('survival-mode: 没有 connection.rpc.handle，面板桥未挂载（宿主功能不受影响）')
    return false
  }

  const handler = createHostHandler(survival, meta)
  try {
    effect(() => {
      const unregister = handle(CHANNEL, handler)
      return () => unregister()
    }, 'dsh-survival-mode: rpc channel')
    return true
  } catch (error) {
    log('survival-mode: 面板桥挂载失败: ' + (error instanceof Error ? error.message : String(error)))
    return false
  }
}

/**
 * 客户端写操作 → 请求体字段名的映射。
 *
 * 这是两端最容易悄悄写歪的一处（宿主读 `body.food`，客户端发 `{ food }`），
 * 所以映射只在这里定义一次，由 scripts/build.mjs 在构建期注入客户端 bundle——
 * 客户端不复制这张表，也就无从漂移。
 */
export const WRITE_FIELDS = {
  feed: 'food',
  preset: 'id',
  configure: 'patch',
  harvest: 'source',
  craft: 'recipe',
}