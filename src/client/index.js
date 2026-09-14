/**
 * 客户端半体：会话页面右下角的生存模式 HUD。
 *
 * 形态约定（与动态插件沙箱版不同，改写时必须留意）：
 * - 本文件是 CommonJS，被 scripts/build.mjs 包进
 *   `window.__ModuleLoader__.load({ id, factory: (require) => … })` 的闭包工厂里。
 *   因此这里用 `require('react')` 取 React，而不是依赖任何全局变量。
 * - React 与 cordis 由模块表（PLATFORM_MODULES）提供，必须保持 external；
 *   打包器若把它们打进产物，浏览器会出现第二份 React 实例。
 * - CSS 由构建期编译并注入带 data-plugin 标记的 <style>，不依赖 document 之外的全局。
 *
 * 样式沿用动态插件版实测的视觉：低饱和砖红生命、琥珀饱食条、三档预设按钮、大字饿死计数。
 */

const React = require('react')

/** 配色。生命用低饱和砖红（#ff2d2d 在深色背景上过艳，实测刺眼）。 */
const COLOR = {
  accent: 'var(--dsh-accent, #4c8dff)',
  hunger: '#f0a63a',
  hungerLow: '#e05a3a',
  hp: '#c9544e',
  hpLow: '#8f3630',
  ok: '#3fbf7f',
  warn: '#e0a83a',
  dead: '#d93a3a',
}

/** 面板样式。类名前缀 dsv- 避免与其他插件冲突。 */
const CSS = [
  '.dsv-root{position:fixed;right:22px;bottom:22px;z-index:60;pointer-events:auto;font:12px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsh-text,#e8e8ed)}',
  '.dsv-root *{box-sizing:border-box}',
  '.dsv-card{width:292px;border-radius:14px;padding:12px 13px 13px;background:var(--dsh-surface,#1b1b21);border:1px solid var(--dsh-border,rgba(255,255,255,.13));box-shadow:0 14px 36px rgba(0,0,0,.34)}',
  '.dsv-card.dsv-dead{border-color:rgba(201,84,78,.6)}',
  '.dsv-head{display:flex;align-items:center;gap:7px;cursor:grab;user-select:none;margin-bottom:8px;touch-action:none}',
  '.dsv-head:active{cursor:grabbing}',
  '.dsv-title{font-weight:600;font-size:12.5px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dsv-dot{width:7px;height:7px;border-radius:50%;box-shadow:0 0 7px currentColor;flex:none}',
  '.dsv-ico{border:0;background:transparent;color:inherit;opacity:.62;cursor:pointer;font-size:12px;padding:2px 3px;line-height:1}',
  '.dsv-ico:hover{opacity:1}',
  '.dsv-hp{color:' + COLOR.hp + '}',
  '.dsv-modes{display:flex;gap:5px;margin-bottom:10px}',
  '.dsv-mode{flex:1;border:1px solid var(--dsh-border,rgba(255,255,255,.16));background:rgba(128,128,138,.12);color:inherit;border-radius:8px;padding:5px 0;font-size:11px;cursor:pointer}',
  '.dsv-mode:hover:enabled{background:rgba(128,128,138,.26)}',
  '.dsv-mode.dsv-active{background:' + COLOR.accent + ';border-color:transparent;color:#fff;font-weight:600}',
  '.dsv-row{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px;font-size:11.5px}',
  '.dsv-row span:last-child{font-variant-numeric:tabular-nums;opacity:.82}',
  '.dsv-bar{height:8px;border-radius:5px;background:rgba(128,128,138,.26);overflow:hidden;margin-bottom:9px}',
  '.dsv-fill{height:100%;border-radius:5px;transition:width .28s ease,background .28s ease}',
  '.dsv-actions{display:flex;gap:6px;margin-top:3px}',
  '.dsv-btn{flex:1;border:1px solid var(--dsh-border,rgba(255,255,255,.16));background:rgba(128,128,138,.15);color:inherit;border-radius:9px;padding:6px 2px;font-size:11px;cursor:pointer;line-height:1.35}',
  '.dsv-btn:hover:enabled{background:rgba(128,128,138,.3)}',
  '.dsv-btn:disabled{opacity:.45;cursor:not-allowed}',
  '.dsv-btn.dsv-primary:enabled{background:' + COLOR.accent + ';border-color:transparent;color:#fff}',
  '.dsv-btn small{display:block;font-size:9px;opacity:.72;font-variant-numeric:tabular-nums}',
  '.dsv-note{margin-top:9px;font-size:10.5px;opacity:.66;line-height:1.45}',
  '.dsv-alert{margin-top:9px;font-size:11px;border-radius:8px;padding:6px 8px;background:rgba(201,84,78,.14);border:1px solid rgba(201,84,78,.36)}',
  '.dsv-deaths{margin-top:10px;text-align:center;font-size:12.5px;font-weight:600;color:' + COLOR.hp + ';font-variant-numeric:tabular-nums;padding:5px 0;border-radius:9px;background:rgba(201,84,78,.1);border:1px solid rgba(201,84,78,.26)}',
  '.dsv-cfg{margin-top:9px;padding-top:9px;border-top:1px dashed var(--dsh-border,rgba(255,255,255,.16))}',
  '.dsv-cfgrow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11px}',
  '.dsv-cfgrow input{width:66px;background:rgba(128,128,138,.18);border:1px solid var(--dsh-border,rgba(255,255,255,.18));border-radius:7px;color:inherit;padding:3px 6px;font-size:11px;text-align:right}',
  '.dsv-foot{display:flex;justify-content:space-between;align-items:center;margin-top:9px;font-size:10px;opacity:.55}',
  '.dsv-reset{border:0;background:transparent;color:inherit;font-size:10px;text-decoration:underline;cursor:pointer;padding:0}',
  '.dsv-badge{position:fixed;right:22px;bottom:22px;z-index:60;pointer-events:auto;display:flex;align-items:center;gap:6px;border-radius:999px;padding:6px 12px;cursor:pointer;background:var(--dsh-surface,#1b1b21);border:1px solid var(--dsh-border,rgba(255,255,255,.13));box-shadow:0 8px 24px rgba(0,0,0,.3);color:var(--dsh-text,#e8e8ed);font-variant-numeric:tabular-nums}',
  '.dsv-own{display:block;font-size:9px;opacity:.8;font-variant-numeric:tabular-nums}',
  '.dsv-game{width:100%;margin-top:6px}',
  // 原版贴图图标：pixelated 保证 16×16 放大到 12–14px 不糊；缺贴图时同一 class 承载 emoji。
  '.dsv-ico{display:inline-block;vertical-align:-2px;image-rendering:pixelated;flex:0 0 auto}',
  // MC 采集小游戏：2D 横板场景 + 热键栏背包 + 工作台合成弹窗。
  '.dsm-root{position:fixed;left:22px;bottom:22px;z-index:61;pointer-events:auto;font:12px/1.5 "Courier New",ui-monospace,monospace}',
  '.dsm-root *{box-sizing:border-box}',
  '.dsm-win{position:relative;width:520px;background:#c6c6c6;border:3px solid #1b1b1b;box-shadow:inset 2px 2px 0 #fdfdfd,inset -2px -2px 0 #555,0 14px 36px rgba(0,0,0,.4)}',
  '.dsm-head{display:flex;align-items:center;justify-content:space-between;height:30px;background:#3c8527;color:#fff;padding:0 10px;font-weight:700;text-shadow:1px 1px 0 #1b1b1b;letter-spacing:1px}',
  '.dsm-x{border:2px solid #1b1b1b;background:#8b8b8b;color:#fff;width:22px;height:22px;cursor:pointer;line-height:1;padding:0;box-shadow:inset 1px 1px 0 #fff,inset -1px -1px 0 #555}',
  // 场景 520×422：加头栏 30、热键栏 67、边框 6，整窗约 526×525，接近正方形。
  '.dsm-scene{position:relative;height:422px;overflow:hidden;background:linear-gradient(#79a6ff 0%,#a8ccf5 55%,#cfe8fb 66%)}',
  '.dsm-scene img{image-rendering:pixelated;pointer-events:none;display:block}',
  '.dsm-sun{position:absolute;right:26px;top:16px;width:32px;height:32px;background:#ffe94a;border:2px solid #e8c832;box-shadow:0 0 16px #ffe94a}',
  '.dsm-cloud{position:absolute;height:12px;background:#fff;opacity:.85}',
  // 全场景统一 40px 方块网格：草地/泥土平铺、树干、工作台、金矿都是 1 格 = 40px。
  '.dsm-ground{position:absolute;left:0;right:0;top:300px;height:40px;background-size:40px 40px;background-repeat:repeat-x;image-rendering:pixelated}',
  '.dsm-dirt{position:absolute;left:0;right:0;top:340px;bottom:0;background-size:40px 40px;background-repeat:repeat;image-rendering:pixelated}',
  '.dsm-actor{position:absolute;border:0;background:transparent;padding:0;cursor:pointer}',
  '.dsm-actor:hover{filter:brightness(1.15)}',
  '.dsm-actor:active{transform:scale(.94)}',
  '.dsm-tag{position:absolute;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;font-size:9px;padding:1px 5px;border-radius:3px;white-space:nowrap;pointer-events:none;z-index:4}',
  // .dsm-scene img 是 display:block（方块平铺要用），标签里的图标得覆盖回行内。
  '.dsm-tag img{display:inline-block;vertical-align:-2px;width:10px;height:10px;image-rendering:pixelated}',
  '.dsm-headtitle{display:flex;align-items:center;gap:4px}',
  '.dsm-float{position:absolute;pointer-events:none;font-weight:700;font-size:13px;text-shadow:1px 1px 0 #000;animation:dsmFloat 1.1s ease-out forwards;z-index:5;white-space:nowrap;transform:translateX(-50%)}',
  '@keyframes dsmFloat{0%{opacity:0;margin-top:6px}15%{opacity:1}100%{opacity:0;margin-top:-30px}}',
  '.dsm-msg{position:absolute;left:0;right:0;bottom:4px;text-align:center;font-size:11px;color:#fff;text-shadow:1px 1px 0 #000;pointer-events:none;z-index:4}',
  '.dsm-hotbar{display:flex;justify-content:center;gap:4px;padding:8px;background:#2a2a2a;border-top:3px solid #1b1b1b}',
  '.dsm-slot{position:relative;width:48px;height:48px;background:#8b8b8b;border:2px solid;border-color:#373737 #fff #fff #373737;display:flex;align-items:center;justify-content:center}',
  '.dsm-slot img{width:32px;height:32px;image-rendering:pixelated}',
  '.dsm-slot .dsm-n{position:absolute;right:2px;bottom:0;font-size:11px;font-weight:700;color:#fff;text-shadow:1px 1px 0 #000}',
  '.dsm-slot .dsm-t{position:absolute;left:0;right:0;top:-16px;text-align:center;font-size:9px;color:#eee;text-shadow:1px 1px 0 #000;white-space:nowrap}',
  '.dsm-mask{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:8}',
  '.dsm-craft{background:#c6c6c6;border:3px solid #1b1b1b;box-shadow:inset 2px 2px 0 #fdfdfd,inset -2px -2px 0 #555;padding:12px 14px;width:360px;color:#222}',
  '.dsm-ctitle{font-weight:700;margin-bottom:4px}',
  '.dsm-chint{font-size:10px;color:#444;margin-bottom:8px}',
  '.dsm-crow{display:flex;align-items:center;justify-content:center;gap:8px;margin:8px 0 4px}',
  '.dsm-cslot{position:relative;width:56px;height:56px;background:#8b8b8b;border:2px solid;border-color:#373737 #fff #fff #373737;display:flex;align-items:center;justify-content:center}',
  '.dsm-cslot img{width:36px;height:36px;image-rendering:pixelated}',
  '.dsm-cslot .dsm-n{position:absolute;right:2px;bottom:0;font-size:11px;font-weight:700;color:#fff;text-shadow:1px 1px 0 #000}',
  '.dsm-cslot .dsm-t{position:absolute;left:0;right:0;top:-15px;text-align:center;font-size:9px;color:#333;white-space:nowrap}',
  '.dsm-cslot .dsm-own{position:absolute;left:0;right:0;bottom:-15px;text-align:center;font-size:9px;color:#333;white-space:nowrap}',
  '.dsm-op{font-size:18px;font-weight:700;color:#333}',
  '.dsm-craftbtn{width:100%;margin-top:14px;padding:7px 0;border:2px solid #1b1b1b;background:#6fbf3f;color:#fff;font-weight:700;font-size:12px;cursor:pointer;text-shadow:1px 1px 0 #2d5d16;box-shadow:inset 1px 1px 0 #b7f29a,inset -1px -1px 0 #3a7d1f}',
  '.dsm-craftbtn:disabled{opacity:.5;cursor:not-allowed}',
  '.dsm-craftbtn:hover:enabled{filter:brightness(1.1)}',
].join('\n')

