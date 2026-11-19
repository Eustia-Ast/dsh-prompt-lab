/**
 * Turn a failed prompt assembly into a short, user-facing attribution.
 *
 * This is diagnostic only: it never decides whether the error is "safe" and
 * never disables a plugin. It classifies the stack frame so the panel can show
 * a likely owner without hard-coding a third-party package/version table.
 */

function firstFrame (stack) {
  const lines = String(stack ?? '').split(/\r?\n/)
  const frames = lines.filter((line) => /^\s*at\s+/.test(line))
  if (frames.length === 0) return null
  // Prefer an application/plugin frame over Node internals and async wrappers.
  return frames.find((line) => /(?:node_modules|[\\/]dsh-prompt-lab[\\/]|app\.asar)/i.test(line)) ?? frames[0]
}

function packageFromFrame (frame) {
  if (typeof frame !== 'string') return null
  const match = frame.replace(/\\/g, '/').match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  return match?.[1] ?? null
}

export function diagnoseProbeError (error) {
  const message = String(error?.message ?? error ?? '')
  const stack = String(error?.stack ?? '')
  const frame = firstFrame(stack)
  const normalized = (frame ?? '').replace(/\\/g, '/').toLowerCase()
  const pkg = packageFromFrame(frame)
  let source = 'unknown'
  let packageName = null
  let hint = '无法确定错误来源。错误发生在装配阶段。'

  if (normalized.includes('dsh-prompt-lab')) {
    source = 'prompt-lab'
    packageName = 'dsh-prompt-lab'
    hint = '错误来自 Prompt Lab 自身的装配探测。请保留技术细节反馈。'
  } else if (normalized.includes('app.asar') || /\/node_modules\/@deepseek-ai\//.test(normalized)) {
    source = 'dsh'
    packageName = pkg?.startsWith('@deepseek-ai/') ? pkg : null
    hint = '错误来自 DSH 内置装配。检查 DSH 版本/重装，或临时禁用最近更新的插件后重试。'
  } else if (pkg !== null) {
    source = 'plugin'
    packageName = pkg
    hint = `错误来自第三方插件 ${pkg} 的装配代码。请更新该插件，或临时禁用后重试。`
  }

  const technical = `${message}${stack ? `\n${stack}` : ''}`.slice(0, 5000)
  return {
    source,
    package: packageName,
    hint,
    frame: frame === null ? null : frame.trim(),
    detail: technical
  }
}
