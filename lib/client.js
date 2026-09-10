window.__ModuleLoader__.load({
  id: "dsh-survival-mode",
  factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
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
].join('\n')

/** 面板刷新间隔：状态变化只由服务通知驱动会漏掉掉血 tick，轮询最稳。 */
const POLL_MS = 700

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

/**
 * 生存模式面板组件。
 * @param props 由 client 传入的运行时依赖。
 */
function SurvivalPanel(props) {
  const service = props.service
  const [snapshot, setSnapshot] = React.useState(() => service.snapshot())
  const [busy, setBusy] = React.useState(false)
  const [open, setOpen] = React.useState(true)
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

  /** 把一次操作结果合并进面板状态。 */
  function settle(result) {
    if (result === null || result === undefined) return
    setSnapshot(service.snapshot())
    if (typeof result.message === 'string') setToast(result.message)
  }

  function doFeed(food) {
    if (busy) return
    setBusy(true)
    try {
      settle(service.feed(food))
    } finally {
      setBusy(false)
    }
  }

  function choosePreset(id) {
    if (busy) return
    setBusy(true)
    try {
      settle(service.preset(id))
    } finally {
      setBusy(false)
    }
  }

  function saveConfig() {
    if (form === null) return
    settle(service.configure({
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
      React.createElement('span', null, '🍖 ' + String(snapshot.hunger) + ' · ❤ ' + String(snapshot.health)),
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

  // 饱食度充足时禁用（≥2 步余量），防误喂；金胡萝卜始终可点，它是应急与复活选项。
  const enough = !dead && snapshot.hunger >= snapshot.hungerPerStep * 2

  return React.createElement('div', { className: 'dsv-root', style: cardStyle },
    React.createElement('div', { className: 'dsv-card' + (dead ? ' dsv-dead' : '') },
      head,
      modes,
      React.createElement('div', { className: 'dsv-row' },
        React.createElement('span', null, '🍖 饱食度'),
        React.createElement('span', null, String(snapshot.hunger) + ' / ' + String(snapshot.maxHunger)),
      ),
      bar(snapshot.hungerPercent, COLOR.hunger, COLOR.hungerLow),
      React.createElement('div', { className: 'dsv-row' },
        React.createElement('span', { className: 'dsv-hp' }, '❤ 生命'),
        React.createElement('span', { className: 'dsv-hp' }, String(snapshot.health) + ' / ' + String(snapshot.maxHealth)),
      ),
      bar(snapshot.healthPercent, COLOR.hp, COLOR.hpLow),
      React.createElement('div', { className: 'dsv-actions' },
        props.foods.map((food, index) => React.createElement('button', {
          key: food.key,
          className: 'dsv-btn' + (index === props.foods.length - 1 ? ' dsv-primary' : ''),
          disabled: busy || (index !== props.foods.length - 1 && enough),
          onClick: () => doFeed(food.key),
        },
          React.createElement('span', null,
            index === props.foods.length - 1 && dead
              ? food.emoji + ' 复活'
              : food.emoji + ' ' + food.label),
          React.createElement('small', null,
            '+' + String(food.hunger) + (food.hp > 0 ? ' +' + String(food.hp) + '❤' : '')),
        )),
      ),
      dead
        ? React.createElement('div', { className: 'dsv-alert' },
            '已饿死：工具已冻结，但对话仍然通畅。喂食即可复活（+'
            + String(snapshot.reviveHunger) + ' 饱食 / +' + String(snapshot.reviveHp) + ' 生命）。')
        : null,
      starving
        ? React.createElement('div', { className: 'dsv-alert' },
            '饱食度归零：每 ' + String(snapshot.tickSeconds) + ' 秒 -'
            + String(snapshot.hpLossPerTick) + ' 生命'
            + (snapshot.secondsToDeath === null ? '' : '，约 ' + String(snapshot.secondsToDeath) + ' 秒后死亡') + '。')
        : null,
      React.createElement('div', { className: 'dsv-deaths' }, '☠ 饿死次数  ' + String(snapshot.deathCount)),
      toast === '' ? null : React.createElement('div', { className: 'dsv-note' }, toast),
      React.createElement('div', { className: 'dsv-note' },
        '每步 -' + String(snapshot.hungerPerStep) + ' 饱食 · 掉血 '
        + String(snapshot.tickSeconds) + 's/' + String(snapshot.hpLossPerTick) + ' ❤ · 累计思考 '
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
  )
}

/**
 * 客户端插件：把面板挂到 shell.overlay 上。
 *
 * `slots` 是硬依赖：它在槽声明期做等待，声明就绪后再注册，因此必须 inject。
 */
module.exports = {
  name: 'dsh-survival-mode/client',
  inject: ['slots'],
  apply(ctx) {
    const disposeStyles = injectStyles()
    ctx.effect(() => disposeStyles)

    // survival 服务由本插件的 Host 半体 provide；取不到就静默退出，不让页面报错。
    const service = ctx.get('survivalState')
    if (service === undefined || service === null) return
    const presets = ctx.get('survivalStateMeta') ?? { presets: [], foods: [] }

    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-survival-mode', order: 40, label: '生存模式' },
      () => React.createElement(SurvivalPanel, {
        service,
        presets: presets.presets ?? [],
        foods: presets.foods ?? [],
      }),
    ))
  },
}

return module.exports;
  },
});