/** 面板刷新间隔：状态变化只由服务通知驱动会漏掉掉血 tick，轮询最稳。 */
const POLL_MS = 700

/** 向宿主拉取状态的间隔。比 POLL_MS 慢，因为面板读的是本地缓存。 */
const RPC_POLL_MS = 1000

/**
 * 构建期从 src/bridge.mjs 注入的跨面常量。**这行必须原样保留**：
 * scripts/build.mjs 用正则匹配这一行并替换成真实的 RPC_CHANNEL / RPC_ENDPOINTS，
 * 两端因此共用同一个真值来源，不会各写一份悄悄漂移。
 */
const INJECTED = null

/**
 * 尚无数据时的占位快照。
 *
 * 数值取 normal 预设，字段与宿主 state.snapshot() 对齐：面板首帧需要每个字段都
 * 存在，否则读取 undefined 会直接白屏。这只是占位，第一次 refresh 就会覆盖它。
 */
const FALLBACK_SNAPSHOT = {
  hunger: 150,
  maxHunger: 150,
  health: 12,
  maxHealth: 12,
  hungerPerStep: 6,
  tickSeconds: 4,
  stepCount: 0,
  deathCount: 0,
  dead: false,
  starving: false,
  critical: false,
  preset: 'normal',
  secondsToDeath: null,
  hungerPercent: 100,
  reviveHunger: 60,
  reviveHp: 3,
  reviveFood: 'golden_apple',
  invApple: 0,
  invBread: 0,
  invGoldenApple: 0,
  invGoldIngot: 0,
  treeReady: 0,
  treeNextIn: null,
}

/**
 * 造客户端侧的生存服务适配器。
 *
 * UI 组件要的是**同步**的 snapshot()/onChange()，而 RPC 是异步的。这个适配器用
 * 一份本地缓存桥接两者：refresh 与写操作都会刷新缓存并通知订阅者，于是组件代码
 * 不需要感知 RPC 的异步性。
 *
 * @param deps call（connection.rpc.call 的绑定版）与 fallback 占位快照。
 * @returns 与宿主 service 同形的适配器。
 */
