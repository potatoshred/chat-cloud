/**
 * 跨设备同步的统一节拍：每 30 秒刷新一次；页面静置 5 分钟或切到后台就暂停。
 * 有交互或切回窗口时立即同步一次并恢复计时。
 */
const INTERVAL = 30_000
const IDLE_TIMEOUT = 5 * 60_000

const subscribers = new Set<() => void>()
let timer: number | undefined
let idleTimer: number | undefined
let started = false

const runAll = () => {
  for (const run of subscribers) {
    try {
      run()
    } catch {
      // 单个模块的同步失败不影响其他模块。
    }
  }
}
const stopTimer = () => {
  if (timer !== undefined) {
    window.clearInterval(timer)
    timer = undefined
  }
}
const stop = () => {
  stopTimer()
  if (idleTimer !== undefined) {
    window.clearTimeout(idleTimer)
    idleTimer = undefined
  }
}
const scheduleIdle = () => {
  if (idleTimer !== undefined) {
    window.clearTimeout(idleTimer)
  }
  idleTimer = window.setTimeout(() => {
    idleTimer = undefined
    stopTimer()
  }, IDLE_TIMEOUT)
}
/** 从空闲/后台恢复：先立刻同步，再重新开始计时。 */
const wake = () => {
  if (document.visibilityState === 'hidden') {
    return
  }
  scheduleIdle()
  if (timer === undefined) {
    runAll()
    timer = window.setInterval(runAll, INTERVAL)
  }
}
const bind = () => {
  for (const type of ['pointerdown', 'keydown', 'wheel', 'scroll'] as const) {
    window.addEventListener(type, wake, { passive: true })
  }
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stop()
    } else {
      wake()
    }
  })
}

/** 注册一个同步回调；返回值用于在组件卸载时注销。 */
export const subscribeSync = (run: () => void) => {
  subscribers.add(run)
  if (!started) {
    started = true
    bind()
    scheduleIdle()
    timer = window.setInterval(runAll, INTERVAL)
  }
  return () => {
    subscribers.delete(run)
  }
}
