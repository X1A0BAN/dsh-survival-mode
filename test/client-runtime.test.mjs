/**
 * 客户端 bundle 的运行时冒烟测试。
 *
 * 为什么必须有这一层：scripts/build.mjs 只做**语法**检查，而客户端 bundle 在
 * 浏览器里才第一次执行。任何拼错的符号（withMutations / FALLBACK_SNAPSHOT /
 * SurvivalPanelHost …）或对模块表契约的误用，语法检查都发现不了，
 * 症状是面板静默不出现——正是我们已经踩过两次的坑。
 *
 * 这里用最小的 __ModuleLoader__ 与 document 替身，真实执行 lib/client.js，
 * 再把插件 apply() 跑起来，断言它确实往 shell.overlay 注册了内容。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/**
 * 最小但有状态的 React 替身。
 *
 * `useState` 必须真的保存值并在 setter 被调用后重渲染，`useEffect` 必须真的执行
 * ——否则测试看不到"meta 异步到达后面板才出现"这条关键路径，而那正是面板
 * 会不会出现的地方。
 *
 * @param onRerender setter 触发时的回调，用于立刻重渲染。
 * @returns React 替身。
 */
function createReactStub(onRerender) {
  const hooks = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = hooks[index]
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
          if (onRerender !== undefined) onRerender()
        },
      ]
    },
    useEffect(fn) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        hooks[index] = { ran: true }
        fn()
      }
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    __resetCursor: () => {
      cursor = 0
    },
  }
  return React
}

/**
 * 在隔离上下文里加载客户端 bundle 并取出插件对象。
 *
 * @returns 插件对象、React 替身与模块 id。
 */
async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const React = createReactStub()
  // renderTree 在重渲染前需要重置 hook 游标，把替身挂到 global 供它使用。
  globalThis.__testReact = React
  let registered = null
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({
      dataset: {},
      _text: '',
      set textContent(value) {
        this._text = value
      },
      get textContent() {
        return this._text
      },
    }),
    head: { appendChild: () => {} },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => {
          registered = entry
        },
      },
      innerWidth: 1200,
      innerHeight: 800,
    },
    document: documentStub,
    console,
    setInterval: () => () => {},
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  sandbox.window.document = documentStub
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  assert.ok(registered !== null, 'bundle 应调用 window.__ModuleLoader__.load')
  assert.equal(typeof registered.factory, 'function', 'load 应收到 factory')
  const moduleExports = registered.factory((specifier) => {
    assert.equal(specifier, 'react', '客户端只允许 require("react")，实际请求了 ' + specifier)
    return React
  })
  return { plugin: moduleExports, id: registered.id }
}

test('客户端 bundle 能被模块系统加载并导出插件对象', async () => {
  const { plugin, id } = await loadClient()
  assert.equal(id, 'dsh-survival-mode')
  assert.ok(plugin !== null && typeof plugin === 'object', '应导出插件对象')
  assert.equal(plugin.name, 'dsh-survival-mode/client')
  // 注意：bundle 跑在 vm 的另一个 realm 里，其数组原型与本 realm 不同，
  // 因此不能用 deepEqual 比较，只能逐项断言。
  assert.equal(plugin.inject.length, 1, 'slots 是唯一硬依赖')
  assert.equal(plugin.inject[0], 'slots')
  assert.equal(typeof plugin.apply, 'function')
})

test('apply() 拿到 connection 后会把面板注册到 shell.overlay', async () => {
  const { plugin } = await loadClient()
  const slots = { registrations: [] }
  const rpcCalls = []
  const injectedCallbacks = []

  const ctx = {
    effect: () => {},
    // 客户端插件用 ctx.inject 延迟等 connection；这里同步回调即可。
    inject: (names, callback) => {
      injectedCallbacks.push(names)
      callback({ get: (name) => (name === 'connection' ? { rpc: { call: async (...args) => { rpcCalls.push(args); return { ok: true, value: { hunger: 7 } } } } } : undefined),
        effect: () => {},
        setInterval: () => () => {},
      })
    },
    slots: {
      inject: (name, callback) => {
        slots.registrations.push(name)
        callback()
      },
      register: (spec, render) => {
        slots.spec = spec
        slots.render = render
        return () => {}
      },
    },
  }

  plugin.apply(ctx)

  assert.equal(injectedCallbacks.length, 1, '应延迟注入一次 connection')
  assert.equal(injectedCallbacks[0].length, 1)
  assert.equal(injectedCallbacks[0][0], 'connection')
  assert.equal(slots.spec.id, 'dsh-survival-mode')
  assert.equal(slots.spec.name, 'shell.overlay', '必须注册到 shell.overlay 槽')
  assert.equal(typeof slots.render, 'function')

  // 渲染一次：这一步会在运行时求值所有客户端符号，拼错的标识符会在此暴露。
  const tree = slots.render()
  assert.ok(tree !== null && tree !== undefined, 'slot 渲染不应返回空')

  // 首帧：meta 还没回来，宿主壳按设计返回 null（宁可不出面板，也不出半截 UI）。
  const before = renderTree(tree)
  assert.equal(before, null, 'meta 未到达时不应渲染半截面板')

  // 等 meta 的异步到达，然后重渲染——这一步会真正求值 <SurvivalPanel>。
  await new Promise((resolve) => setTimeout(resolve, 30))
  const after = renderTree(tree)
  assert.ok(after !== null && after !== undefined, 'meta 到达后应渲染出面板')
  assert.equal(after.type, 'div', '面板根应是 div')

  assert.ok(rpcCalls.length >= 1, '应至少发过一次 RPC（refresh 或 meta）')
  for (const [channel, endpoint] of rpcCalls) {
    assert.equal(channel, '/dsh-survival-mode', 'channel 必须与宿主一致')
    assert.equal(typeof endpoint, 'string')
  }
})

/**
 * 反复渲染元素树，直到末端不再是函数组件。
 *
 * 每次迭代前重置 hook 游标，让替身的行为接近真实 React 的每次渲染。
 *
 * @param node 元素或任意值。
 * @returns 渲染链末端的值。
 */
function renderTree(node) {
  const React = globalThis.__testReact
  let current = node
  for (let depth = 0; depth < 12; depth += 1) {
    if (current === null || typeof current !== 'object' || typeof current.type !== 'function') return current
    if (React !== undefined && typeof React.__resetCursor === 'function') {
      React.__resetCursor()
      // 清掉已执行标记，让 useEffect 在重渲染时再次有机会执行。
    }
    current = current.type(current.props)
  }
  return current
}