function createClientService(deps) {
  const call = deps.call
  let cache = deps.fallback
  const listeners = new Set()

  /** 缓存新快照并通知订阅者；单个订阅者抛错不影响其它订阅者。 */
  function publish(next) {
    if (next === null || typeof next !== 'object') return
    cache = next
    listeners.forEach((listener) => {
      try {
        listener(cache)
      } catch (error) {
        console.warn('dsh-survival-mode: listener failed', error)
      }
    })
  }

  /** 发一次 RPC 并解包 { ok, value } / { ok, error } 信封。 */
  async function invoke(endpoint, payload) {
    const response = await call(RPC_CHANNEL, endpoint, payload === undefined ? {} : payload)
    if (response === null || typeof response !== 'object') {
      throw new Error('survival-mode: 响应形状非法')
    }
    if (response.ok !== true) {
      const envelope = response.error
      const message = envelope !== null && typeof envelope === 'object' ? envelope.message : undefined
      throw new Error(typeof message === 'string' ? message : 'survival-mode: rpc 失败')
    }
    return response.value
  }

  return {
    snapshot: () => cache,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 拉一次最新状态；任何失败都保持上一份缓存，绝不抛出。 */
    async refresh() {
      try {
        publish(await invoke(RPC_ENDPOINTS.snapshot, {}))
      } catch {
        // 断线时保持旧数据，面板不白屏。
      }
    },
    /** 写操作：成功后用响应附带的最新快照刷新缓存，并返回 result 供 UI 提示。 */
    async mutate(endpoint, payload) {
      const value = await invoke(endpoint, payload)
      if (value !== null && typeof value === 'object' && value.snapshot !== undefined) {
        publish(value.snapshot)
      }
      return value !== null && typeof value === 'object' ? value.result : value
    },
  }
}

/** 五个写操作 + reset：端点名与请求体字段名都由构建期从 bridge.mjs 注入。 */
function withMutations(service) {
  service.feed = (food) => service.mutate(RPC_ENDPOINTS.feed, { [RPC_WRITE_FIELDS.feed]: food })
  service.preset = (id) => service.mutate(RPC_ENDPOINTS.preset, { [RPC_WRITE_FIELDS.preset]: id })
  service.configure = (patch) => service.mutate(RPC_ENDPOINTS.configure, { [RPC_WRITE_FIELDS.configure]: patch })
  service.reset = () => service.mutate(RPC_ENDPOINTS.reset, {})
  service.harvest = (source) => service.mutate(RPC_ENDPOINTS.harvest, { [RPC_WRITE_FIELDS.harvest]: source })
  service.craft = (recipe) => service.mutate(RPC_ENDPOINTS.craft, { [RPC_WRITE_FIELDS.craft]: recipe })
  return service
}

/**
 * 注入面板样式。样式随客户端 run 一起回收。
 * @returns 移除样式标签的函数。
 */
function injectStyles() {
  const existing = document.querySelector('style[data-plugin="dsh-survival-mode"]')
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-survival-mode'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}

/**
 * 绘制一条进度条。
 * @param percent 0–100。
 * @param color 正常颜色。
 * @param lowColor 低于 25% 时使用的颜色。
 */
function bar(percent, color, lowColor) {
  return React.createElement('div', { className: 'dsv-bar' },
    React.createElement('div', {
      className: 'dsv-fill',
      style: { width: percent + '%', background: percent <= 25 ? lowColor : color },
    }),
  )
}

/** 发一次只读 RPC 并解包信封；失败返回 null。 */
async function invokeMeta(call) {
  try {
    const response = await call(RPC_CHANNEL, RPC_ENDPOINTS.meta, {})
    if (response === null || typeof response !== 'object' || response.ok !== true) return null
    return response.value
  } catch {
    return null
  }
}

/** 物品键 → 快照里的库存标量字段（宿主 snapshot 把背包展开成标量，两端靠这张表对齐）。 */
const INV_FIELD = {
  apple: 'invApple',
  bread: 'invBread',
  golden_apple: 'invGoldenApple',
  gold_ingot: 'invGoldIngot',
}

/**
 * 读某物品的背包数量；快照字段缺失时按 0 处理（占位快照永远带这些字段，
 * 但防御一下旧缓存没有坏处）。
 */
function invCount(snapshot, key) {
  const field = INV_FIELD[key]
  const value = field === undefined ? 0 : snapshot[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * MC 贴图的**回退层**：16×16 字符画像素 SVG，编译成 data URI 内联进 bundle。
 *
 * 为什么留着它而不是直接删掉：原版贴图是构建期从 assets/vanilla/textures.json 注入的
 * （见下方 VANILLA_TEX），一旦有人没跑贴图管线就 clone 下来构建，这一层保证场景与
 * 热键栏仍然完整可玩，绝不裂图——它零依赖、零网络、永远出图。
 *
 * 每个字符是 1 个像素，字符 → 颜色由调色板给出；'.' 表示透明。
 */
function pixelTexture(rows, palette) {
  const height = rows.length
  const width = rows[0].length
  const rects = []
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]
    for (let x = 0; x < row.length; x += 1) {
      const color = palette[row[x]]
      if (color !== undefined) {
        rects.push('<rect x=\'' + x + '\' y=\'' + y + '\' width=\'1\' height=\'1\' fill=\'' + color + '\'/>')
      }
    }
  }
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'' + width + '\' height=\'' + height
    + '\' viewBox=\'0 0 ' + width + ' ' + height + '\' shape-rendering=\'crispEdges\'>'
    + rects.join('') + '</svg>',
  )
}

/**
 * 构建期从 assets/vanilla/textures.json 注入的 **Minecraft 原版贴图**（键 → PNG data URI）。
 *
 * **这行必须原样保留**：scripts/build.mjs 用正则匹配这一行并替换成真实贴图表。
 * 源码态是空对象，所以直接跑 src/（不经过构建）时全部回退到下面的手绘像素画。
 *
 * 贴图本身由 scripts/vanilla-textures.mjs 从官方客户端 jar 里取，仍然**内联进 bundle**，
 * 于是运行期和以前一样零网络请求——换成原版贴图没有引入任何联网依赖。
 */
const VANILLA_TEX = {}

/**
 * 手绘像素画贴图表（回退层，同名键会被上面的原版贴图覆盖）。
 */
const HAND_TEX = {
  // 草方块侧面：上 4 行草皮（底缘参差），下面是泥土。
  grass: pixelTexture([
    'GGGGGGGGGGGGGGGG',
    'GgGGGGgGGGgGGGGG',
    'GGGgGGGGGGgGGgGG',
    'gGGGGGgGGGGGGGGg',
    'DDGDDDDDGDDDDGDD',
    'DDDDDDdDDDDDDDDD',
    'DDdDDDDDDDDdDDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDdDDDDDdDDDDD',
    'DdDDDDDDDDDDDDDD',
    'DDDDDDDDdDDDDDdD',
    'DDDdDDDDDDDDDDDD',
    'DDDDDDDDDDdDDDDD',
    'DDdDDdDDDDDDDDDD',
    'DDDDDDDDDdDDDDDD',
    'dDDDDDDDDDDDDDdD',
  ], { G: '#6fa53f', g: '#5d9334', D: '#8a6242', d: '#77512f' }),
  dirt: pixelTexture([
    'DDDDDDdDDDDDDDDD',
    'DDdDDDDDDDDdDDDD',
    'DDDDDDDDDDDDDDDD',
    'DDDDdDDDDDdDDDDD',
    'DdDDDDDDDDDDDDDD',
    'DDDDDDDDdDDDDDdD',
    'DDDdDDDDDDDDDDDD',
    'DDDDDDDDDDdDDDDD',
    'DDdDDdDDDDDDDDDD',
    'DDDDDDDDDdDDDDDD',
    'dDDDDDDDDDDDDDdD',
    'DDDDDDdDDDDdDDDD',
    'DDDDdDDDDDDDDDDD',
    'DdDDDDDDdDDDDdDD',
    'DDDDDDDDDDDDDDDD',
    'DDdDDdDDDDdDDDDD',
  ], { D: '#8a6242', d: '#77512f' }),
  // 金矿：灰石头里嵌金粒。
  goldOre: pixelTexture([
    'SSSSsSSSSSSsSSSS',
    'SsSSSSSkSSSSSSSS',
    'SSSYyYSSSSSSsSSS',
    'SSyYYySSkSSSSSSS',
    'SSSYyYSSSSSSSSSS',
    'SsSSSSsSSSsSSSSS',
    'SSSSSSSSSSYYySSS',
    'SSSkSSSSSSyYySSS',
    'SSSSSSsSSSYyYSSS',
    'SSSSSSSSSSSSsSSS',
    'SsSSkSSSSkSSSSSS',
    'SSSSSSSSSSSSSYyS',
    'SYySSsSSSSSSyYYS',
    'SyYSSSSSSkSSYyYS',
    'SYySSSSSSSSSSsSS',
    'SSSsSSsSSSSSSSSS',
  ], { S: '#8b8b8b', s: '#7a7a7a', k: '#666666', Y: '#ffd83d', y: '#f0b821' }),
  // 橡木树干：竖向树皮条纹，带两个木节。
  log: pixelTexture([
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDkBLLBBDBB',
    'DBLLBBDkkLLBBDBB',
    'DBLLBBDkBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBkDB',
    'DBLLBBDBBLLBBkkB',
    'DBLLBBDBBLLBBkDB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
    'DBLLBBDBBLLBBDBB',
  ], { D: '#4a3520', B: '#5c4326', L: '#6b4f2e', k: '#3a2a18' }),
  // 树叶：原版 oak_leaves.png × MC 标准叶绿 #59AE30（还原游戏内的生物群系
  // 染色）预处理成成品 PNG 后内联——和 MC 原版橡树树叶一致，零网络依赖。
  leaves: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADWSURBVDhPfZLRDcIwDEQ9BOKPL/jivwMgdYCOwRhsHnRWX3RxApaipJezfb40HvulaUVEvD733Lf3rWnp/DyuTUscMLjCkwyooKAuudPu30rWmYYZdCKBJFcFVxgrAch1HLqAeUzJ7BAmied47k8n1mQMQpErqP4Ms+vSpUP6689qdjdo9SoozG/vBBnMFdAVrI+9MmrVlYKugvPw5zEKWJ+1/AsUmRyvBCVRYHCfAKxSuV+ZCZa7d/ilxsfyF+gjkAzoCkROt8+oY3VjBLAg1xfxIuR+AduJIZqDsvSwAAAAAElFTkSuQmCC',
  // 工作台正面：上半工具格，下半木板。
  table: pixelTexture([
    'KKKKKKKKKKKKKKKK',
    'KPPPPPPPPPPPPPPK',
    'KPkkPPPPkkPPPPkK',
    'KPkkPPPPkkPPPPkK',
    'KPPPPPPPPPPPPPPK',
    'KPPPPkkPPPPkkPPK',
    'KPPPPkkPPPPkkPPK',
    'KPPPPPPPPPPPPPPK',
    'KppppppppppppppK',
    'KPPPPPPPPPPPPPPK',
    'KppppppppppppppK',
    'KPPPPPPPPPPPPPPK',
    'KppppppppppppppK',
    'KppppppppppppppK',
    'KPPPPPPPPPPPPPPK',
    'KKKKKKKKKKKKKKKK',
  ], { K: '#4a3520', P: '#b08b54', p: '#9a7648', k: '#6e5636' }),
  // 村民：16×32（一格宽两格高，与 MC 实体同比例）——大头、一字眉、绿眼睛、
  // 垂下来的大鼻子、棕色长袍、胸前抱臂。
  villager: pixelTexture([
    '....SSSSSSSS....',
    '...SSSSSSSSSS...',
    '..SSSSSSSSSSSS..',
    '..SSSSSSSSSSSS..',
    '..UUUUUUUUUUUU..',
    '..SEESSSSSEES...',
    '..SEESSSSSEES...',
    '..SSSSNNNNSSSS..',
    '..SSSSNNNNSSSS..',
    '..SSSSNNNNSSSS..',
    '..SSSSNNNNSSSS..',
    '..SSSSNNNNSSSS..',
    '...SSSNNNNSSS...',
    '....SSSSSSSS....',
    '.....RRRRRR.....',
    '..RRRRRRRRRRRR..',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRHHHHHHHHRRR.',
    '.RRRHHHHHHHHRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.RRRRRRRRRRRRRR.',
    '.rRRRRRRRRRRRRr.',
    '.rRRRRRRRRRRRRr.',
    '..RRRRRRRRRRRR..',
    '..RRRRRRRRRRRR..',
    '..kkkk....kkkk..',
    '..kkkk....kkkk..',
  ], { S: '#b5855a', U: '#4a3728', E: '#3f7a35', N: '#9a6b45', R: '#7a5a3a', r: '#64492e', H: '#b5855a', k: '#3a2a18' }),
  apple: pixelTexture([
    '.......k........',
    '.......kk.......',
    '......kk.lLL....',
    '....rrrRRRrr....',
    '..rrRRRRRRRRrr..',
    '.rRWWRRRRRRRRRr.',
    '.rRWRRRRRRRRRRr.',
    'rRRRRRRRRRRRRRRr',
    'rRRRRRRRRRRRRRRr',
    '.rRRRRRRRRRRRRr.',
    '.rRRRRRRRRRRRRr.',
    '..rRRRRRRRRRRr..',
    '...rrRRRRRRrr...',
    '.....rrrRrrr....',
    '................',
    '................',
  ], { R: '#c72e2e', r: '#a32020', W: '#f28a8a', k: '#5a3a1a', l: '#3f9c2f', L: '#56b83f' }),
  goldenApple: pixelTexture([
    '.......k........',
    '.......kk.......',
    '......kk.lLL....',
    '....gggGGGgg....',
    '..ggGGGGGGGGgg..',
    '.gGWWGGGGGGGGGg.',
    '.gGWGGGGGGGGGGg.',
    'gGGGGGGGGGGGGGGg',
    'gGGGGGGGGGGGGGGg',
    '.gGGGGGGGGGGGGg.',
    '.gGGGGGGGGGGGGg.',
    '..gGGGGGGGGGGg..',
    '...ggGGGGGGgg...',
    '.....gggGggg....',
    '................',
    '................',
  ], { G: '#ffd83d', g: '#e0a92c', W: '#fff3b0', k: '#5a3a1a', l: '#3f9c2f', L: '#56b83f' }),
  bread: pixelTexture([
    '................',
    '................',
    '................',
    '................',
    '....bbbbbbbbbb..',
    '..bbBBBBBBBBBBbb',
    '.bBBBbBBBbBBBbBBb',
    'bBBBBBBBBBBBBBBBb',
    'bBbBBBbBBBbBBbBBb',
    '.bbbbbbbbbbbbbbb.',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ], { B: '#d8a354', b: '#a8763a' }),
  goldIngot: pixelTexture([
    '................',
    '................',
    '................',
    '................',
    '................',
    '...YYYYYYYYYY...',
    '..YWWYYYYYYYYYy.',
    '.YYYYYYYYYYYYYy.',
    '.yYYYYYYYYYYYYy.',
    '..yyyyyyyyyyyy..',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ], { Y: '#ffd83d', W: '#fff3b0', y: '#d9a924' }),
}

/**
 * 最终贴图表：**原版贴图优先，缺失的键回退到手绘像素画**。
 *
 * 两层键集刻意对齐（方块/物品 16×16、村民 16×32），所以浅合并即可安全换图；
 * 原版独有的键（stone/planks/pickaxe/heart/foodFull/skull）在没有注入时是
 * undefined，客户端用 icon() 统一退回 emoji，不会出现半张图。
 */
const TEX = Object.assign({}, HAND_TEX, VANILLA_TEX)

/** 物品键 → 热键栏/合成界面用的贴图与中文名。 */
const ITEM_VIEW = {
  apple: { icon: TEX.apple, label: '苹果' },
  bread: { icon: TEX.bread, label: '面包' },
  golden_apple: { icon: TEX.goldenApple, label: '金苹果' },
  gold_ingot: { icon: TEX.goldIngot, label: '金锭' },
}

/** 热键栏里展示的物品顺序：三种食物 + 合成材料金锭。 */
const HOTBAR_ITEMS = ['apple', 'bread', 'golden_apple', 'gold_ingot']

/** 物品键 → TEX 里的贴图键。 */
const ITEM_TEX_KEY = {
  apple: 'apple',
  bread: 'bread',
  golden_apple: 'goldenApple',
  gold_ingot: 'goldIngot',
}

/**
 * 造一个贴图图标：原版贴图存在就用 `<img>`（pixelated 放大，不糊），否则退回 emoji。
 *
 * 为什么不做成「要么全 img 要么全 emoji」：原版贴图里 HUD 图标（heart/food）是
 * 可选素材，不同版本路径可能不同；逐个图标降级能保证任何情况下面板都长得完整。
 *
 * @param source 贴图 data URI；缺失时传 undefined。
 * @param emoji 退化用的 emoji。
 * @param size 边长（px）。
 * @returns React 元素。
 */
function icon(source, emoji, size) {
  if (typeof source === 'string') {
    return React.createElement('img', {
      className: 'dsv-ico',
      src: source,
      alt: '',
      style: { width: size + 'px', height: size + 'px' },
    })
  }
  return React.createElement('span', { className: 'dsv-ico', style: { fontSize: size + 'px' } }, emoji)
}

/**
 * 场景统一 40px 方块网格（BLOCK）。树是 3×3 树叶方块 + 4 格树干方块，
 * 金矿/工作台各 1 格，村民 1 格宽 2 格高（与 MC 实体同比例）。
 */
const BLOCK = 40

/** 树上苹果的挂果位置（相对 520×422 场景，落在金字塔树冠上；最多 treeMaxReady 个）。 */
const TREE_APPLE_SPOTS = [
  { left: 60, top: 112 },
  { left: 186, top: 112 },
  { left: 126, top: 66 },
]

/** 地下金矿块的位置（相对场景；草皮 y=300–340，泥土区从 y=340 起，金矿嵌在第二行）。 */
const ORE_SPOTS = [
  { left: 80, top: 380 },
  { left: 200, top: 380 },
  { left: 320, top: 380 },
  { left: 440, top: 380 },
]

/** 各采集点飘字的锚点（相对场景）。 */
const FLOAT_ANCHOR = {
  tree: { left: 140, top: 36 },
  villager: { left: 270, top: 208 },
  mine: { left: 270, top: 366 },
  table: { left: 420, top: 246 },
}

/*
 * 运行期完全离线：所有材质都是上方 TEX 里的 data URI（原版贴图由构建期从官方客户端 jar
 * 取出后内联，手绘像素画作为回退层），场景与热键栏无一句联网请求，
 * 即便 webview 处于离线状态也能完整出图。
 */

/** MC 采集小游戏窗口：2D 横板场景，整窗接近正方形（约 526×525）。
 *
 * 布局（场景 520×422，草地表面在 y=300，全场统一 40px 方块网格）：
 * - 左侧一棵树（金字塔树冠 5/3/1 + 4 格树干，右移一格）：每 20 秒结 1 个苹果（宿主计时），点击收获全部。
 * - 中间一个村民（1 格宽 2 格高）：点击概率给面包。
 * - 右侧一个工作台（1 格）：点击弹出合成界面（8 金锭 + 1 苹果 → 金苹果）。
 * - 地下一行金矿（各 1 格）：点击小概率给金锭。
 * 贴图运行期完全离线：原版贴图（构建期从官方客户端 jar 内联）+ 手绘回退层，全是 data URI。
 * 数据全部经 service.harvest/craft 走宿主结算，本地只负责展示与飘字。
 *
 * @param props service、snapshot、recipes、onClose。
 */
function McGame(props) {
  const service = props.service
  const snapshot = props.snapshot
  // 完全离线：固定用内置本地像素画（data URI），无任何网络贴图加载。
  const tex = TEX
  const itemIcon = (item) => tex[ITEM_TEX_KEY[item]]
  const [craftOpen, setCraftOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  // 村民/金矿的本地节流（与宿主 clickCooldownMs 一致，避免冷却内连点刷请求）。
  const lastGatherAt = React.useRef({})
  const [floats, setFloats] = React.useState([])
  const [message, setMessage] = React.useState('点村民要面包 · 树上定时结苹果 · 点地下金矿挖金锭 · 点工作台合成金苹果')

  function pushFloat(text, anchorKey, color) {
    const anchor = FLOAT_ANCHOR[anchorKey]
    const id = String(Date.now()) + '-' + String(floats.length)
    setFloats((previous) => [...previous, { id, text, left: anchor.left, top: anchor.top, color }])
    globalThis.setTimeout(() => {
      setFloats((previous) => previous.filter((float) => float.id !== id))
    }, 1150)
  }

  async function gather(source) {
    if (busy) return
    if (source === 'villager' || source === 'mine') {
      const cooldown = typeof snapshot.clickCooldownMs === 'number' ? snapshot.clickCooldownMs : 500
      const nowMs = Date.now()
      if (nowMs - (lastGatherAt.current[source] || 0) < cooldown) return
      lastGatherAt.current[source] = nowMs
    }
    setBusy(true)
    try {
      const result = await service.harvest(source)
      if (result !== null && typeof result === 'object') {
        if (typeof result.message === 'string') {
          setMessage(result.message)
        }
        if (result.gained !== null && result.gained !== undefined) {
          const view = ITEM_VIEW[result.gained.item]
          pushFloat('+' + String(result.gained.count) + ' ' + (view === undefined ? '' : view.label), source, '#8cff8c')
        } else if (typeof result.message === 'string') {
          // message 为 null 表示宿主判定了点击冷却，静默处理，不飘字。
          pushFloat('…', source, '#dddddd')
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  async function doCraft() {
    if (busy) return
    setBusy(true)
    try {
      const result = await service.craft('golden_apple')
      if (result !== null && typeof result === 'object' && typeof result.message === 'string') {
        setMessage(result.message)
      }
      if (result !== null && typeof result === 'object' && result.ok === true) {
        pushFloat('+1 金苹果', 'table', '#ffe94a')
        setCraftOpen(false)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const apples = []
  for (let index = 0; index < Math.min(snapshot.treeReady, TREE_APPLE_SPOTS.length); index += 1) {
    const spot = TREE_APPLE_SPOTS[index]
    apples.push(React.createElement('img', {
      key: index,
      src: tex.apple,
      alt: '苹果',
      style: { position: 'absolute', left: spot.left + 'px', top: spot.top + 'px', width: '22px', height: '22px' },
    }))
  }

  // 树：经典金字塔树冠（下大上小：底层 5 格、中层 3 格、顶 1 格）+ 4 格树干，
  // 全部 40px 方块；整棵树右移一格（场景 x=40 起），整棵可点。
  // 按钮内坐标：树冠 y=0–120，树干 y=120–280，底部对齐草皮（场景 y=300）。
  const treeBlocks = []
  for (let col = 0; col < 5; col += 1) {
    treeBlocks.push({ kind: 'leaves', x: col * BLOCK, y: 2 * BLOCK })
  }
  for (let col = 1; col < 4; col += 1) {
    treeBlocks.push({ kind: 'leaves', x: col * BLOCK, y: BLOCK })
  }
  treeBlocks.push({ kind: 'leaves', x: 2 * BLOCK, y: 0 })
  for (let row = 0; row < 4; row += 1) {
    treeBlocks.push({ kind: 'log', x: 2 * BLOCK, y: 3 * BLOCK + row * BLOCK })
  }

  const scene = React.createElement('div', { className: 'dsm-scene' },
    React.createElement('div', { className: 'dsm-sun' }),
    React.createElement('div', { className: 'dsm-cloud', style: { left: '160px', top: '34px', width: '52px' } }),
    React.createElement('div', { className: 'dsm-cloud', style: { left: '340px', top: '64px', width: '64px' } }),
    React.createElement('button', {
      className: 'dsm-actor',
      style: { left: BLOCK + 'px', top: '20px', width: String(5 * BLOCK) + 'px', height: '280px' },
      title: '点我收获苹果（每 20 秒结 1 个，最多挂 3 个）',
      onClick: () => gather('tree'),
    },
      treeBlocks.map((block, index) => React.createElement('img', {
        key: index,
        src: block.kind === 'leaves' ? tex.leaves : tex.log,
        alt: block.kind === 'leaves' ? '树叶' : '树干',
        style: { position: 'absolute', left: block.x + 'px', top: block.y + 'px', width: BLOCK + 'px', height: BLOCK + 'px' },
      })),
    ),
    apples,
    React.createElement('div', { className: 'dsm-tag', style: { left: '140px', top: '306px' } },
      icon(tex.apple, '🍎', 10),
      ' ' + String(snapshot.treeReady) + '/3'
      + (snapshot.treeNextIn === null ? ' 已满' : ' · 下一颗 ' + String(snapshot.treeNextIn) + 's')),
    // 村民：一格宽、两格高，脚踩草皮。
    React.createElement('button', {
      className: 'dsm-actor',
      style: { left: '250px', top: String(300 - 2 * BLOCK) + 'px' },
      title: '点村民：概率要到 1 个面包',
      onClick: () => gather('villager'),
    }, React.createElement('img', { src: tex.villager, alt: '村民', style: { width: BLOCK + 'px', height: 2 * BLOCK + 'px' } })),
    React.createElement('div', { className: 'dsm-tag', style: { left: '270px', top: '306px' } }, '村民 · 面包'),
    // 工作台：一格。
    React.createElement('button', {
      className: 'dsm-actor',
      style: { left: '400px', top: String(300 - BLOCK) + 'px' },
      title: '点工作台：打开合成界面',
      onClick: () => setCraftOpen(true),
    }, React.createElement('img', { src: tex.table, alt: '工作台', style: { width: BLOCK + 'px', height: BLOCK + 'px' } })),
    React.createElement('div', { className: 'dsm-tag', style: { left: '420px', top: '306px' } }, '工作台'),
    // 地面与地下。
    React.createElement('div', { className: 'dsm-ground', style: { backgroundImage: 'url("' + tex.grass + '")' } }),
    React.createElement('div', { className: 'dsm-dirt', style: { backgroundImage: 'url("' + tex.dirt + '")' } }),
    ORE_SPOTS.map((spot, index) => React.createElement('button', {
      key: index,
      className: 'dsm-actor',
      style: { left: spot.left + 'px', top: spot.top + 'px' },
      title: '点金矿：小概率挖出金锭',
      onClick: () => gather('mine'),
    }, React.createElement('img', { src: tex.goldOre, alt: '金矿', style: { width: BLOCK + 'px', height: BLOCK + 'px' } }))),
    React.createElement('div', { className: 'dsm-tag', style: { left: '270px', top: '396px' } }, '金矿 · 金锭'),
    floats.map((float) => React.createElement('div', {
      key: float.id,
      className: 'dsm-float',
      style: { left: float.left + 'px', top: float.top + 'px', color: float.color },
    }, float.text)),
    React.createElement('div', { className: 'dsm-msg' }, message),
  )

  const hotbar = React.createElement('div', { className: 'dsm-hotbar' },
    HOTBAR_ITEMS.map((item) => {
      const view = ITEM_VIEW[item]
      return React.createElement('div', { key: item, className: 'dsm-slot', title: view.label },
        React.createElement('span', { className: 'dsm-t' }, view.label),
        React.createElement('img', { src: itemIcon(item), alt: view.label }),
        React.createElement('span', { className: 'dsm-n' }, String(invCount(snapshot, item))),
      )
    }),
  )

  const recipe = props.recipes.golden_apple
  const needs = recipe === null || recipe === undefined ? { gold_ingot: 8, apple: 1 } : recipe.needs
  const needEntries = Object.keys(needs).map((item) => ({ item, count: needs[item] }))
  const craftable = needEntries.every((entry) => invCount(snapshot, entry.item) >= entry.count)

  const craftModal = !craftOpen ? null : React.createElement('div', { className: 'dsm-mask' },
    React.createElement('div', { className: 'dsm-craft' },
      React.createElement('div', { className: 'dsm-ctitle' }, '工作台 · 合成'),
      React.createElement('div', { className: 'dsm-chint' }, '唯一配方：8 块金锭 + 1 个苹果 → 1 个金苹果'),
      React.createElement('div', { className: 'dsm-crow' },
        needEntries.map((entry) => {
          const view = ITEM_VIEW[entry.item]
          return React.createElement('div', { key: entry.item, className: 'dsm-cslot' },
            React.createElement('span', { className: 'dsm-t' }, view.label),
            React.createElement('img', { src: itemIcon(entry.item), alt: view.label }),
            React.createElement('span', { className: 'dsm-n' }, '×' + String(entry.count)),
            React.createElement('span', { className: 'dsm-own' }, '已有 ' + String(invCount(snapshot, entry.item))),
          )
        }),
        React.createElement('span', { className: 'dsm-op' }, '→'),
        React.createElement('div', { className: 'dsm-cslot' },
          React.createElement('span', { className: 'dsm-t' }, '金苹果'),
          React.createElement('img', { src: tex.goldenApple, alt: '金苹果' }),
          React.createElement('span', { className: 'dsm-n' }, '×1'),
        ),
      ),
      React.createElement('button', {
        className: 'dsm-craftbtn',
        disabled: busy || !craftable,
        onClick: () => doCraft(),
      }, craftable ? '合成金苹果' : '材料不足'),
      React.createElement('button', {
        className: 'dsm-craftbtn',
        style: { background: '#8b8b8b', textShadow: '1px 1px 0 #333', marginTop: '6px' },
        onClick: () => setCraftOpen(false),
      }, '关闭'),
    ),
  )

  return React.createElement('div', { className: 'dsm-root' },
    React.createElement('div', { className: 'dsm-win' },
      React.createElement('div', { className: 'dsm-head' },
        React.createElement('span', { className: 'dsm-headtitle' },
          icon(tex.pickaxe, '⛏', 14), 'MC 采集小游戏'),
        React.createElement('button', { className: 'dsm-x', onClick: props.onClose, title: '关闭' }, '×'),
      ),
      scene,
      hotbar,
      craftModal,
    ),
  )
}

/**
 * 面板宿主壳：异步取回预设与食物表后渲染真正的面板。
 *
 * 为什么要有这一层：预设数值与食物表由宿主 RPC 提供，而 hooks 只能写在组件里，
 * 不能在 apply() 里调用。取表失败时返回 null——宁可不出面板，也不出一个
 * 连喂食按钮都没有的半截 UI。
 *
 * @param props service（状态适配器）与 call（connection.rpc.call 绑定版）。
 */
function SurvivalPanelHost(props) {
  const [meta, setMeta] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    void invokeMeta(props.call).then((value) => {
      if (!alive || value === null || typeof value !== 'object') return
      setMeta({
        presets: Array.isArray(value.presets) ? value.presets : [],
        foods: Array.isArray(value.foods) ? value.foods : [],
        game: value.game !== null && typeof value.game === 'object' ? value.game : null,
        recipes: value.recipes !== null && typeof value.recipes === 'object' ? value.recipes : {},
      })
    })
    return () => {
      alive = false
    }
  }, [props.call])

  if (meta === null) return null
  return React.createElement(SurvivalPanel, {
    service: props.service,
    presets: meta.presets,
    foods: meta.foods,
    game: meta.game,
    recipes: meta.recipes,
  })
}

/**
 * 生存模式面板组件。
 * @param props 由 client 传入的运行时依赖。
 */
function SurvivalPanel(props) {
  const service = props.service
  const [snapshot, setSnapshot] = React.useState(() => service.snapshot())
  const [busy, setBusy] = React.useState(false)
  const [open, setOpen] = React.useState(true)
  const [gameOpen, setGameOpen] = React.useState(false)
  const [showConfig, setShowConfig] = React.useState(false)
  const [form, setForm] = React.useState(null)
  const [toast, setToast] = React.useState('')
  const [position, setPosition] = React.useState(null)
  const drag = React.useRef(null)

  React.useEffect(() => {
    let alive = true
    const pull = () => {
      if (!alive) return
      setSnapshot(service.snapshot())
    }
    pull()
    const timer = setInterval(pull, POLL_MS)
    const off = service.onChange(pull)
    return () => {
      alive = false
      clearInterval(timer)
      off()
    }
  }, [service])

  React.useEffect(() => {
    if (toast === '') return undefined
    const timer = setTimeout(() => setToast(''), 2800)
    return () => clearTimeout(timer)
  }, [toast])

  /**
   * 把一次异步操作结果合并进面板状态。
   *
   * RPC 是异步的，而 service.snapshot() 读的是适配器里的本地缓存——写操作完成后
   * 缓存已被刷新，所以这里同步重读即可拿到新值。失败时用 toast 说明原因，
   * 绝不抛出（面板不该因一次 RPC 失败而崩掉）。
   *
   * @param run 返回 Promise 的操作。
   */
  async function settle(run) {
    try {
      const result = await run
      if (result !== null && result !== undefined && typeof result.message === 'string') {
        setToast(result.message)
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error))
    } finally {
      setSnapshot(service.snapshot())
    }
  }

  function doFeed(food) {
    if (busy) return
    setBusy(true)
    void settle(service.feed(food)).finally(() => setBusy(false))
  }

  function choosePreset(id) {
    if (busy) return
    setBusy(true)
    void settle(service.preset(id)).finally(() => setBusy(false))
  }

  function saveConfig() {
    if (form === null) return
    void settle(service.configure({
      hungerPerStep: Number(form.step),
      maxHunger: Number(form.hunger),
      maxHealth: Number(form.health),
      tickSeconds: Number(form.tick),
    }))
  }

  function onPointerDown(event) {
    if (event.target !== null && event.target !== undefined && event.target.tagName === 'BUTTON') return
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    drag.current = { x: event.clientX, y: event.clientY, base: position }
  }

  function onPointerMove(event) {
    const info = drag.current
    if (info === null || info === undefined) return
    const base = info.base === null || info.base === undefined
      ? { left: window.innerWidth - 306, top: window.innerHeight - 330 }
      : info.base
    setPosition({
      left: base.left + (event.clientX - info.x),
      top: base.top + (event.clientY - info.y),
    })
  }

  function onPointerUp() {
    drag.current = null
  }

  const dead = snapshot.dead === true
  const starving = snapshot.starving === true
  const dotColor = dead ? COLOR.dead : (starving ? COLOR.warn : (snapshot.critical ? COLOR.warn : COLOR.ok))
  const cardStyle = position === null
    ? {}
    : { position: 'fixed', right: 'auto', bottom: 'auto', left: position.left + 'px', top: position.top + 'px' }

  if (!open) {
    return React.createElement('div', {
      className: 'dsv-badge',
      onClick: () => setOpen(true),
      title: '展开生存模式面板',
    },
      React.createElement('span', { className: 'dsv-dot', style: { background: dotColor, color: dotColor } }),
      React.createElement('span', null,
        icon(TEX.foodFull, '🍖', 12), ' ' + String(snapshot.hunger), ' · ',
        icon(TEX.heart, '❤', 12), ' ' + String(snapshot.health)),
    )
  }

  const head = React.createElement('div', {
    className: 'dsv-head',
    onPointerDown: onPointerDown,
    onPointerMove: onPointerMove,
    onPointerUp: onPointerUp,
    onPointerCancel: onPointerUp,
  },
    React.createElement('span', { className: 'dsv-dot', style: { background: dotColor, color: dotColor } }),
    React.createElement('span', { className: 'dsv-title' }, dead ? '生存模式 · 已饿死（工具已冻结）' : '生存模式'),
    React.createElement('button', {
      className: 'dsv-ico',
      title: '自定义数值',
      onClick: () => {
        if (!showConfig && form === null) {
          setForm({
            step: String(snapshot.hungerPerStep),
            hunger: String(snapshot.maxHunger),
            health: String(snapshot.maxHealth),
            tick: String(snapshot.tickSeconds),
          })
        }
        setShowConfig((previous) => !previous)
      },
    }, '⚙'),
    React.createElement('button', { className: 'dsv-ico', onClick: () => setOpen(false), title: '收起为小挂件' }, '▾'),
  )

  const modes = React.createElement('div', { className: 'dsv-modes' },
    props.presets.map((preset) => React.createElement('button', {
      key: preset.id,
      className: 'dsv-mode' + (snapshot.preset === preset.id ? ' dsv-active' : ''),
      disabled: busy,
      title: '切换到' + preset.label + '模式（同时套用该模式的扣除速率、上限与掉血节奏）',
      onClick: () => choosePreset(preset.id),
    }, preset.label)),
  )

  const configRow = (label, value, field) => React.createElement('div', { className: 'dsv-cfgrow' },
    React.createElement('span', null, label),
    React.createElement('input', {
      type: 'number',
      value,
      onChange: (event) => setForm({ ...form, [field]: event.target.value }),
    }),
  )

  const config = showConfig && form !== null
    ? React.createElement('div', { className: 'dsv-cfg' },
        configRow('每步思考扣除', form.step, 'step'),
        configRow('饱食度上限', form.hunger, 'hunger'),
        configRow('生命上限', form.health, 'health'),
        configRow('掉血间隔（秒）', form.tick, 'tick'),
        React.createElement('div', { className: 'dsv-cfgrow' },
          React.createElement('span', null, ''),
          React.createElement('button', { className: 'dsv-btn dsv-primary', onClick: saveConfig }, '保存数值'),
        ),
      )
    : null

  // 喂食门槛（改动前先读）：
  // - 苹果/面包：只要**没饱**（饱食度 < 上限）且背包有货就能喂；只有满饱食度才禁用，
  //   因为满着吃是纯浪费。曾用「≥2 步余量就禁用」的防误喂门槛，实测症状是
  //   饱食度 60/150 时苹果面包按钮全灰、点了没反应，用户判断为"苹果和面包用不了"——
  //   防误喂的收益抵不过这个困惑，改成只在满饱食度时禁用。
  // - 金苹果：饱食度满时仍可点（它带 +生命，是应急选项）；饿死时它是**唯一**复活手段，
  //   苹果/面包在死后一律禁用（宿主侧 state.feed 也会拒绝）。
  // - 背包没有存货一律禁用——喂食从背包消耗，没货喂不了。
  const stomachFull = snapshot.hunger >= snapshot.maxHunger

  const game = !gameOpen ? null : React.createElement(McGame, {
    service,
    snapshot,
    recipes: props.recipes,
    onClose: () => setGameOpen(false),
  })

  return React.createElement('div', { className: 'dsv-root', style: cardStyle },
    React.createElement('div', { className: 'dsv-card' + (dead ? ' dsv-dead' : '') },
      head,
      modes,
      React.createElement('div', { className: 'dsv-row' },
        React.createElement('span', null, icon(TEX.foodFull, '🍖', 12), ' 饱食度'),
        React.createElement('span', null, String(snapshot.hunger) + ' / ' + String(snapshot.maxHunger)),
      ),
      bar(snapshot.hungerPercent, COLOR.hunger, COLOR.hungerLow),
      React.createElement('div', { className: 'dsv-row' },
        React.createElement('span', { className: 'dsv-hp' }, icon(TEX.heart, '❤', 12), ' 生命'),
        React.createElement('span', { className: 'dsv-hp' }, String(snapshot.health) + ' / ' + String(snapshot.maxHealth)),
      ),
      bar(snapshot.healthPercent, COLOR.hp, COLOR.hpLow),
      React.createElement('div', { className: 'dsv-actions' },
        props.foods.map((food) => {
          const count = invCount(snapshot, food.key)
          // 原版食物贴图（苹果/面包/金苹果）走跟热键栏同一张表，按钮不再用 emoji。
          const foodView = ITEM_VIEW[food.key]
          // 复活食物由宿主快照显式给出（reviveFood），不靠"食物表最后一项"的位置假设。
          const isReviveItem = food.key === (snapshot.reviveFood ?? 'golden_apple')
          const blocked = busy || count <= 0
            || (isReviveItem ? false : (dead || stomachFull))
          const reason = count <= 0
            ? '背包里没有' + food.label + '，去 MC 小游戏里采集或合成'
            : (dead && !isReviveItem
              ? '你已饿死：只有金苹果能复活，先喂它'
              : (stomachFull && !isReviveItem
                ? '饱食度已满，再喂' + food.label + '是浪费——留到饿了再喂'
                : '喂食 1 个' + food.label))
          return React.createElement('button', {
            key: food.key,
            className: 'dsv-btn' + (isReviveItem ? ' dsv-primary' : ''),
            disabled: blocked,
            title: reason,
            onClick: () => doFeed(food.key),
          },
            React.createElement('span', null,
              icon(foodView === undefined ? undefined : foodView.icon, food.emoji, 14),
              isReviveItem && dead ? ' 复活' : ' ' + food.label),
            React.createElement('small', null,
              '+' + String(food.hunger),
              food.hp > 0
                ? React.createElement('span', null, ' +' + String(food.hp), icon(TEX.heart, '❤', 10))
                : null),
            React.createElement('small', { className: 'dsv-own' }, '已有 × ' + String(count)),
          )
        }),
      ),
      React.createElement('button', {
        className: 'dsv-btn dsv-game',
        onClick: () => setGameOpen(!gameOpen),
      }, icon(TEX.pickaxe, '⛏', 14),
        gameOpen ? ' 收起 MC 采集小游戏' : ' 打开 MC 采集小游戏（获取食物）'),
      dead
        ? React.createElement('div', { className: 'dsv-alert' },
            '已饿死：工具已冻结，但对话仍然通畅。只有金苹果能复活（+'
            + String(snapshot.reviveHunger) + ' 饱食 / +' + String(snapshot.reviveHp)
            + ' 生命）；苹果和面包在饿死状态下无效。')
        : null,
      starving
        ? React.createElement('div', { className: 'dsv-alert' },
            '饱食度归零：每 ' + String(snapshot.tickSeconds) + ' 秒 -'
            + String(snapshot.hpLossPerTick) + ' 生命'
            + (snapshot.secondsToDeath === null ? '' : '，约 ' + String(snapshot.secondsToDeath) + ' 秒后死亡') + '。')
        : null,
      React.createElement('div', { className: 'dsv-deaths' },
        icon(TEX.skull, '☠', 12), ' 饿死次数  ' + String(snapshot.deathCount)),
      toast === '' ? null : React.createElement('div', { className: 'dsv-note' }, toast),
      React.createElement('div', { className: 'dsv-note' },
        '每步 -' + String(snapshot.hungerPerStep) + ' 饱食 · 掉血 '
        + String(snapshot.tickSeconds) + 's/' + String(snapshot.hpLossPerTick),
        icon(TEX.heart, '❤', 10),
        ' · 累计思考 '
        + String(snapshot.stepCount) + ' 步 · 喂食 ' + String(snapshot.feedCount) + ' 次'
        + (snapshot.rescueCount > 0 ? ' · 抢救 ' + String(snapshot.rescueCount) + ' 次' : '')),
      config,
      React.createElement('div', { className: 'dsv-foot' },
        React.createElement('span', null, '拖动标题栏可移动'),
        React.createElement('button', {
          className: 'dsv-reset',
          onClick: () => settle(service.reset()),
        }, '重置状态'),
      ),
    ),
    // MC 采集小游戏窗口：fixed 定位在左下角，与面板互不影响。
    // 收起面板（badge 态）会一起把它卸载。
    game,
  )
}

/**
 * 客户端插件：把面板挂到 shell.overlay 上。
 *
 * 关键：面板跑在**浏览器**里的 cordis 实例，宿主用 `ctx.provide('survivalState')`
 * 注册的服务在这里永远取不到——两者之间没有自动通道。数据必须经
 * `connection.rpc.call` 跨进程取，封装见 bridge 中的 createClientService。
 *
 * `slots` 是硬依赖。`connection` 走 ctx.inject 延迟注入：它在 apply() 执行时
 * 可能还没就绪，直接 `ctx.connection` 会抛 `cannot get property … without inject`。
 */
export default {
  name: 'dsh-survival-mode/client',
  inject: ['slots'],
  apply(ctx) {
    const disposeStyles = injectStyles()
    ctx.effect(() => disposeStyles)

    ctx.inject(['connection'], (injected) => {
      const rpc = injected.get('connection')?.rpc
      const raw = rpc !== undefined && rpc !== null ? rpc.call : undefined
      if (typeof raw !== 'function') return
      const call = raw.bind(rpc)

      const service = withMutations(createClientService({
        call: (channel, endpoint, payload) => call(channel, endpoint, payload),
        fallback: FALLBACK_SNAPSHOT,
      }))

      // 先拉一次让面板立刻有数据，再按固定间隔保持同步。
      void service.refresh()
      // 用浏览器全局定时器，不走 ctx.setInterval：这里只声明了 connection，
      // 客户端 timer 服务需要额外 inject: ['timer']，漏声明会在取值时直接抛错。
      const timer = globalThis.setInterval(() => {
        void service.refresh()
      }, RPC_POLL_MS)
      injected.effect(() => () => globalThis.clearInterval(timer))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-survival-mode', order: 40, label: '生存模式' },
        // 预设与食物表由宿主提供（数值只有宿主一份真值），因此这里挂一个薄壳组件
        // 在内部异步取一次——hooks 只能在组件里用，不能在 apply() 里调。
        () => React.createElement(SurvivalPanelHost, { service, call }),
      ))
    })
  },
}
