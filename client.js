/**
 * Prompt Lab — Client half.
 *
 * Entry: a pill in the composer's bottom row (`conversation.input.left`),
 * which renders in both the empty-session hero layout and a live conversation.
 * The editor itself is a right-sidebar tab, with a full-screen overlay as a
 * fallback when the sidebar services are unavailable.
 *
 * The panel is narrow by design: every layout below is stacked, never
 * side-by-side, and all copy is written for a side panel.
 *
 * All reads and writes go through `POST /prompt-lab/api` on the same origin.
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-lab',
  factory (require) {
    const React = require('react')
    let ReactDOM
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = undefined
    }
    const FONT_SCALE_KEY = 'prompt-lab:font-scale'
    const FONT_SCALES = [1, 1.1, 1.25, 1.4]
    function readFontScale () {
      try {
        const raw = Number(window.localStorage?.getItem(FONT_SCALE_KEY))
        return FONT_SCALES.includes(raw) ? raw : 1
      } catch {
        return 1
      }
    }
    let fontScale = readFontScale()
    function scaleFontValue (value) {
      if (typeof value === 'number') return value * fontScale
      if (typeof value !== 'string' || fontScale === 1) return value
      return value.replace(/(\d+(?:\.\d+)?)px/g, (_, px) => `${Number(px) * fontScale}px`)
    }
    function scaleFontStyle (style) {
      if (!style || fontScale === 1) return style
      const next = { ...style }
      if (next.fontSize !== undefined) next.fontSize = scaleFontValue(next.fontSize)
      if (next.font !== undefined) next.font = scaleFontValue(next.font)
      if (typeof next.lineHeight === 'string' && next.lineHeight.endsWith('px')) {
        next.lineHeight = scaleFontValue(next.lineHeight)
      }
      return next
    }
    function applyFontScale (value) {
      fontScale = FONT_SCALES.includes(value) ? value : 1
      try {
        window.localStorage?.setItem(FONT_SCALE_KEY, String(fontScale))
      } catch {
        /* preference only */
      }
      try {
        window.dispatchEvent(new CustomEvent('prompt-lab:font-scale', { detail: { scale: fontScale } }))
      } catch {
        /* UI-only notification */
      }
    }
    const h = (type, props, ...children) => React.createElement(
      type,
      props && props.style ? { ...props, style: scaleFontStyle(props.style) } : props,
      ...children
    )
    const { useState, useEffect, useMemo, useCallback } = React

    const API = '/prompt-lab/api'

    // ---------------------------------------------------------------- store
    function createUiStore () {
      let state = { open: null }
      const listeners = new Set()
      return {
        get: () => state,
        subscribe (listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        patch (next) {
          state = { ...state, ...next }
          for (const listener of listeners) listener()
        }
      }
    }
    const ui = createUiStore()

    function useUi () {
      const [value, setValue] = useState(ui.get())
      useEffect(() => ui.subscribe(() => setValue(ui.get())), [])
      return value
    }

    const notifyStateChanged = (detail) => {
      try {
        window.dispatchEvent(new CustomEvent('prompt-lab:state-changed', { detail }))
      } catch {
        /* UI-only notification */
      }
    }

    // ------------------------------------------------------------------ rpc
    async function call (op, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...payload })
      })
      const raw = await response.text()
      let json
      try {
        json = JSON.parse(raw)
      } catch {
        throw new Error(`bad response (${response.status})`)
      }
      if (json.ok !== true) throw new Error(json.error || 'request failed')
      return json.value
    }

    // ----------------------------------------------------------------- utils
    const DARK_PALETTE = {
      bg: '#16161b',
      bgSoft: '#1d1d24',
      bgField: '#111116',
      line: 'rgba(255,255,255,0.10)',
      text: '#e9e9ef',
      dim: '#9c9caa',
      faint: '#6f6f7e',
      accent: '#6f8dff',
      ok: '#4ec9a5',
      warn: '#e2b25a',
      danger: '#ef6f6f',
      soft: 'rgba(255,255,255,0.05)',
      chip: 'rgba(255,255,255,0.06)',
      accentSoft: 'rgba(111,141,255,0.12)',
      warnSoft: 'rgba(226,178,90,0.10)',
      dangerSoft: 'rgba(239,111,111,0.12)',
      okSoft: 'rgba(78,201,165,0.12)',
      dangerLine: 'rgba(239,111,111,0.40)',
      overlay: 'rgba(0,0,0,0.50)',
      modalOverlay: 'rgba(0,0,0,0.55)',
      shadow: '0 24px 80px rgba(0,0,0,0.55)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    }

    const LIGHT_PALETTE = {
      bg: '#ffffff',
      bgSoft: '#f4f6f9',
      bgField: '#eef1f5',
      line: 'rgba(22,28,45,0.14)',
      text: '#1c202b',
      dim: '#5b6270',
      faint: '#7c8493',
      accent: '#4d6bfe',
      ok: '#168a66',
      warn: '#9a6500',
      danger: '#c24141',
      soft: 'rgba(22,28,45,0.04)',
      chip: 'rgba(22,28,45,0.06)',
      accentSoft: 'rgba(77,107,254,0.10)',
      warnSoft: 'rgba(154,101,0,0.10)',
      dangerSoft: 'rgba(194,65,65,0.10)',
      okSoft: 'rgba(22,138,102,0.10)',
      dangerLine: 'rgba(194,65,65,0.35)',
      overlay: 'rgba(22,28,45,0.28)',
      modalOverlay: 'rgba(22,28,45,0.32)',
      shadow: '0 24px 80px rgba(22,28,45,0.18)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    }

    let colorScheme = 'dark'
    let PALETTE = DARK_PALETTE

    function makeCss (palette) {
      const PALETTE = palette
      return {
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: PALETTE.overlay,
        padding: '24px',
        boxSizing: 'border-box'
      },
      panel: {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: 'min(880px, 96vw)',
        height: 'min(820px, 90vh)',
        background: PALETTE.bg,
        color: PALETTE.text,
        border: `1px solid ${PALETTE.line}`,
        borderRadius: '14px',
        boxShadow: PALETTE.shadow,
        overflow: 'hidden',
        font: '13px/1.6 "Segoe UI", system-ui, sans-serif'
      },
      paneShell: {
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        minHeight: 0,
        background: PALETTE.bg,
        color: PALETTE.text,
        font: '13px/1.6 "Segoe UI", system-ui, sans-serif',
        overflow: 'hidden'
      },
      header: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '12px 14px 10px',
        borderBottom: `1px solid ${PALETTE.line}`,
        background: PALETTE.bgSoft
      },
      headerRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '14px', fontWeight: 600, letterSpacing: '0.2px' },
      tag: {
        fontSize: '11px',
        color: PALETTE.dim,
        fontFamily: PALETTE.mono,
        background: PALETTE.chip,
        padding: '1px 7px',
        borderRadius: '999px'
      },
      segmented: {
        display: 'inline-flex',
        border: `1px solid ${PALETTE.line}`,
        borderRadius: '8px',
        overflow: 'hidden'
      },
      segment: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: PALETTE.dim,
        padding: '4px 10px',
        cursor: 'pointer',
        fontSize: '12px'
      },
      segmentOn: { background: PALETTE.accentSoft, color: PALETTE.text },
      tabs: { display: 'flex', gap: '2px', padding: '6px 10px 0', flexWrap: 'wrap' },
      tab: {
        appearance: 'none',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'transparent',
        borderBottomColor: 'transparent',
        background: 'transparent',
        color: PALETTE.dim,
        padding: '6px 10px',
        borderRadius: '8px 8px 0 0',
        cursor: 'pointer',
        fontSize: '12.5px'
      },
      tabActive: {
        color: PALETTE.text,
        background: PALETTE.bgSoft,
        borderColor: PALETTE.line,
        borderBottomColor: PALETTE.bgSoft
      },
      body: { flex: 1, overflow: 'auto', padding: '12px', background: PALETTE.bgSoft, minHeight: 0 },
      card: {
        border: `1px solid ${PALETTE.line}`,
        borderRadius: '10px',
        background: PALETTE.bg,
        marginBottom: '8px',
        overflow: 'hidden'
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: '6px', padding: '9px 10px', flexWrap: 'wrap' },
      name: { fontFamily: PALETTE.mono, fontSize: '12px', flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      desc: { color: PALETTE.faint, fontSize: '11.5px', lineHeight: 1.5, padding: '0 10px 8px' },
      badge: {
        fontSize: '10.5px',
        padding: '0 7px',
        borderRadius: '999px',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: PALETTE.line,
        color: PALETTE.dim,
        whiteSpace: 'nowrap',
        lineHeight: '17px'
      },
      button: {
        appearance: 'none',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: PALETTE.line,
        background: PALETTE.soft,
        color: PALETTE.text,
        padding: '4px 9px',
        borderRadius: '7px',
        cursor: 'pointer',
        fontSize: '12px',
        whiteSpace: 'nowrap'
      },
      tiny: { padding: '2px 7px', fontSize: '11.5px' },
      primary: { background: PALETTE.accent, borderColor: PALETTE.accent, color: '#fff', fontWeight: 600 },
      danger: { background: PALETTE.dangerSoft, borderColor: PALETTE.dangerLine, color: PALETTE.danger },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: PALETTE.bgField,
        color: PALETTE.text,
        border: `1px solid ${PALETTE.line}`,
        borderRadius: '7px',
        padding: '6px 9px',
        font: '12px/1.5 ' + PALETTE.mono,
        outline: 'none'
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '180px',
        resize: 'vertical',
        background: PALETTE.bgField,
        color: PALETTE.text,
        border: `1px solid ${PALETTE.line}`,
        borderRadius: '8px',
        padding: '9px',
        font: '12px/1.6 ' + PALETTE.mono,
        outline: 'none'
      },
      hint: { color: PALETTE.dim, fontSize: '12px', lineHeight: 1.65 },
      notice: {
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: PALETTE.line,
        borderLeftWidth: '3px',
        borderLeftStyle: 'solid',
        borderLeftColor: PALETTE.accent,
        background: PALETTE.accentSoft,
        padding: '8px 10px',
        borderRadius: '8px',
        marginBottom: '10px',
        fontSize: '12px'
      },
      warnNotice: {
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: PALETTE.line,
        borderLeftWidth: '3px',
        borderLeftStyle: 'solid',
        borderLeftColor: PALETTE.warn,
        background: PALETTE.warnSoft,
        padding: '8px 10px',
        borderRadius: '8px',
        marginBottom: '10px',
        fontSize: '12px'
      },
      statusBar: {
        flexShrink: 0,
        padding: '10px 12px 0',
        background: PALETTE.bgSoft
      },
      modalOverlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 2147483001,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: PALETTE.modalOverlay,
        padding: '16px',
        boxSizing: 'border-box'
      },
      modalCard: {
        width: 'min(360px, 100%)',
        background: PALETTE.bg,
        color: PALETTE.text,
        border: `1px solid ${PALETTE.line}`,
        borderRadius: '12px',
        padding: '16px',
        boxShadow: PALETTE.shadow,
        font: '13px/1.6 "Segoe UI", system-ui, sans-serif'
      },
      editor: { borderTop: `1px solid ${PALETTE.line}`, padding: '10px', background: PALETTE.bgSoft },
      dock: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        appearance: 'none',
        border: `1px solid ${PALETTE.line}`,
        background: 'transparent',
        color: 'inherit',
        opacity: 0.72,
        padding: '3px 9px',
        borderRadius: '999px',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '11.5px'
      },
      dockDot: { width: '6px', height: '6px', borderRadius: '50%', background: PALETTE.ok, display: 'inline-block' }
      }
    }

    let css = makeCss(PALETTE)

    function setColorScheme (next) {
      const scheme = next === 'light' ? 'light' : 'dark'
      if (scheme === colorScheme) return
      colorScheme = scheme
      PALETTE = scheme === 'light' ? LIGHT_PALETTE : DARK_PALETTE
      css = makeCss(PALETTE)
      // These label maps captured PALETTE at module scope; rebuild them so a
      // light/dark switch does not leave the old scheme's badge colors.
      STATUS = makeStatus()
      SOURCE = makeSource()
      TIER = makeTier()
      try {
        window.dispatchEvent(new CustomEvent('prompt-lab:theme', { detail: { scheme } }))
      } catch {
        /* UI-only notification */
      }
    }

    /** DSH-style confirmation dialog; used instead of window.confirm. */
    function ConfirmDialog ({ title, message, confirmLabel = '确认', danger = false, onConfirm, onCancel, children }) {
      return h('div', {
        style: css.modalOverlay,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) onCancel()
        }
      },
      h('div', { style: css.modalCard },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, title),
        message ? h('div', { style: css.hint }, message) : null,
        children ? h('div', { style: { ...css.hint, marginTop: '6px' } }, children) : null,
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '12px', justifyContent: 'flex-end' } },
          h('button', { style: css.button, onClick: onCancel }, '取消'),
          h('button', {
            style: { ...css.button, ...(danger ? css.danger : css.primary) },
            onClick: onConfirm
          }, confirmLabel))))
    }

    const SECTION_INFO = {
      'harness:identity': '一句身份声明：告诉模型它由 DeepSeek Harness 驱动。不含平台事实、工具说明或行为规则。',
      'harness:source': 'Harness 源码位置说明，影响模型查找自身实现的方式。',
      'plan:policy': '计划模式规则：什么时候先出方案、什么时候直接执行。',
      plan: '计划模式入口提示。',
      'sandbox:policy': '沙箱与权限说明：模型据此判断能读写哪里、能不能执行命令。',
      'subagent:delegation': '子代理委派规则：何时拆任务、如何汇总结果。',
      'deployment:persona-prefix': '部署级人设前缀，通常被预设覆盖。',
      'deployment:persona-suffix': '部署级人设后缀。',
      'context:file-reference': '文件引用格式约定。',
      'ui:deliverable-file-references': '交付文件引用格式约定。',
      'app:web-surface': 'Web 界面说明。',
      'harness:source': 'Harness 源码位置说明。',
      'computer-use:dsh-cua': 'Computer Use 工具协议：桌面操作范围与调用说明。',
      'structured-output': '结构化输出格式约定。'
    }

    function describeSection (name) {
      if (SECTION_INFO[name]) return SECTION_INFO[name]
      if (name === 'tools:sdk') return 'PTC/代码模式下的工具 SDK 声明与调用说明。'
      if (name === 'tools:ptc-only') return 'PTC 模式限制说明：只允许通过工具 SDK 调用。'
      if (name === 'mcp-resource-servers') return 'MCP 资源服务器列表与读取说明。'
      if (name.startsWith('computer-use:')) return 'Computer Use 工具协议：桌面操作范围与调用说明。'
      if (name.startsWith('tool:')) {
        const tool = name.slice(5)
        return `工具 ${tool} 的调用说明：参数约定、成功/失败处理。删改会让模型误用它。`
      }
      if (name.startsWith('custom:') || name.startsWith('user:')) return '你新增的段落：按插入位置进入本次装配，官方段不受影响。'
      if (name.startsWith('harness:')) return 'Harness 内置说明段。'
      if (name.startsWith('plan:')) return '计划模式相关说明。'
      return '段落内容由提供它的插件决定；上方「来源」徽章标明它来自官方安装还是第三方插件。'
    }

    function makeStatus () {
      return {
        // Source already says "官方"; the status says whether it was changed.
        official: { label: '未改动', color: PALETTE.dim },
        active: { label: '生效', color: PALETTE.ok },
        suspended: { label: '挂起', color: PALETTE.warn },
        pending: { label: '待确认', color: PALETTE.warn },
        orphan: { label: '失效', color: PALETTE.danger },
        blocked: { label: '不生效', color: PALETTE.faint },
        unknown: { label: '未捕获', color: PALETTE.dim },
        extra: { label: '新增', color: PALETTE.accent }
      }
    }

    function makeSource () {
      return {
        official: { label: '官方', color: PALETTE.dim },
        plugin: { label: '插件', color: PALETTE.accent }
      }
    }

    function makeTier () {
      return {
        capability: { label: '能力', color: PALETTE.danger, warning: '这一段规定模型"能做什么、怎么用"（工具协议、沙箱权限、子代理、MCP）。置空或改写会让它误用工具、误判权限，影响的是真实动作，不只是对话。' },
        policy: { label: '策略', color: PALETTE.warn, warning: '这一段规定模型"按什么流程做事"（计划模式、协作规则、核心身份）。改动会改变它的工作习惯与决策顺序，通常不涉及权限。' },
        persona: { label: '人格', color: PALETTE.accent, warning: '这一段影响说话风格与人设，修改风险较低。' }
      }
    }

    let STATUS = makeStatus()
    let SOURCE = makeSource()
    let TIER = makeTier()

    function tierOf (row) {
      return row.sensitivity ? TIER[row.sensitivity] : null
    }

    /** The Host decides editability; the panel only mirrors `row.readOnly`. */
    function isReadOnlyRow (row) {
      return row?.readOnly === true
    }

    /** Same rule as the Host's estimateTokens; keeps the editor and saved rows in sync. */
    function estimateTok (value) {
      const text = String(value ?? '')
      if (text === '') return 0
      let tokens = 0
      for (const char of text) tokens += char.codePointAt(0) >= 0x2e80 ? 0.6 : 0.3
      return Math.ceil(tokens)
    }

    function tok (value) {
      return `~${value} tok`
    }

    /**
     * Compare the numeric release prefix only (major.minor.patch). The rc
     * suffix and build metadata are not part of the classification concern;
     * a patch bump is, because sections can change in a patch release.
     */
    function majorMinor (version) {
      const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ''))
      return match === null ? null : `${match[1]}.${match[2]}.${match[3] ?? '0'}`
    }

    function badge (label, color) {
      return h('span', {
        key: label + (color || ''),
        style: { ...css.badge, ...(color ? { color, borderColor: color + '55' } : {}) }
      }, label)
    }

    function lineDiff (official, mine) {
      const a = String(official || '').split('\n')
      const b = String(mine || '').split('\n')
      const max = 400
      const truncated = a.length > max || b.length > max
      const A = a.slice(0, max)
      const B = b.slice(0, max)
      const n = A.length
      const m = B.length
      const table = new Array(n + 1)
      for (let i = 0; i <= n; i++) table[i] = new Uint16Array(m + 1)
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i][j] = A[i] === B[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
        }
      }
      const rows = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (A[i] === B[j]) {
          rows.push({ type: 'same', text: A[i] })
          i++
          j++
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          rows.push({ type: 'del', text: A[i] })
          i++
        } else {
          rows.push({ type: 'add', text: B[j] })
          j++
        }
      }
      while (i < n) rows.push({ type: 'del', text: A[i++] })
      while (j < m) rows.push({ type: 'add', text: B[j++] })
      return { rows, truncated }
    }

    /** Stacked diff: official on top, your version below, unified +/- lines. */
    function DiffView ({ official, mine }) {
      const diff = useMemo(() => lineDiff(official, mine), [official, mine])
      return h('div', null,
        h('div', { style: { ...css.hint, marginBottom: '4px' } }, '− 官方原文　＋ 你的版本'),
        h('div', {
          style: {
            maxHeight: '260px',
            overflow: 'auto',
            border: `1px solid ${PALETTE.line}`,
            borderRadius: '8px',
            background: PALETTE.bgField,
            padding: '8px',
            font: '11.5px/1.55 ' + PALETTE.mono
          }
        },
        diff.rows.map((row, index) => h('div', {
          key: index,
          style: {
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: row.type === 'add' ? PALETTE.ok : row.type === 'del' ? PALETTE.danger : PALETTE.faint,
            background: row.type === 'add' ? PALETTE.okSoft : row.type === 'del' ? PALETTE.dangerSoft : 'transparent'
          }
        }, (row.type === 'add' ? '+ ' : row.type === 'del' ? '- ' : '  ') + row.text)),
        diff.truncated ? h('div', { style: { ...css.hint, marginTop: '6px' } }, '（内容过长，仅显示前 400 行）') : null)
      )
    }

    // ------------------------------------------------------------ prompt tab
    function PromptTab ({ sessionId, data, refresh, setError, setToast }) {
      const [editing, setEditing] = useState(null)
      const [mode, setMode] = useState('replace')
      const [value, setValue] = useState('')
      const [showDiff, setShowDiff] = useState(false)
      const [busy, setBusy] = useState(false)
      const [adding, setAdding] = useState(false)
      const [driftOpen, setDriftOpen] = useState(false)
      const [showBlocked, setShowBlocked] = useState(false)
      const [saveAsOpen, setSaveAsOpen] = useState(false)
      const [saveAsName, setSaveAsName] = useState('')
      const [viewing, setViewing] = useState(null)
      const [newName, setNewName] = useState('custom:note')
      const [newAnchor, setNewAnchor] = useState('__end__')
      const [newText, setNewText] = useState('')
      const [instructions, setInstructions] = useState(null)

      useEffect(() => {
        let alive = true
        call('agents.read', { sessionId })
          .then((value) => { if (alive) setInstructions(value) })
          .catch((error) => { if (alive) setInstructions({ ok: false, reason: 'read-failed', notes: [String(error?.message ?? error)], files: [] }) })
        return () => { alive = false }
      }, [sessionId])

      const run = async (promise) => {
        try {
          const next = await promise
          if (next) refresh(next)
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const refreshList = async () => {
        try {
          // A capture (not state.get) is what re-reads the official assembly:
          // it is also how a Harness update turns active rows into suspended ones.
          refresh(await call('assemble.capture', { sessionId }))
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const rows = data.prompt.sections
      const locked = data.session.locked === true
      // A locked session compares the snapshot with the live assembly: changed
      // official text and yielded overrides arrive as row.drift / row.yielded.
      const driftedRows = rows.filter((row) =>
        row.drift === 'changed' || row.drift === 'removed' || row.drift === 'added')
      // Count what is actually assembled, not what is saved: a suspended
      // override contributes its official text, and a suppressed tool section
      // is empty.
      const effectiveTokens = (row) => {
        if (row?.toolSuppressed === true) return 0
        if (row?.status === 'active') return Number(row.tokens) || 0
        if (row?.status === 'suspended' || row?.status === 'pending') return Number(row.officialTokens) || 0
        if (row?.status === 'extra') return Number(row.tokens) || 0
        if (row?.status === 'official') return Number(row.officialTokens) || 0
        return 0
      }
      const officialNames = data.prompt.officialNames ?? []
      const templatesByKey = new Map()
      for (const template of data.library?.fragments ?? []) {
        if (template.target === 'insert') continue
        const list = templatesByKey.get(template.key) ?? []
        list.push(template)
        templatesByKey.set(template.key, list)
      }
      const completeActive = data.prompt.completeActive === true
      const complete = data.prompt.complete ?? {
        active: completeActive,
        sectionName: rows[0]?.name ?? null,
        text: rows[0]?.officialText ?? rows[0]?.text ?? '',
        tokens: rows[0]?.officialTokens ?? rows[0]?.tokens ?? 0,
        presetId: null,
        presetName: null
      }
      const total = completeActive
        ? Number(complete.tokens) || 0
        : rows.reduce((sum, row) => sum + effectiveTokens(row), 0)
      const blockedRows = rows.filter((row) =>
        row.status === 'blocked' ||
        row.status === 'extra' ||
        (row.status !== 'official' && row.name === complete.sectionName))
      const delta = data.prompt.delta ?? null
      const added = Array.isArray(delta?.added) ? delta.added : []
      const removed = Array.isArray(delta?.removed) ? delta.removed : []
      const hasDelta = delta !== null && delta.firstCapture !== true && added.length + removed.length > 0
      const release = data.meta?.release ?? {}
      const versionMismatch = !hasDelta &&
        majorMinor(release.version) !== null &&
        majorMinor(release.classifiedAgainst) !== null &&
        majorMinor(release.version) !== majorMinor(release.classifiedAgainst)

      const open = (row) => {
        const canEmpty = row.status !== 'extra' && !row.name.startsWith('tool:')
        setEditing(row.name)
        setMode(canEmpty && row.mode === 'empty' ? 'empty' : 'replace')
        setValue(canEmpty && row.mode === 'empty' ? '' : row.text)
        setShowDiff(false)
        setSaveAsOpen(false)
        setSaveAsName(row.fragmentLabel ? `${row.fragmentLabel} 副本` : '新模板')
      }

      // A save that does not change the section (same mode, same text) must not
      // pop the confirmation: the panel re-opens the editor with the current
      // value, so a plain "open then save" is a no-op.
      const sectionContentChanged = (row) => {
        const currentMode = row.mode === 'empty' ? 'empty' : 'replace'
        if (mode !== currentMode) return true
        if (mode === 'empty') return false
        return value !== (typeof row.text === 'string' ? row.text : '')
      }

      // Tool and dynamic sections can be edited before the first turn, but the
      // text is what the model reads: ask explicitly. Only the browser panel
      // asks; the API stays usable for automation.
      const confirmSectionSave = (row) => {
        if (!sectionContentChanged(row)) return true
        if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
        if (row.name.startsWith('tool:')) {
          if (!window.confirm('你正在修改工具说明。\n实际工具 schema 不会改变，模型可能因此误用工具。')) return false
          return window.confirm(`确认替换 ${row.name} 的说明？\n我理解实际工具定义仍由 DSH 控制。`)
        }
        if (/^(plan:|team:|tools:|computer-use:)/.test(row.name) ||
            row.name === 'mcp-resource-servers' ||
            row.name === 'structured-output') {
          return window.confirm('这一段由 DSH 按当前能力或模式实时生成；修改只影响模型看到的说明，不改变实际能力。继续？')
        }
        return true
      }

      const save = async (row) => {
        if (!confirmSectionSave(row)) return
        setBusy(true)
        try {
          // User-added sections live in state.extras, not in the fragment
          // library; saving them through fragment.save would create a second,
          // orphaned record instead of editing the row the user opened.
          const next = row.status === 'extra'
            ? await call('extra.save', {
              sessionId,
              name: row.name,
              anchor: row.anchor,
              order: row.order,
              text: mode === 'empty' ? '' : value
            })
            : await call('fragment.save', {
              sessionId,
              key: row.name,
              mode,
              text: mode === 'empty' ? '' : value,
              rebase: row.status === 'suspended'
            })
          refresh(next)
          setEditing(null)
          if (next?.save?.kind === 'unchanged' && typeof setToast === 'function') {
            setToast('没有改动，未写入片段库')
          } else if (next?.prompt?.completeActive === true && typeof setToast === 'function') {
            setToast('已保存；完整提示词下当前窗口不生效')
          } else if (next?.session?.draft === true && typeof setToast === 'function') {
            setToast(row.status === 'extra'
              ? '已保存到草稿；首次对话后提交'
              : '已保存；全局内容立即生效，窗口映射首次对话后提交')
          }
        } catch (error) {
          setError(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }

      const switchTemplate = async (row, fragmentId) => {
        try {
          if (fragmentId === '') {
            refresh(await call('override.clear', { sessionId, key: row.name }))
            return
          }
          const template = (templatesByKey.get(row.name) ?? []).find((entry) => entry.id === fragmentId)
          if (template === undefined) return
          const next = await call('fragment.save', {
            sessionId,
            key: row.name,
            mode: template.mode,
            text: template.text,
            id: template.id
          })
          refresh(next)
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const saveAsTemplate = async (row) => {
        const nextLabel = saveAsName.trim()
        if (nextLabel === '') {
          setError('模板名称不能为空')
          return
        }
        setBusy(true)
        try {
          const next = await call('fragment.save', {
            sessionId,
            key: row.name,
            mode,
            text: mode === 'empty' ? '' : value,
            new: true,
            label: nextLabel
          })
          refresh(next)
          setEditing(null)
          setSaveAsOpen(false)
          if (typeof setToast === 'function') {
            if (next?.save?.kind === 'created') {
              setToast('已另存为新模板')
            } else {
              setToast('内容与现有模板一致，已映射到该模板')
            }
          }
        } catch (error) {
          setError(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }

      const renderEditor = (row) => {
        const canEmpty = row.status !== 'extra' && !row.name.startsWith('tool:')
        return h('div', { style: css.editor },
        h('div', { style: { ...css.hint, marginBottom: '6px' } },
          `正在编辑 `, h('code', { style: { fontFamily: PALETTE.mono } }, row.name),
          tierOf(row) ? h('span', { style: { color: tierOf(row).color } }, `　· ${tierOf(row).label}级`) : null),
        tierOf(row)
          ? h('div', { style: { ...css.warnNotice, borderLeftColor: tierOf(row).color } }, tierOf(row).warning)
          : null,
        h('div', { style: { display: 'flex', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' } },
          h('label', { style: { ...css.hint, display: 'flex', alignItems: 'center', gap: '5px' } },
            h('input', { type: 'radio', checked: mode === 'replace', onChange: () => setMode('replace') }), '替换'),
          h('label', {
            style: { ...css.hint, display: 'flex', alignItems: 'center', gap: '5px', opacity: canEmpty ? 1 : 0.5 },
            title: canEmpty ? '' : '新增段或工具段不能置空'
          },
            h('input', {
              type: 'radio',
              checked: mode === 'empty',
              disabled: !canEmpty,
              onChange: () => { if (canEmpty) setMode('empty') }
            }), '置空')
        ),
        mode === 'replace'
          ? h('textarea', { style: css.textarea, value, spellCheck: false, onChange: (event) => setValue(event.target.value) })
          : h('div', { style: { ...css.hint, padding: '8px 0' } }, '保存后这一段从提示词中消失。'),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { style: { ...css.button, ...css.primary }, disabled: busy, onClick: () => save(row) }, busy ? '保存中…' : '保存'),
          row.status === 'extra' ? null : h('button', { style: css.button, disabled: busy, onClick: () => setSaveAsOpen((open) => !open) }, saveAsOpen ? '收起另存' : '另存为模板'),
          h('button', { style: css.button, onClick: () => setEditing(null) }, '取消'),
          h('button', { style: css.button, onClick: () => setShowDiff((v) => !v) }, showDiff ? '收起对比' : '对比原文'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: css.hint }, tok(mode === 'empty' ? 0 : estimateTok(value)))),
        saveAsOpen
          ? h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
            h('input', {
              style: { ...css.input, flex: '1 1 160px' },
              value: saveAsName,
              spellCheck: false,
              placeholder: '新模板名称',
              onChange: (event) => setSaveAsName(event.target.value)
            }),
            h('button', {
              style: { ...css.button, ...css.primary },
              disabled: busy,
              onClick: () => saveAsTemplate(row)
            }, '确认另存'),
            h('button', { style: css.button, onClick: () => setSaveAsOpen(false) }, '取消'))
          : null,
        showDiff ? h('div', { style: { marginTop: '10px' } }, h(DiffView, { official: row.officialText || '', mine: mode === 'empty' ? '' : value })) : null,
        h('div', { style: { ...css.hint, marginTop: '8px' } }, '切换其他段会丢弃这里未保存的内容。')
        )
      }

      const removeBlocked = (row) => {
        if (row.status === 'extra') return run(call('extra.delete', { sessionId, id: row.extraId }))
        return run(call('override.clear', { sessionId, key: row.name }))
      }

      const renderComplete = () => {
        const presetLabel = complete.presetName
          ? (complete.presetId ? `${complete.presetName}（${complete.presetId}）` : complete.presetName)
          : (complete.presetId || '未知')
        return h('div', null,
          data.session.draft
            ? h('div', { style: css.notice },
              '这是首次对话前的窗口：模板、保存预设、片段库和设置属于全局操作，会立即生效；当前窗口的映射在完整提示词下不生效，发送第一条消息后提交。')
            : null,
          h('div', { style: css.notice },
            '本会话的 agent preset 使用「完整提示词」：整篇提示词由 preset 决定，Prompt Lab 不提供分段编辑。',
            h('div', { style: { ...css.hint, marginTop: '4px' } }, '要修改内容，请更换 preset 或修改 preset 配置后新建会话。')),

          h('div', { style: css.card },
            h('div', { style: css.cardHead },
              h('strong', { style: { fontSize: '12.5px' } }, '完整提示词'),
              badge('只读', PALETTE.dim),
              complete.sectionName ? h('span', { style: { ...css.tag, fontFamily: PALETTE.mono } }, complete.sectionName) : null,
              h('span', { style: { ...css.hint, marginLeft: 'auto' } }, tok(complete.tokens))),
            h('div', { style: css.desc }, `来源 preset：${presetLabel}`),
            h('div', { style: { padding: '0 10px 10px' } },
              h('pre', {
                style: {
                  margin: 0,
                  maxHeight: '420px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: `1px solid ${PALETTE.line}`,
                  borderRadius: '8px',
                  background: PALETTE.bgField,
                  padding: '9px',
                  font: '11.5px/1.55 ' + PALETTE.mono
                }
              }, complete.text || '（尚未采样到完整正文）')),
            h('div', { style: { ...css.hint, padding: '0 10px 10px' } },
              '完整提示词是整篇替换，不是普通分段；这里的正文只读展示。')),

          !data.prompt.captured
            ? h('div', { style: css.warnNotice },
              h('div', { style: { marginBottom: '6px' } }, '还没有采样到完整正文。'),
              h('button', { style: { ...css.button, ...css.tiny }, onClick: () => run(call('assemble.capture', { sessionId })) }, '重新采样'))
            : null,

          h('div', { style: css.card },
            h('div', { style: css.cardHead },
              h('strong', { style: { fontSize: '12.5px' } }, '已保存但不生效的配置'),
              badge(String(blockedRows.length), PALETTE.faint),
              h('span', { style: { flex: 1 } }),
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => setShowBlocked((current) => !current)
              }, showBlocked ? '收起' : '展开')),
            showBlocked
              ? h('div', { style: { padding: '0 10px 10px' } },
                blockedRows.length === 0
                  ? h('div', { style: css.hint }, '没有已保存的覆盖或新增段。')
                  : blockedRows.map((row) => h('div', { key: row.name, style: { ...css.card, marginBottom: '6px' } },
                    h('div', { style: css.cardHead },
                      h('span', { style: css.name, title: row.name }, row.name),
                      badge(
                        row.status === 'extra' ? '新增段' : '覆盖',
                        row.status === 'extra' ? PALETTE.accent : PALETTE.warn
                      ),
                      h('span', { style: { ...css.hint, marginLeft: 'auto' } }, tok(row.tokens))),
                    h('div', { style: { ...css.desc, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, row.text || '（空）'),
                    h('div', { style: { padding: '0 10px 10px' } },
                      h('button', {
                        style: { ...css.button, ...css.tiny, ...css.danger },
                        onClick: () => removeBlocked(row)
                      }, '删除配置')))))
              : null),
          renderInstructions()
        )
      }

      if (completeActive) return renderComplete()

      function renderInstructions () {
        const header = h('div', { style: css.cardHead },
          h('strong', { style: { fontSize: '12.5px' } }, 'AGENTS 指令文件'),
          badge('只读', PALETTE.faint),
          h('span', { style: { ...css.hint, marginLeft: 'auto' } }, instructions?.cwd ? '来自当前工作目录链' : ''))
        if (instructions === null) {
          return h('div', { style: css.card }, header, h('div', { style: css.hint, padding: '0 10px 10px' }, '读取中…'))
        }
        if (instructions.ok !== true) {
          return h('div', { style: css.card }, header,
            h('div', { style: { ...css.hint, padding: '0 10px 10px' } },
              instructions.reason === 'no-cwd' ? '当前会话没有工作目录，无法定位 AGENTS 文件。' : '无法读取 AGENTS 文件。',
              ...(instructions.notes ?? []).map((note, index) => h('div', { key: index }, note))))
        }
        const files = instructions.files.length === 0
          ? h('div', { style: { ...css.hint, padding: '0 10px 10px' } }, '没有找到 AGENTS.md / CLAUDE.md 及其 local 文件。')
          : h('div', null, ...instructions.files.map((file) => h('details', {
            key: file.path,
            style: { margin: '0 10px 8px', borderTop: `1px solid ${PALETTE.line}`, paddingTop: '6px' }
          },
          h('summary', { style: { cursor: 'pointer', wordBreak: 'break-all' } },
            `${file.scope === 'global' ? '全局' : '项目'} · ${file.path}`,
            file.truncated ? '（已截断）' : '',
            h('span', { style: { ...css.hint, marginLeft: '6px' } }, `${file.bytes} B`)),
          h('pre', {
            style: {
              margin: '6px 0 0',
              maxHeight: '260px',
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              font: '11.5px/1.55 ' + PALETTE.mono,
              color: PALETTE.dim
            }
          }, file.text || '（空）'))))
        return h('div', { style: css.card }, header,
          h('div', { style: { ...css.hint, padding: '0 10px 6px' } },
            `工作目录：${instructions.cwd}`,
            instructions.root && instructions.root !== instructions.cwd ? `　项目根：${instructions.root}` : ''),
          files,
          ...(instructions.notes ?? []).map((note, index) => h('div', { key: `note-${index}`, style: { ...css.hint, padding: '0 10px' } }, note)))
      }

      return h('div', null,
        locked
          ? null
          : h('div', { style: css.notice }, '请在首次对话之前完成系统提示词配置。'),

        data.session.draft
          ? h('div', { style: css.notice },
            '这是首次对话前的窗口：模板、保存预设、片段库和设置属于全局操作，会立即生效；映射、启用状态、新增段等窗口配置暂存草稿，发送第一条消息后自动提交，关闭窗口则丢弃。')
          : null,

        completeActive
          ? h('div', { style: { ...css.warnNotice, borderLeftColor: PALETTE.danger, background: PALETTE.dangerSoft } },
            '本会话的 agent preset 使用「完整提示词」：整篇由 preset 决定，分段编辑不生效。',
            h('div', { style: { ...css.hint, marginTop: '4px' } }, '可以照常保存，配置不会丢；要让改动生效需要换掉这个 preset。'))
          : null,

        hasDelta
          ? h('div', { style: css.warnNotice },
            h('button', {
              style: { ...css.button, ...css.tiny, border: 'none', background: 'transparent', padding: 0, color: PALETTE.warn, textAlign: 'left' },
              onClick: () => setDriftOpen((value) => !value)
            }, `检测到 ${added.length} 个新段、${removed.length} 个消失段（点击${driftOpen ? '收起' : '展开'}）`),
            driftOpen
              ? h('div', { style: { marginTop: '6px', fontFamily: PALETTE.mono, fontSize: '11.5px', lineHeight: 1.6 } },
                added.map((name) => h('div', { key: `add-${name}`, style: { color: PALETTE.ok } }, `＋ ${name}`)),
                removed.map((name) => h('div', { key: `del-${name}`, style: { color: PALETTE.danger } }, `− ${name}`)),
                h('div', { style: { ...css.hint, marginTop: '4px' } }, '来源与风险分类可能不准确。'))
              : null)
          : null,

        versionMismatch
          ? h('div', { style: { ...css.hint, color: PALETTE.faint, marginBottom: '8px' } },
            `分类表基于 DSH ${release.classifiedAgainst}，当前 ${release.version}；请复核新增段的标记。`)
          : null,

        data.prompt.captured
          ? h('div', { style: css.notice }, locked ? `首轮装配已锁定：${rows.length} 段，合计 ${tok(total)}。` : `已读取当前装配：${rows.length} 段，合计 ${tok(total)}。改动从下一次请求起生效。`)
          : h('div', { style: css.warnNotice },
            h('div', { style: { marginBottom: '6px' } },
              data.capture?.reason === 'not-running'
                ? '这个会话当前没有运行中的 agent，无法即时装配。重新打开该会话后再试。'
                : data.capture?.reason
                  ? '无法获取装配。'
                  : '还没有读到官方段。'),
            data.capture?.reason && data.capture.reason !== 'not-running'
              ? h('div', { style: css.hint },
                (() => {
                  const attribution = data.capture.attribution
                  if (!attribution || attribution.source === 'unknown') {
                    return '错误发生在装配阶段；无法确定来源。'
                  }
                  if (attribution.source === 'prompt-lab') return '疑似来源：Prompt Lab 自身。'
                  if (attribution.source === 'dsh') return '疑似来源：DSH 内置装配。'
                  return `疑似来源：第三方插件 ${attribution.package ?? '（未知包名）'}。`
                })(),
                h('div', { style: { marginTop: '3px' } }, data.capture.attribution?.hint ?? '请查看技术细节。'))
              : null,
            data.capture?.reason && data.capture.reason !== 'not-running' && data.capture.detail
              ? h('details', { style: { marginTop: '6px' } },
                h('summary', { style: { cursor: 'pointer', color: PALETTE.faint, fontSize: '12px' } }, '查看技术细节'),
                h('pre', {
                  style: {
                    margin: '6px 0 0',
                    maxHeight: '240px',
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: '11px',
                    color: PALETTE.faint
                  }
                }, data.capture.detail))
              : null,
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
              h('button', { style: { ...css.button, ...css.tiny }, onClick: () => run(call('assemble.capture', { sessionId })) }, '获取官方段'),
              data.capture?.detail
                ? h('button', {
                  style: { ...css.button, ...css.tiny },
                  onClick: () => {
                    const text = [
                      `无法获取装配（${data.capture.reason ?? 'probe-failed'}）`,
                      data.capture.attribution?.hint ?? '',
                      data.capture.detail
                    ].filter(Boolean).join('\n\n')
                    if (navigator.clipboard?.writeText) {
                      navigator.clipboard.writeText(text)
                        .then(() => setToast?.('已复制错误信息'))
                        .catch((error) => setError?.(`复制失败：${error?.message ?? error}`))
                    } else {
                      setError?.('当前环境不支持剪贴板复制；请展开技术细节手动复制。')
                    }
                  }
                }, '复制错误')
                : null)),

        h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap', alignItems: 'center' } },
          locked
            ? h('span', { style: driftedRows.length > 0 ? { ...css.hint, color: PALETTE.warn } : css.hint },
              driftedRows.length > 0
                ? `首轮已开始，提示词页只读；本会话有 ${driftedRows.length} 段官方文本已变化，变化的覆盖已让位。`
                : '首轮已开始，提示词页只读；新建会话后可继续配置。')
            : h('button', { style: { ...css.button, ...css.primary }, onClick: () => setAdding((v) => !v) }, adding ? '收起' : '＋ 新增段'),
        ),

        adding && !locked
          ? h('div', { style: { ...css.card, padding: '10px' } },
            h('div', { style: { ...css.hint, marginBottom: '6px' } }, '段名建议带前缀，例如 custom:persona。同名段不会被重复插入。'),
            h('input', { style: { ...css.input, marginBottom: '6px' }, value: newName, spellCheck: false, onChange: (e) => setNewName(e.target.value) }),
            h('div', { style: { ...css.hint, marginBottom: '4px' } }, '插入位置（插在所选官方段之后）：'),
            h('select', {
              style: { ...css.input, marginBottom: '6px' },
              value: newAnchor,
              onChange: (e) => setNewAnchor(e.target.value)
            },
            h('option', { value: '__start__' }, '最前面（所有官方段之前）'),
            h('option', { value: '__end__' }, '最后面（所有官方段之后）'),
            officialNames.map((name) => h('option', { key: name, value: name }, `在 ${name} 之后`))),
            h('textarea', { style: { ...css.textarea, minHeight: '120px' }, value: newText, spellCheck: false, onChange: (e) => setNewText(e.target.value) }),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
              h('button', {
                style: { ...css.button, ...css.primary },
                disabled: newText.trim() === '',
                onClick: () => run(call('extra.save', { sessionId, name: newName, anchor: newAnchor, text: newText })
                  .then((next) => {
                    setAdding(false)
                    setNewText('')
                    return next
                  }))
              }, '保存'),
              h('button', { style: css.button, onClick: () => setAdding(false) }, '取消')))
          : null,

        locked && data.prompt.captured === true && data.prompt.contextComplete === false
          ? h('div', { style: css.warnNotice }, '本会话的官方基线是在缺少完整 step 上下文时采样的（工具集/模型选择未知），漂移检测可能把简化文本当成官方变化。')
          : null,

        rows.length === 0 ? h('div', { style: css.hint }, '没有可显示的段。') : null,

        rows.map((row) => {
          const templates = templatesByKey.get(row.name) ?? []
          const readOnly = isReadOnlyRow(row)
          return h('div', { key: row.name, style: css.card },
          h('div', { style: css.cardHead },
            h('span', { style: css.name, title: row.name }, row.name),
            row.source ? badge(SOURCE[row.source].label, SOURCE[row.source].color) : null,
            tierOf(row) ? badge(tierOf(row).label, tierOf(row).color) : null,
            readOnly && row.status === 'official'
              ? null
              : badge(STATUS[row.status]?.label || row.status, STATUS[row.status]?.color),
            readOnly ? badge('只读', PALETTE.faint) : null,
            row.drift === 'changed' ? badge('挂起', PALETTE.warn) : null,
            row.drift === 'removed' ? badge('失效', PALETTE.danger) : null,
            row.drift === 'added' ? badge('新增', PALETTE.accent) : null,
            row.yielded ? badge('已让位', PALETTE.danger) : null,
            row.textId ? badge(`文本库${row.textLabel ? `：${row.textLabel}` : ''}`, PALETTE.accent) : null,
            row.toolSuppressed ? badge('工具已关', PALETTE.warn) : null,
            completeActive ? badge('不生效', PALETTE.faint) : null,
            h('span', { style: { ...css.hint, marginLeft: 'auto' } }, tok(row.tokens))),
          h('div', { style: css.desc },
              describeSection(row.name),
              readOnly ? '　该段由 DSH 按实时能力生成或控制，不能编辑。' : '',
              row.toolSuppressed ? '　当前工具开关已关闭此工具说明；关闭「对本会话生效」会恢复。' : '',
              row.status === 'suspended' ? '　官方原文已变化，你的版本暂未生效。' : '',
              row.drift === 'changed'
                ? (row.yielded
                  ? '　官方文本已变化；这段覆盖已让位，本轮起使用官方文本。恢复需要新建会话。'
                  : '　官方文本已变化；本段没有覆盖，仅作标记。')
                : '',
              row.drift === 'removed' ? '　官方已没有这一段；配置保留但不再生效。' : '',
              row.drift === 'added' ? '　这是官方新增的段。' : '',
              row.status === 'pending' ? '　尚未采样到官方基线，首次对话后重新校验。' : '',
              row.status === 'active' && row.applied === false && !completeActive ? '　注册未生效（可能被同一 agent 作用域的其他插件占用了同名段）。' : '',
              row.status === 'orphan' ? '　官方已没有这一段，可以转成新增段继续用。' : '',
              row.status === 'extra'
                ? `　跟随位置：${row.anchor === '__start__' ? '整篇最前' : row.anchor === '__end__' ? '整篇最后' : `在 ${row.anchor} 之后`}${row.anchorMissing ? '（原锚点已不存在，暂排在最后）' : ''}`
                : '',
              row.source === 'plugin' && row.sensitivity === null ? '　内容由插件提供，未审核；风险无法从段名判断，改动前请先看原文。' : '',
              completeActive ? '　本会话使用完整提示词，分段编辑不生效。' : ''),
          !locked && !readOnly && row.status !== 'extra' && templates.length > 0
            ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '0 10px 8px', flexWrap: 'wrap' } },
              h('span', { style: css.hint }, '模板'),
              h('select', {
                style: { ...css.input, width: 'auto', flex: '1 1 160px' },
                value: row.fragmentId ?? '',
                onChange: (event) => switchTemplate(row, event.target.value)
              },
              h('option', { value: '' }, '不使用模板 / 官方'),
              templates.map((template) => h('option', { key: template.id, value: template.id },
                `${template.label || '默认'} · ${template.mode === 'empty' ? '置空' : '替换'} · ~${template.tokens} tok`))))
            : null,
          h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap' } },
            readOnly || locked
              ? h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => setViewing(viewing === row.name ? null : row.name)
              }, viewing === row.name ? '收起正文' : (locked ? '当前正文' : '查看正文'))
              : h('button', { style: { ...css.button, ...css.tiny }, onClick: () => (editing === row.name ? setEditing(null) : open(row)) },
                editing === row.name ? '收起' : (row.status === 'official' ? '改写' : '编辑')),
            !locked && (row.status === 'active' || row.status === 'suspended' || row.status === 'pending' || (readOnly && row.status === 'orphan'))
              ? h('button', { style: { ...css.button, ...css.tiny }, onClick: () => run(call('override.clear', { sessionId, key: row.name })) }, '恢复官方')
              : null,
            !locked && !readOnly && row.status === 'suspended'
              ? h('button', { style: { ...css.button, ...css.tiny }, onClick: () => run(call('fragment.rebase', { sessionId, key: row.name })) }, '重新锚定')
              : null,
            !locked && !readOnly && row.status === 'orphan'
              ? h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => run(call('extra.save', { sessionId, name: row.name, anchor: '__end__', text: row.text })
                  .then(() => call('override.clear', { sessionId, key: row.name })))
              }, '转为新增段')
              : null,
            !locked && row.status === 'extra'
              ? h('button', { style: { ...css.button, ...css.tiny }, onClick: () => run(call('extra.move', { sessionId, id: row.extraId, delta: -1 })) }, '↑')
              : null,
            !locked && row.status === 'extra'
              ? h('button', { style: { ...css.button, ...css.tiny }, onClick: () => run(call('extra.move', { sessionId, id: row.extraId, delta: 1 })) }, '↓')
              : null,
            !locked && row.status === 'extra'
              ? h('button', { style: { ...css.button, ...css.tiny, ...css.danger }, onClick: () => run(call('extra.delete', { sessionId, id: row.extraId })) }, '删除')
              : null),
          viewing === row.name
            ? h('div', { style: { padding: '0 10px 10px' } },
              h('pre', {
                style: {
                  margin: 0,
                  maxHeight: '300px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: `1px solid ${PALETTE.line}`,
                  borderRadius: '8px',
                  background: PALETTE.bgField,
                  padding: '8px',
                  font: '11.5px/1.55 ' + PALETTE.mono
                }
              }, (readOnly ? (row.officialText || '') : (row.text || '')) || '（空）'))
            : null,
          editing === row.name && !readOnly ? renderEditor(row) : null)
          }),

        renderInstructions()
      )
    }

    // preset-editor: a render error inside the Agent preset view must not blank
    // the whole Prompt Lab sidebar; surface it in place instead.
    class AgentPresetBoundary extends React.Component {
      constructor (props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError (error) {
        return { error }
      }

      render () {
        if (this.state.error !== null) {
          return h('div', { style: { padding: '12px', color: PALETTE.danger, fontSize: '12px', lineHeight: 1.6 } },
            `Agent 预设面板渲染失败：${String(this.state.error?.message ?? this.state.error)}`)
        }
        return this.props.children
      }
    }

    // ------------------------------------------------------ agent preset tab
    // preset-editor: manages DSH Agent presets registered through the Host's
    // `agentPresets` service. This is a global view; it never edits the running
    // session, and existing sessions keep the preset they started with.
    function AgentPresetTab ({ sessionId, setError, setToast }) {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(null)
      const [configEdit, setConfigEdit] = useState(null)
      const [configText, setConfigText] = useState('')
      const [configError, setConfigError] = useState(null)
      const [openRowConfig, setOpenRowConfig] = useState(null)
      // Rows removed from a copied preset, kept so re-checking restores the
      // original config instead of the table default.
      const [removedRows, setRemovedRows] = useState({})
      const [rowJsonOpen, setRowJsonOpen] = useState(null)
      const [rowJsonText, setRowJsonText] = useState('')
      const [rowJsonError, setRowJsonError] = useState(null)

      const load = useCallback(async () => {
        try {
          setState(await call('agentPresets.state', { sessionId }))
        } catch (error) {
          setError(String(error.message || error))
        }
      }, [sessionId, setError])

      useEffect(() => { load() }, [load])

      const toast = (message) => {
        if (typeof setToast === 'function') setToast(message)
      }

      const run = async (work) => {
        setBusy(true)
        try {
          await work()
        } catch (error) {
          setError(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }

      const startCreate = () => {
        setOpenRowConfig(null)
        setRemovedRows({})
        setDraft({
          id: '',
          name: '',
          description: '',
          order: 100,
          enabled: true,
          complete: false,
          rows: [],
          plugins: [],
          templates: [],
          rowConfigs: {},
          prompt: { fragmentIds: [], text: '', suffix: '' }
        })
      }

      const startEdit = (preset) => {
        setOpenRowConfig(null)
        setRemovedRows({})
        setDraft({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          order: preset.order,
          enabled: preset.enabled,
          complete: preset.complete === true,
          rows: [...preset.rows],
          plugins: Array.isArray(preset.plugins) ? preset.plugins : [],
          templates: Array.isArray(preset.templates) ? [...preset.templates] : [],
          rowConfigs: preset.rowConfigs !== undefined ? { ...preset.rowConfigs } : {},
          prompt: {
            fragmentIds: [...preset.prompt.fragmentIds],
            text: preset.prompt.text,
            suffix: preset.prompt.suffix
          }
        })
      }

      const saveDraft = () => run(async () => {
        const next = await call('agentPresets.save', { preset: draft })
        setState(next)
        setDraft(null)
        const saved = next?.saved ?? {}
        toast(saved.registered === true
          ? `已保存并注册：${saved.id}`
          : `已保存 ${saved.id}，注册失败：${saved.error ?? '未知原因'}`)
      })

      const toggle = (preset) => run(async () => {
        const next = await call('agentPresets.save', { preset: { ...preset, enabled: preset.enabled !== true } })
        setState(next)
        toast(preset.enabled === true ? `已停用 ${preset.id}` : `已启用 ${preset.id}`)
      })

      const remove = (preset) => run(async () => {
        const next = await call('agentPresets.delete', { id: preset.id })
        setState(next)
        setConfirming(null)
        toast(`已删除 ${preset.id}`)
      })

      const copyOfficial = (entry) => run(async () => {
        const next = await call('agentPresets.copy', { id: entry.id })
        setState(next)
        const saved = next?.saved ?? {}
        toast(saved.registered === true
          ? `已复制为自定义预设：${saved.id}`
          : `已复制 ${saved.id}，注册失败：${saved.error ?? '未知原因'}`)
      })

      if (state === null) {
        return h('div', { style: css.body }, h('div', { style: css.hint }, '读取中…'))
      }

      // Copied presets carry a complete row list in `plugins`; the catalog
      // checkbox card is a projection of it: checked means the name is present.
      // Rows outside the catalog stay in the list, in their original order.
      const plugins = Array.isArray(draft?.plugins) ? draft.plugins : []
      const pluginsMode = plugins.length > 0
      const setPlugins = (next) => setDraft({ ...draft, plugins: next })
      // Copied rows keep their config on the row itself (not `rowConfigs`), so
      // field controls edit `plugins[index].config` directly.
      // `undefined` removes the key: a cleared number field must not persist as
      // "" (a zod number field would reject it and the preset would mount broken).
      const setRowConfigRaw = (index, key, value) => setPlugins(plugins.map((row, position) => {
        if (position !== index) return row
        const config = { ...(row.config ?? {}) }
        if (value === undefined) delete config[key]
        else config[key] = value
        if (Object.keys(config).length === 0) {
          const { config: _dropped, ...rest } = row
          return rest
        }
        return { ...row, config }
      }))
      const catalogIndex = (name) => plugins.findIndex((row) => row.name === name)
      const isCatalogChecked = (row) => pluginsMode ? catalogIndex(row.name) >= 0 : draft.rows.includes(row.name)
      // Unchecking a copied row keeps the original object, so re-checking
      // restores its config and disabled condition instead of the table default.
      const toggleCatalogRow = (row, next) => {
        if (!pluginsMode) {
          setDraft({ ...draft, rows: next ? [...draft.rows, row.name] : draft.rows.filter((name) => name !== row.name) })
          return
        }
        if (next) {
          const restored = removedRows[row.name]
          const entry = restored !== undefined
            ? restored
            : { name: row.name, ...(row.config !== undefined && Object.keys(row.config).length > 0 ? { config: { ...row.config } } : {}) }
          setPlugins([...plugins, entry])
          const { [row.name]: _restored, ...rest } = removedRows
          setRemovedRows(rest)
          return
        }
        const index = catalogIndex(row.name)
        if (index < 0) return
        setRemovedRows({ ...removedRows, [row.name]: plugins[index] })
        setPlugins(plugins.filter((_, position) => position !== index))
      }
      const removeRow = (index) => {
        setPlugins(plugins.filter((_, position) => position !== index))
        setConfigEdit(null)
        setOpenRowConfig(null)
      }
      // A `{ __jsExpr }` disable condition declared by the preset is not a plain
      // switch: dropping it would mount the row on the other platform too (bash
      // and pwsh register the same tool name). Only booleans may be toggled.
      const toggleRow = (index) => {
        setPlugins(plugins.map((row, position) => {
          if (position !== index) return row
          if (row.disabled !== null && typeof row.disabled === 'object') return row
          const next = { ...row }
          const disabled = next.disabled !== undefined && next.disabled !== false
          if (disabled) delete next.disabled
          else next.disabled = true
          return next
        }))
      }
      const startConfigEdit = (index) => {
        setConfigEdit(index)
        setConfigText(JSON.stringify(plugins[index]?.config ?? {}, null, 2))
        setConfigError(null)
      }
      const applyConfig = () => {
        if (configEdit === null) return
        let parsed
        try {
          parsed = JSON.parse(configText)
        } catch (error) {
          setConfigError(`不是合法 JSON：${String(error.message || error)}`)
          return
        }
        if (parsed === null || typeof parsed !== 'object') {
          setConfigError('config 必须是 JSON 对象或数组')
          return
        }
        setPlugins(plugins.map((row, position) => position === configEdit ? { ...row, config: parsed } : row))
        setConfigEdit(null)
        setConfigError(null)
      }
      const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px' }
      const rowStyle = { display: 'flex', gap: '6px', alignItems: 'flex-start', fontSize: '12px', lineHeight: 1.45 }
      const rawRowStyle = { borderTop: `1px solid ${PALETTE.line}`, padding: '6px 0' }
      const monoHint = { display: 'block', fontFamily: PALETTE.mono, fontSize: '11px', color: PALETTE.faint }
      const inputStyle = { ...css.input }

      const field = (label, control) => h('label', { style: fieldStyle },
        h('span', { style: { color: PALETTE.dim } }, label),
        control)

      const textField = (label, value, onChange, extra = {}) => field(label, h('input', {
        style: inputStyle,
        value,
        ...extra,
        onChange: (event) => onChange(event.target.value)
      }))

      const cardOf = (preset) => {
        const templateRows = (preset.templates ?? []).reduce((sum, id) => sum
          + ((state.templates ?? []).find((template) => template.id === id)?.rows.length ?? 0), 0)
        const totalRows = (preset.plugins?.length ?? 0) || (preset.rows.length + templateRows)
        const templateNote = (preset.templates?.length ?? 0) > 0 ? `（含 ${preset.templates.length} 个模板）` : ''
        // Copied presets keep the whole prompt inside the persona row, so their
        // `prompt.prefix` is empty; the card must read the row instead.
        const personaRow = (preset.plugins ?? []).find((row) => row.name === '@deepseek-ai/dsh-persona')
        const personaText = typeof personaRow?.config?.prefix === 'string' ? personaRow.config.prefix : ''
        const promptLength = personaText !== '' ? personaText.length : (preset.prompt?.prefix?.length ?? 0)
        const actions = [
          h('button', { key: 'edit', style: { ...css.button, ...css.tiny }, disabled: busy, onClick: () => startEdit(preset) }, '编辑'),
          h('button', { key: 'toggle', style: { ...css.button, ...css.tiny }, disabled: busy, onClick: () => toggle(preset) }, preset.enabled === true ? '停用' : '启用')
        ]
        actions.push(confirming === preset.id
          ? h('button', { key: 'delete', style: { ...css.button, ...css.tiny, ...css.danger }, disabled: busy, onClick: () => remove(preset) }, '确认删除')
          : h('button', { key: 'delete', style: { ...css.button, ...css.tiny }, disabled: busy, onClick: () => setConfirming(preset.id) }, '删除'))
        return h('div', { key: preset.id, style: css.card },
          h('div', { style: css.cardHead },
            h('strong', { style: { fontSize: '12.5px' } }, preset.name),
            badge(preset.id, PALETTE.dim),
            preset.enabled !== true
              ? badge('已停用', PALETTE.warn)
              : preset.runtime?.mounted === true ? badge('已挂载', PALETTE.ok) : badge('未挂载', PALETTE.danger)),
          h('div', { style: css.desc },
            `order ${preset.order} · 插件行 ${totalRows}${templateNote} · 提示词 ${promptLength} 字`
            + (preset.description !== '' ? ` · ${preset.description}` : '')),
          preset.runtime?.broken
            ? h('div', { style: { ...css.warnNotice, margin: '0 10px 8px' } }, preset.runtime.broken)
            : null,
          h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap' } }, actions))
      }

      // Build the editor only when a draft exists: every element below reads
      // `draft.*`, so constructing them in list mode throws and blanks the panel.
      const buildEditor = () => {
      const identityCard = h('div', { style: css.card },
        h('div', { style: css.cardHead },
          h('strong', { style: { fontSize: '12.5px' } }, draft.id === '' ? '新建 Agent 预设' : `编辑 ${draft.id}`),
          h('span', { style: { flex: 1 } }),
          h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setDraft(null) }, '取消')),
        h('div', { style: { padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
          textField('id（小写字母、数字、连字符；保存后不可改）', draft.id, (value) => setDraft({ ...draft, id: value }), {
            placeholder: 'review',
            disabled: (state.presets ?? []).some((preset) => preset.id === draft.id)
          }),
          textField('名称', draft.name, (value) => setDraft({ ...draft, name: value }), { placeholder: 'Review' }),
          textField('描述（可空）', draft.description, (value) => setDraft({ ...draft, description: value })),
          textField('排序（越小越靠前）', draft.order, (value) => setDraft({ ...draft, order: Number(value) }), { type: 'number' })))

      const templateIds = Array.isArray(draft.templates) ? draft.templates : []
      const shellTemplateOn = templateIds.includes('persistent-shell')
      const shellRowOn = draft.rows.includes('@deepseek-ai/dsh-tool-bash') || draft.rows.includes('@deepseek-ai/dsh-tool-pwsh')

      // Complete mode: self-built presets carry a flag, copies carry it on the
      // persona row. Both are edited through the same prompt card.
      const personaIndex = plugins.findIndex((row) => row.name === '@deepseek-ai/dsh-persona')
      const personaConfig = personaIndex >= 0 ? (plugins[personaIndex].config ?? {}) : null
      const copiedComplete = pluginsMode && personaConfig?.complete === true
      const complete = pluginsMode ? copiedComplete : draft.complete === true
      const promptText = pluginsMode ? String(personaConfig?.prefix ?? '') : draft.prompt.text
      const textLimit = state.limits && Number.isFinite(state.limits.text) ? state.limits.text : 50_000
      const overLimit = promptText.length > textLimit
      const setPromptText = (value) => {
        if (!pluginsMode) {
          setDraft({ ...draft, prompt: { ...draft.prompt, text: value } })
          return
        }
        if (personaIndex < 0) return
        setRowConfigRaw(personaIndex, 'prefix', value)
      }
      const setCompleteMode = (next) => {
        if (!pluginsMode) {
          setDraft({ ...draft, complete: next })
          return
        }
        if (personaIndex < 0) return
        setPlugins(plugins.map((row, position) => {
          if (position !== personaIndex) return row
          const config = { ...(row.config ?? {}) }
          if (next) {
            config.complete = true
            config.includeRuntimeContext = false
          } else {
            delete config.complete
            delete config.includeRuntimeContext
          }
          const nextRow = { ...row }
          if (Object.keys(config).length === 0) delete nextRow.config
          else nextRow.config = config
          return nextRow
        }))
      }

      const rowConfigOf = (row) => (draft.rowConfigs ?? {})[row.name] ?? {}
      const setRowConfig = (row, key, value) => {
        const rowConfigs = { ...(draft.rowConfigs ?? {}) }
        const next = { ...(rowConfigs[row.name] ?? {}) }
        if (value === undefined) delete next[key]
        else next[key] = value
        if (Object.keys(next).length === 0) delete rowConfigs[row.name]
        else rowConfigs[row.name] = next
        setDraft({ ...draft, rowConfigs })
      }
      // Row config lives on `rowConfigs` for catalog presets and on the plugin
      // row itself for copies; both paths go through these two accessors.
      const rowConfigSource = (row) => pluginsMode
        ? (plugins[catalogIndex(row.name)]?.config ?? {})
        : rowConfigOf(row)
      const writeRowConfig = (row, key, value) => pluginsMode
        ? setRowConfigRaw(catalogIndex(row.name), key, value)
        : setRowConfig(row, key, value)
      const effectiveConfig = (row, override = rowConfigOf(row)) => ({ ...(row.config ?? {}), ...override })
      const initialValue = (row, field, override) => {
        const source = override ?? rowConfigOf(row)
        if (Object.prototype.hasOwnProperty.call(source, field.key)) return source[field.key]
        if (row.config !== undefined && Object.prototype.hasOwnProperty.call(row.config, field.key)) return row.config[field.key]
        const fallback = field.default
        if (fallback === null || fallback === undefined) return field.type === 'boolean' ? false : ''
        if (typeof fallback === 'boolean') return fallback
        if (typeof fallback === 'number') return Number.isFinite(fallback) ? fallback : ''
        if (field.type === 'boolean') return String(fallback) === 'true'
        if (field.type === 'number') {
          const numeric = Number(String(fallback).replaceAll('_', ''))
          return Number.isFinite(numeric) ? numeric : ''
        }
        // Older tables stored source text (`'legacy'`); strip the quotes.
        const quoted = String(fallback).match(/^(['"])([\s\S]*)\1$/)
        return quoted === null ? String(fallback) : quoted[2]
      }
      const rowFieldControl = (row, field, override, write) => {
        const value = initialValue(row, field, override)
        const label = `${field.key}${field.required ? ' *' : ''}`
        // The build script records `null` when a default is not a literal; the
        // control stays empty and points at the docs instead of guessing.
        const hint = field.desc !== ''
          ? field.desc
          : (field.default === null ? '默认值见文档' : '')
        if (field.type === 'enum' && Array.isArray(field.options) && field.options.length > 0) {
          return h('label', { key: field.key, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11.5px' } },
            h('span', { style: { minWidth: '96px' } }, label),
            h('select', {
              style: { ...css.input, width: '140px' },
              value,
              onChange: (event) => write(field.key, event.target.value)
            }, field.options.map((option) => h('option', { key: option, value: option }, option))),
            hint !== '' ? h('span', { style: { color: PALETTE.faint } }, hint) : null)
        }
        if (field.type === 'boolean') {
          return h('label', { key: field.key, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11.5px' } },
            h('input', { type: 'checkbox', checked: value === true, onChange: (event) => write(field.key, event.target.checked) }),
            h('span', null, label),
            hint !== '' ? h('span', { style: { color: PALETTE.faint } }, ` · ${hint}`) : null)
        }
        const input = h('input', {
          style: { ...css.input, width: '88px' },
          type: field.type === 'number' ? 'number' : 'text',
          value,
          onChange: (event) => {
            const raw = event.target.value
            if (field.type !== 'number') {
              write(field.key, raw)
              return
            }
            // Clearing the box removes the key instead of storing "".
            write(field.key, raw === '' ? undefined : Number(raw))
          }
        })
        return h('label', { key: field.key, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11.5px' } },
          h('span', { style: { minWidth: '96px' } }, label),
          input,
          hint !== '' ? h('span', { style: { color: PALETTE.faint } }, hint) : null)
      }
      const rowConfigPanel = (row) => {
        if (openRowConfig !== row.name) return null
        if (rowJsonOpen === row.name) {
          return h('div', { style: { margin: '4px 0 0 22px' } },
            h('textarea', {
              style: { ...css.textarea, minHeight: '84px', fontFamily: PALETTE.mono, fontSize: '11px' },
              value: rowJsonText,
              spellCheck: false,
              onChange: (event) => { setRowJsonText(event.target.value); setRowJsonError(null) }
            }),
            rowJsonError === null ? null : h('div', { style: { color: PALETTE.danger, fontSize: '11px', marginTop: '3px' } }, rowJsonError),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '3px' } },
              h('button', {
                style: { ...css.button, ...css.tiny, ...css.primary },
                onClick: () => {
                  let parsed
                  try { parsed = JSON.parse(rowJsonText) } catch (error) {
                    setRowJsonError(`不是合法 JSON：${String(error.message || error)}`)
                    return
                  }
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    setRowJsonError('config 必须是 JSON 对象')
                    return
                  }
                  if (pluginsMode) {
                    setPlugins(plugins.map((entry) => entry.name === row.name ? { ...entry, config: parsed } : entry))
                  } else {
                    setDraft({
                      ...draft,
                      rowConfigs: { ...(draft.rowConfigs ?? {}), [row.name]: parsed }
                    })
                  }
                  setRowJsonOpen(null)
                  setRowJsonError(null)
                }
              }, '应用'),
              h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setRowJsonOpen(null) }, '取消')))
        }
        if (row.fields.length === 0) {
          return h('div', { style: { margin: '4px 0 0 22px', color: PALETTE.faint, fontSize: '11.5px' } }, '该行没有可配置字段。')
        }
        return h('div', { style: { margin: '4px 0 0 22px', display: 'flex', flexDirection: 'column', gap: '4px' } },
          row.fields.map((field) => rowFieldControl(row, field, rowConfigSource(row), (key, value) => writeRowConfig(row, key, value))),
          h('button', {
            style: { ...css.button, ...css.tiny, alignSelf: 'flex-start' },
            onClick: () => {
              setRowJsonOpen(row.name)
              setRowJsonText(JSON.stringify(effectiveConfig(row, rowConfigSource(row)), null, 2))
              setRowJsonError(null)
            }
          }, '高级 JSON'))
      }

      const disabledBadge = (row) => {
        const disabled = row.disabled !== undefined && row.disabled !== false
        if (!disabled) return null
        const expression = row.disabled && typeof row.disabled === 'object' && typeof row.disabled.__jsExpr === 'string'
        return expression ? badge('条件禁用', PALETTE.warn) : badge('已禁用', PALETTE.warn)
      }
      const configEditor = (index) => h('div', { style: { marginTop: '6px' } },
        h('textarea', {
          style: { ...css.textarea, minHeight: '96px', fontFamily: PALETTE.mono, fontSize: '11.5px' },
          value: configText,
          spellCheck: false,
          onChange: (event) => { setConfigText(event.target.value); setConfigError(null) }
        }),
        configError === null ? null : h('div', { style: { color: PALETTE.danger, fontSize: '11.5px', marginTop: '4px' } }, configError),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px' } },
          h('button', { style: { ...css.button, ...css.tiny, ...css.primary }, onClick: applyConfig }, '应用'),
          h('button', { style: { ...css.button, ...css.tiny }, onClick: () => startConfigEdit(index) }, '恢复原值'),
          h('button', { style: { ...css.button, ...css.tiny }, onClick: () => { setConfigEdit(null); setConfigError(null) } }, '取消')))

      const groupControls = []
      let currentGroup = null
      for (const row of state.catalog ?? []) {
        if (row.group !== currentGroup) {
          currentGroup = row.group
          groupControls.push(h('div', {
            key: `group-${currentGroup}`,
            style: { ...css.hint, marginTop: groupControls.length === 0 ? 0 : '6px' }
          }, currentGroup))
        }
        const checked = isCatalogChecked(row)
        const platformMismatch = row.platform !== undefined && row.platform !== state.platform
        // Shell/platform conflicts only bind the checkbox editor: a copied row
        // keeps whatever condition the source declared.
        const blocked = !pluginsMode && (
          (shellTemplateOn && (row.name === '@deepseek-ai/dsh-tool-bash' || row.name === '@deepseek-ai/dsh-tool-pwsh'))
          || (platformMismatch && !checked))
        const onToggle = (next) => toggleCatalogRow(row, next)
        const rowChanged = !pluginsMode && Object.keys(rowConfigOf(row)).length > 0
        groupControls.push(h('div', { key: row.name },
          h('label', { style: { ...rowStyle, opacity: blocked ? 0.55 : 1 } },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: blocked,
              onChange: (event) => onToggle(event.target.checked)
            }),
            h('span', null,
              h('strong', null, row.label),
              h('span', { style: { color: PALETTE.faint } }, ` · ${row.note}`),
              row.tools !== undefined && row.tools.length > 0
                ? h('span', { style: { color: PALETTE.faint } }, ` · ${row.tools.length} 个工具`)
                : null,
              h('span', { style: monoHint }, row.name),
              platformMismatch && !pluginsMode
                ? h('span', { style: { display: 'block', color: PALETTE.warn, fontSize: '11px' } },
                  checked ? '当前平台不推荐，可取消勾选' : '当前平台不可用')
                : null,
              checked ? h('span', { style: { display: 'block' } }, disabledBadge(row)) : null)),
          checked && (row.fields !== undefined && row.fields.length > 0)
            ? h('div', { style: { margin: '2px 0 4px 22px' } },
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => setOpenRowConfig(openRowConfig === row.name ? null : row.name)
              }, openRowConfig === row.name ? '收起配置' : `配置${rowChanged ? '（已改）' : ''}`),
              rowConfigPanel(row))
            : null))
      }

      const knownRows = new Set((state.catalog ?? []).map((row) => row.name))
      // Rows the checkbox card cannot represent: copied personas, groups and
      // anything outside the whitelist keep their original order at the bottom.
      const extras = pluginsMode
        ? plugins.map((row, index) => ({ row, index }))
          .filter(({ row }) => !knownRows.has(row.name))
          .filter(({ row }) => !(complete && row.name === '@deepseek-ai/dsh-persona'))
        : draft.rows.filter((name) => !knownRows.has(name)).map((name) => ({ row: { name }, index: -1 }))
      const extraControls = extras.length === 0 ? [] : [
        h('div', { key: 'extra-title', style: { ...css.hint, marginTop: '8px' } },
          '其它行（按原顺序排在下面；行顺序不影响挂载）'),
        ...extras.map(({ row, index }) => {
          const disabled = row.disabled !== undefined && row.disabled !== false
          const expression = row.disabled && typeof row.disabled === 'object' && typeof row.disabled.__jsExpr === 'string'
            ? row.disabled.__jsExpr
            : null
          const actions = pluginsMode
            ? [
                h('button', { key: 'config', style: { ...css.button, ...css.tiny }, onClick: () => startConfigEdit(index) }, '编辑 config'),
                h('button', {
                  key: 'toggle',
                  style: { ...css.button, ...css.tiny, opacity: expression === null ? 1 : 0.5 },
                  disabled: expression !== null,
                  title: expression === null ? undefined : '条件禁用来自预设的 !!js 表达式，不能在这里切换；要改请用「编辑 config」',
                  onClick: () => toggleRow(index)
                }, disabled ? '启用' : '禁用'),
                h('button', { key: 'delete', style: { ...css.button, ...css.tiny, ...css.danger }, onClick: () => removeRow(index) }, '删除')
              ]
            : [
                h('button', {
                  key: 'remove',
                  style: { ...css.button, ...css.tiny },
                  onClick: () => setDraft({ ...draft, rows: draft.rows.filter((item) => item !== row.name) })
                }, '移除')
              ]
          return h('div', { key: `${row.name ?? 'row'}-${index}`, style: rawRowStyle },
            h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { ...monoHint, display: 'inline', flex: 1 } }, `${index >= 0 ? `${index + 1}. ` : ''}${row.name ?? '(未命名行)'}`),
              row.group === true ? badge('分组', PALETTE.dim) : null,
              disabledBadge(row),
              actions),
            expression === null ? null : h('div', { style: { ...css.hint, marginTop: '2px' } }, `条件：${expression}`),
            pluginsMode && configEdit === index ? configEditor(index) : null)
        })
      ]

      const templateControls = (state.templates ?? []).map((template) => {
        const checked = templateIds.includes(template.id)
        const blocked = template.id === 'persistent-shell' && shellRowOn
        const onToggle = (next) => setDraft({
          ...draft,
          templates: next ? [...templateIds, template.id] : templateIds.filter((id) => id !== template.id)
        })
        return h('label', {
          key: template.id,
          style: { ...rowStyle, opacity: blocked ? 0.55 : 1 }
        },
        h('input', {
          type: 'checkbox',
          checked,
          disabled: blocked,
          onChange: (event) => onToggle(event.target.checked)
        }),
        h('span', null,
          h('strong', null, template.label),
          h('span', { style: { color: PALETTE.faint } }, ` · ${template.rows.length} 行 · isolate ${Object.keys(template.isolate ?? {}).join(', ') || '无'}`),
          h('span', { style: monoHint }, template.rows.map((row) => row.name.replace('@deepseek-ai/', '')).join(' / '))))
      })

      const rowsCard = h('div', { style: css.card },
        h('div', { style: css.cardHead },
          h('strong', { style: { fontSize: '12.5px' } },
            pluginsMode ? `插件行（${plugins.length}）` : `插件行（${draft.rows.length} 行 + ${templateIds.length} 个模板）`)),
        h('div', { style: { padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: '5px' } },
          groupControls,
          extraControls,
          pluginsMode
            ? h('div', { style: { ...css.hint, marginTop: '8px' } },
              '复制来的预设组合固定：上面是与白名单一致的行，勾选会恢复它原本的 config；不能添加组模板。')
            : h('div', null,
              h('div', { style: { ...css.hint, marginTop: '6px' } }, '组模板（整组插入，带 isolate）'),
              templateControls,
              shellTemplateOn || shellRowOn
                ? h('div', { style: { ...css.hint, marginTop: '6px', color: PALETTE.warn } },
                  '「持久 shell」模板与 bash/pwsh 行互斥：两者注册同名工具，不能同时使用。')
                : null)))


      const fragmentControls = (state.fragments ?? []).map((fragment) => {
        const onToggle = (checked) => setDraft({
          ...draft,
          prompt: {
            ...draft.prompt,
            fragmentIds: checked
              ? [...draft.prompt.fragmentIds, fragment.id]
              : draft.prompt.fragmentIds.filter((id) => id !== fragment.id)
          }
        })
        return h('label', { key: fragment.id, style: rowStyle },
          h('input', { type: 'checkbox', checked: draft.prompt.fragmentIds.includes(fragment.id), onChange: (event) => onToggle(event.target.checked) }),
          h('span', null,
            h('strong', null, fragment.label),
            h('span', { style: { display: 'block', color: PALETTE.faint, fontSize: '11.5px' } }, fragment.preview)))
      })

      const promptBody = fragmentControls.length === 0
        ? h('div', { style: css.hint }, '片段库为空。先到「文本管理」保存片段，再回来引用。')
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, fragmentControls)

      const promptCard = h('div', { style: css.card },
        h('div', { style: css.cardHead },
          h('strong', { style: { fontSize: '12.5px' } },
            complete
              ? (pluginsMode ? '完整提示词（来自 persona 行）' : '完整提示词（整篇替换）')
              : '提示词（来自片段库）')),
        h('div', { style: { padding: '0 10px 10px' } },
          h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', marginBottom: '8px' } },
            h('input', {
              type: 'checkbox',
              checked: complete,
              disabled: pluginsMode && personaIndex < 0,
              onChange: (event) => setCompleteMode(event.target.checked)
            }),
            h('span', null, pluginsMode
              ? (personaIndex < 0
                  ? '当前副本没有 persona 行，不能使用完整提示词'
                  : '完整提示词：整篇替换（写回该副本的 persona 行）')
              : '完整提示词：整篇替换，不使用片段与分段')),
          complete
            ? h('div', { style: css.hint }, pluginsMode
                ? '整篇正文写回 persona.config.prefix；底部的 persona config 可以改其它设置。'
                : '新会话的系统提示词只有这一整篇；工具行照常挂载。')
            : promptBody,
          h('textarea', {
            style: { ...css.textarea, marginTop: '8px', minHeight: complete ? '200px' : '72px' },
            value: promptText,
            placeholder: complete ? '整篇系统提示词正文' : '追加在片段之后的提示词（可选）',
            onChange: (event) => setPromptText(event.target.value)
          }),
          h('div', { style: { ...css.hint, marginTop: '4px', color: overLimit ? PALETTE.danger : PALETTE.dim } },
            `${promptText.length} / ${textLimit} 字${overLimit ? '：超出上限，保存会被拒绝' : ''}`),
          pluginsMode && complete && personaIndex >= 0
            ? h('div', { style: { marginTop: '6px' } },
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => {
                  if (configEdit === personaIndex) {
                    setConfigEdit(null)
                    setConfigError(null)
                    return
                  }
                  startConfigEdit(personaIndex)
                }
              }, configEdit === personaIndex ? '收起 persona config' : 'persona config（JSON）'),
              configEdit === personaIndex ? configEditor(personaIndex) : null)
            : null,
          h('div', { style: { ...css.hint, marginTop: '6px' } },
            complete
              ? (pluginsMode
                  ? '勾选会写 complete: true、includeRuntimeContext: false；取消勾选会删掉这两个键。'
                  : '保存时写入 persona 行：prefix = 正文，complete = true，includeRuntimeContext = false。')
              : '保存时把选中的片段按顺序拼成 dsh-persona 的 prefix；片段正文改动后，回到这里再保存一次即可同步。')))

      const actions = h('div', { style: { display: 'flex', gap: '6px', paddingBottom: '12px' } },
        h('button', { style: { ...css.button, ...css.primary }, disabled: busy || overLimit, onClick: saveDraft }, busy ? '保存中…' : '保存'),
        h('button', { style: css.button, disabled: busy, onClick: () => setDraft(null) }, '取消'))

      // L1+L2: copied presets expose their row list for editing. The package
      // name stays as copied; order, enabled state, deletion and the JSON
      // config are editable here, and catalog rows can be appended.
      const editorBody = h('div', null,
        identityCard,
        rowsCard,
        (!pluginsMode || complete) ? promptCard : null,
        actions)
        return editorBody
      }

      const editor = draft === null ? null : buildEditor()

      const listBody = (state.presets ?? []).length === 0
        ? h('div', { style: css.hint }, '还没有自定义 Agent 预设。')
        : (state.presets ?? []).map(cardOf)

      const header = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '8px', flexWrap: 'wrap' } },
        h('strong', { style: { fontSize: '12.5px' } }, `已保存 ${(state.presets ?? []).length}/${state.limit ?? 0}`),
        h('span', { style: { flex: 1 } }),
        h('button', {
          style: { ...css.button, ...css.tiny, ...css.primary },
          disabled: busy || (state.presets ?? []).length >= (state.limit ?? 0),
          onClick: startCreate
        }, '新建'))

      const notes = h('div', { style: { ...css.hint, paddingBottom: '8px' } },
        '内置预设由 DSH 提供，只能选用、不能在这里覆盖；这里只管理本插件注册的预设。')

      const officialEntries = Array.isArray(state.official) ? state.official : []
      const officialBody = officialEntries.length === 0
        ? null
        : h('div', { style: { ...css.card, marginTop: '10px' } },
          h('div', { style: css.cardHead },
            h('strong', { style: { fontSize: '12.5px' } }, '其它预设'),
            h('span', { style: { flex: 1 } }),
            h('span', { style: css.hint }, '只读，可复制为自定义')),
          h('div', { style: { padding: '0 10px 10px', display: 'flex', flexDirection: 'column', gap: '6px' } },
            officialEntries.map((entry) => h('div', {
              key: entry.id,
              style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }
            },
            h('strong', { style: { fontSize: '12.5px' } }, entry.name),
            badge(entry.id, PALETTE.dim),
            entry.order === null ? null : h('span', { style: css.hint }, `order ${entry.order}`),
            entry.broken === null ? null : badge('不可用', PALETTE.danger),
            h('span', { style: { flex: 1 } }),
            h('button', {
              style: { ...css.button, ...css.tiny },
              disabled: busy,
              onClick: () => copyOfficial(entry)
            }, '复制为自定义')))))

      const schemaStatus = state.schemaStatus ?? {}
      const staleTable = schemaStatus.stale === true
        ? h('div', { style: css.warnNotice },
          `行配置表按 DSH ${schemaStatus.table} 生成，与当前安装 ${schemaStatus.current} 不一致；行字段与默认值可能不准，可用「高级 JSON」手动改。`)
        : null

      const unsupported = state.supported !== true
        ? h('div', { style: css.warnNotice }, '当前 DSH 没有 agentPresets 服务：预设可以编辑保存，但不会注册到名册。')
        : null

      const failures = (state.failures ?? []).length > 0
        ? h('div', { style: css.warnNotice }, `注册失败：${state.failures.map((item) => `${item.id} — ${item.error}`).join('；')}`)
        : null

      return h('div', { style: css.body },
        staleTable,
        h('div', { style: css.notice },
          'Agent 预设决定新会话挂载哪些插件行、使用什么人格提示词；与「预设」页（当前会话的提示词覆盖）无关。已经开启的会话不会改变，新会话才会使用。'),
        unsupported,
        failures,
        editor !== null ? editor : h('div', null, header, notes, listBody, officialBody))
    }

    // ----------------------------------------------------------- preset tab
    function PresetTab ({ sessionId, data, refresh, setError, setToast }) {
      const locked = data.session.locked === true
      const [presetName, setPresetName] = useState('')
      const [confirmReset, setConfirmReset] = useState(false)
      const [deleteTarget, setDeleteTarget] = useState(null)
      const run = async (promise) => {
        try {
          const next = await promise
          if (next) refresh(next)
        } catch (error) {
          setError(String(error.message || error))
        }
      }
      const askDelete = async (preset) => {
        try {
          const usage = await call('preset.usage', { id: preset.id })
          setDeleteTarget({ preset, usage })
        } catch (error) {
          setError(String(error.message || error))
        }
      }
      const applyPreset = async (preset) => {
        try {
          const next = await call('preset.apply', { sessionId, id: preset.id })
          refresh(next)
          if (typeof setToast === 'function') {
            const applied = next?.applied
            setToast(applied
              ? `已应用：覆盖 ${applied.overrides} 新增 ${applied.extras} 工具 ${applied.toolDeny}${applied.unresolved > 0 ? ` · 无法恢复 ${applied.unresolved}` : ''}`
              : '已应用预设')
          }
        } catch (error) {
          setError(String(error.message || error))
        }
      }
      const current = data.session.currentPreset ?? null
      const appliedId = current?.id ?? data.session.lastPreset?.id
      const stats = current?.stats ?? data.session.presetStats
      const limit = data.limits.presetLimit
      const currentSource = current?.source ?? 'none'
      const currentModified = current?.modified === true
      const currentLabel = currentSource === 'preset'
        ? (current.name || '未命名预设')
        : currentSource === 'missing'
          ? '来源预设已删除'
          : currentSource === 'manual'
            ? (currentModified ? '未命名（已修改）' : '未命名')
            : '未设置'
      const currentBadge = currentSource === 'preset'
        ? badge('来自预设', PALETTE.ok)
        : currentSource === 'missing'
          ? badge('来源已删除', PALETTE.danger)
          : currentSource === 'manual'
            ? badge(currentModified ? '手工配置' : '未保存配置', PALETTE.warn)
            : badge('未设置', PALETTE.dim)
      const currentCount = (current?.overrideCount ?? 0) + (current?.extraCount ?? 0) +
        (current?.toolDenyCount ?? 0)
      const canResetPreset = currentSource !== 'none' || currentCount > 0

      return h('div', null,
        h('div', { style: css.notice }, `预设保存官方覆盖、新增段与工具开关；正文仍由文本库提供。上限 ${limit} 个，可在设置里调整。`),
        data.session.draft
          ? h('div', { style: css.warnNotice }, '模板与保存预设属于全局操作，会立即保存；当前窗口的映射与来源预设暂存草稿，首次对话后提交。')
          : null,

        h('div', { style: css.card },
          h('div', { style: css.cardHead },
            h('strong', { style: { fontSize: '12.5px' } }, '当前预设'),
            currentBadge,
            current?.modified ? badge('已修改', PALETTE.warn) : null),
          h('div', { style: css.desc }, currentLabel),
          h('div', { style: { ...css.hint, padding: '0 10px 8px' } },
            `覆盖 ${current?.overrideCount ?? Object.keys(data.session.overrides ?? {}).length} · 新增 ${current?.extraCount ?? 0} · 工具关闭 ${current?.toolDenyCount ?? 0}`,
            stats
              ? `　生效 ${stats.active} · 挂起 ${stats.suspended} · 失效 ${stats.orphan}${stats.pending > 0 ? ` · 待确认 ${stats.pending}` : ''}${stats.blocked > 0 ? ` · 不生效 ${stats.blocked}` : ''}`
              : ''),
          currentSource === 'missing'
            ? h('div', { style: { ...css.hint, color: PALETTE.danger, padding: '0 10px 8px' } }, '来源预设已被删除；当前配置仍然保留，可另存为新预设。')
            : null,
          canResetPreset && !locked
            ? h('div', { style: { padding: '0 10px 10px' } },
              h('button', {
                style: { ...css.button, ...css.tiny, ...css.danger },
                onClick: () => setConfirmReset(true)
              }, '恢复默认配置'))
            : null),

        h('div', { style: { display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' } },
          h('input', { style: { ...css.input, flex: '1 1 140px' }, placeholder: '新预设名称', value: presetName, onChange: (e) => setPresetName(e.target.value) }),
          h('button', {
            style: { ...css.button, ...css.primary },
            onClick: () => run(call('preset.capture', { sessionId, name: presetName || '未命名预设' }).then((next) => {
              setPresetName('')
              return next
            }))
          }, '保存当前配置为预设')),

        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '6px' } },
          h('strong', { style: { fontSize: '12.5px' } }, '已保存的预设'),
          h('span', { style: css.hint }, `已用 ${data.limits.presetCount} / ${limit}`)),

        data.presets.length === 0 ? h('div', { style: css.hint }, '还没有预设。') : null,
        data.presets.map((preset) => {
          const isApplied = preset.id === appliedId
          return h('div', { key: preset.id, style: css.card },
            h('div', { style: css.cardHead },
              isApplied ? h('span', { style: { ...css.dockDot, marginRight: '2px' } }) : null,
              h('span', { style: css.name }, preset.name),
              h('span', { style: { ...css.hint, marginLeft: 'auto' } },
                `覆盖 ${preset.fragmentIds.length} · 新增 ${preset.extras.length} · 工具 ${preset.toolPolicy.deny.length}`)),
            isApplied
              ? h('div', { style: { ...css.desc, color: PALETTE.ok } },
                `正在使用`,
                stats
                  ? `　生效 ${stats.active} · 挂起 ${stats.suspended} · 失效 ${stats.orphan}${stats.pending > 0 ? ` · 待确认 ${stats.pending}` : ''}${stats.blocked > 0 ? ` · 不生效 ${stats.blocked}` : ''}`
                  : '')
              : null,
            h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap' } },
              locked ? null : h('button', {
                style: { ...css.button, ...css.tiny, ...(isApplied ? {} : css.primary) },
                onClick: () => void applyPreset(preset)
              }, isApplied ? '重新应用' : '应用'),
              h('button', { style: { ...css.button, ...css.tiny, ...css.danger }, onClick: () => void askDelete(preset) }, '删除')))
        }),

        deleteTarget
          ? h(ConfirmDialog, {
            title: '删除已保存的预设？',
            message: `删除后，当前配置仍保留，但以下 ${deleteTarget.usage.count} 个会话/草稿会显示“来源预设已删除”。`,
            confirmLabel: '删除预设',
            danger: true,
            onCancel: () => setDeleteTarget(null),
            onConfirm: () => {
              const target = deleteTarget
              setDeleteTarget(null)
              run(call('preset.delete', { sessionId, id: target.preset.id, force: true }))
            }
          },
          deleteTarget.usage.count === 0
            ? h('div', { style: css.hint }, '当前没有会话或草稿使用这个预设。')
            : h('div', { style: { ...css.hint, fontFamily: PALETTE.mono, marginTop: '6px' } },
              deleteTarget.usage.sessions.map((entry) => h('div', { key: entry.id },
                `会话 ${entry.id === sessionId ? `${entry.id.slice(0, 12)}（本会话）` : entry.id}${entry.draft ? '（草稿窗口）' : `（${SESSION_STATUS[entry.status] ?? entry.status}）`}`))))
          : null,

        confirmReset
          ? h(ConfirmDialog, {
            title: '恢复默认配置？',
            message: '将清空本会话正在应用的官方覆盖、新增段与工具开关，并回到不使用预设的状态。已保存的预设和文本库不会被删除。',
            confirmLabel: '恢复默认配置',
            danger: true,
            onCancel: () => setConfirmReset(false),
            onConfirm: () => {
              setConfirmReset(false)
              run(call('session.reset', { sessionId }))
            }
          })
          : null
      )
    }

    // ----------------------------------------------------------- backup tab
    function BackupTab ({ sessionId, data, refresh, setError, setToast }) {
      const locked = data.session.locked === true
      const [label, setLabel] = useState('')
      const [restoreTarget, setRestoreTarget] = useState(null)
      const run = async (promise) => {
        try {
          const next = await promise
          if (next) refresh(next)
        } catch (error) {
          setError(String(error.message || error))
        }
      }
      const restore = async (file) => {
        try {
          const next = await call('backup.restore', { sessionId, file })
          refresh(next)
          const restored = next?.restored
          if (typeof setToast === 'function') {
            if (restored) {
              setToast(`已恢复：映射 ${restored.mapped} · 重建 ${restored.recreated} · 无法恢复 ${restored.unresolved + (restored.textUnresolved ?? 0)}`)
            } else {
              setToast('已恢复')
            }
          }
        } catch (error) {
          setError(String(error.message || error))
        }
      }
      const section = (title, list, limit, note) => h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', margin: '4px 0 6px' } },
          h('strong', { style: { fontSize: '12.5px' } }, title),
          h('span', { style: css.hint }, `${list.length} / ${limit}`)),
        h('div', { style: { ...css.hint, marginBottom: '6px' } }, note),
        list.length === 0 ? h('div', { style: { ...css.hint, marginBottom: '10px' } }, '暂无。') : null,
        list.map((entry) => h('div', { key: entry.file, style: css.card },
          h('div', { style: css.cardHead },
            h('span', { style: { ...css.name, fontFamily: PALETTE.mono } }, new Date(entry.at || 0).toLocaleString()),
            badge('v3 会话快照', PALETTE.dim),
            h('span', { style: { ...css.hint, marginLeft: 'auto' } },
              `${entry.overrides} 覆盖 · ${entry.extras} 新增 · ${entry.toolDeny ?? 0} 工具`)),
          h('div', { style: { ...css.desc } }, entry.label || '（无标签）'),
          locked ? null : h('div', { style: { padding: '0 10px 10px' } },
            h('button', {
              style: { ...css.button, ...css.tiny },
              onClick: () => setRestoreTarget(entry)
            }, '恢复到这份'))))
      )

      const current = data.session.currentPreset ?? {}
      if (data.session.draft) {
        return h('div', null,
          h('div', { style: css.notice },
            '草稿窗口不写持久备份。发送第一条消息时会自动提交，并生成第一份自动快照；这份快照才会出现在备份页。'))
      }

      return h('div', null,
        h('div', { style: css.notice }, '每次写入前会自动留一份会话快照；手动备份单独计数。恢复只还原提示词段、新增段与工具开关，不记录也不还原预设页。'),
        locked
          ? h('div', { style: css.notice }, '当前会话首轮已开始，提示词已锁定；本会话备份已自动删除，恢复功能关闭。')
          : h('div', { style: { display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' } },
            h('input', { style: { ...css.input, flex: '1 1 140px' }, placeholder: '手动备份备注（可选）', value: label, onChange: (e) => setLabel(e.target.value) }),
            h('button', {
              style: { ...css.button, ...css.primary },
              onClick: () => run(call('backup.create', { sessionId, label }).then((next) => {
                setLabel('')
                return next
              }))
            }, '手动备份')),
        section('手动备份', data.backups.manual, data.limits.manualBackupLimit, '手动备份的快照，默认保留 5 份。'),
        section('自动快照', data.backups.auto, data.limits.autoBackupLimit, '每次保存/恢复前自动写入，默认保留 20 份。'),

        restoreTarget !== null
          ? h(ConfirmDialog, {
            title: '恢复这份会话备份？',
            message: '只恢复提示词段、新增段与工具开关；不会恢复预设库，也不会恢复“当前使用的预设”记录。恢复后预设页显示为手工配置。',
            confirmLabel: '恢复会话配置',
            danger: true,
            onCancel: () => setRestoreTarget(null),
            onConfirm: () => {
              const file = restoreTarget.file
              setRestoreTarget(null)
              restore(file)
            }
          },
          h('div', { style: { ...css.hint, marginTop: '6px', fontFamily: PALETTE.mono } },
            `当前：覆盖 ${current.overrideCount ?? 0} · 新增 ${current.extraCount ?? 0} · 工具 ${current.toolDenyCount ?? 0}`,
            h('div', null,
              `备份：覆盖 ${restoreTarget.overrides} · 新增 ${restoreTarget.extras} · 工具 ${restoreTarget.toolDeny ?? 0}`)))
          : null
      )
    }

    // --------------------------------------------------------- settings tab
    function SettingsTab ({ sessionId, data, refresh, setError, setToast }) {
      const [pathValue, setPathValue] = useState(data.meta.dataDir || '')
      const [presetLimit, setPresetLimit] = useState(String(data.limits.presetLimit))
      const [autoLimit, setAutoLimit] = useState(String(data.limits.autoBackupLimit))
      const [manualLimit, setManualLimit] = useState(String(data.limits.manualBackupLimit))
      const [fontScaleValue, setFontScaleValue] = useState(readFontScale())
      const [confirmReset, setConfirmReset] = useState(false)
      const [confirmCleanup, setConfirmCleanup] = useState(false)
      const [confirmWipe, setConfirmWipe] = useState(false)
      const [confirmPurge, setConfirmPurge] = useState(false)

      const run = async (promise, message) => {
        try {
          const next = await promise
          if (next) refresh(next)
          if (message) setToast(message)
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      // `config.set` returns settings, not a session snapshot. Refreshing the
      // panel with that object used to blank every field (data.session/meta
      // disappeared); fetch a real snapshot after saving instead.
      const saveConfig = async (patch, message) => {
        try {
          const result = await call('config.set', patch)
          const next = await call('state.get', { sessionId })
          refresh(next)
          if (result?.migration) setToast('已设置新位置；重启 DSH 时自动搬迁旧数据')
          else if (message) setToast(message)
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const cleanupOldData = async () => {
        try {
          await call('config.cleanupOldData')
          const next = await call('state.get', { sessionId })
          refresh(next)
          if (typeof setToast === 'function') setToast('旧数据已清理')
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const purgeArchived = async () => {
        try {
          const result = await call('config.purgeArchived', {})
          const next = await call('state.get', { sessionId })
          refresh(next)
          if (typeof setToast === 'function') setToast(`已删除 ${result?.count ?? 0} 个归档/失效会话的插件信息`)
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const wipeAllData = async () => {
        try {
          const next = await call('config.wipeAllData', { sessionId })
          refresh(next)
          try {
            const config = await call('config.get')
            setPathValue(config.defaultDataDir || '')
            setPresetLimit(String(config.settings.presetLimit))
            setAutoLimit(String(config.settings.autoBackupLimit))
            setManualLimit(String(config.settings.manualBackupLimit))
          } catch {
            /* the reset already happened; fields will refresh on reopen */
          }
          if (typeof setToast === 'function') setToast('已恢复初始状态；重启 DSH 后使用默认数据目录')
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const sourceText = data.meta.dataDirSource === 'patch'
        ? '来自 plugin 配置（cordis.patch.yml），面板不能改'
        : data.meta.dataDirSource === 'bootstrap'
          ? '来自你在面板里保存的设置'
          : '默认位置'
      const release = data.meta.release ?? {}
      const capturedCount = data.meta.lastCapture?.names?.length ?? data.prompt.lastCapture?.names?.length ?? null
      const pendingMigration = data.meta.pendingMigration ?? null
      const previousDataDir = data.meta.previousDataDir ?? null

      return h('div', null,
        h('div', { style: { ...css.hint, marginBottom: '8px' } },
          `分类基准 ${release.classifiedAgainst ?? '未知'} · 当前 ${release.version ?? '未知'} · 上次捕获 ${capturedCount === null ? '—' : `${capturedCount} 段`}`),
        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '存储位置')),
          h('div', { style: css.desc }, `当前：${data.meta.dataDir}`),
          h('div', { style: { ...css.desc, color: PALETTE.faint } }, sourceText),
          h('div', { style: { padding: '0 10px 10px' } },
            data.meta.dataDirSource === 'patch'
              ? h('div', { style: css.hint }, '配置里写了 dataDir，面板里的设置会被忽略。')
              : h('div', null,
                h('input', { style: { ...css.input, marginBottom: '6px' }, value: pathValue, spellCheck: false, placeholder: 'D:\\DSH-data\\prompt-lab', onChange: (e) => setPathValue(e.target.value) }),
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', {
                    style: { ...css.button, ...css.primary, ...css.tiny },
                    onClick: () => saveConfig({ dataDir: pathValue }, '已保存')
                  }, '保存'),
                  h('button', {
                    style: { ...css.button, ...css.tiny },
                    onClick: () => saveConfig({ dataDir: data.meta.bootstrapDir }, '已恢复默认')
                  }, '恢复默认')),
                h('div', { style: { ...css.hint, marginTop: '6px' } }, '改路径不会立即搬运；重启 DSH 时自动复制 library/sessions/drafts 到新目录。旧数据会保留，可在迁移卡片里清理。工作区内的路径会被拒绝。')))),

        h('div', { style: css.card },
          h('div', { style: css.cardHead },
            h('strong', { style: { fontSize: '12.5px' } }, '面板字号'),
            h('span', { style: { ...css.hint, marginLeft: 'auto' } }, '只影响 Prompt Lab')),
          h('div', { style: { ...css.hint, padding: '0 10px 6px' } }, '调整面板正文、按钮、标签和代码块的字号；DSH 其他界面不受影响。'),
          h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap' } },
            ['标准 100%', '较大 110%', '大 125%', '特大 140%'].map((label, index) => {
              const scale = FONT_SCALES[index]
              return h('button', {
                key: label,
                style: { ...css.button, ...css.tiny, ...(fontScaleValue === scale ? css.primary : {}) },
                onClick: () => {
                  applyFontScale(scale)
                  setFontScaleValue(scale)
                }
              }, label)
            }))),

        pendingMigration || previousDataDir
          ? h('div', { style: css.card },
            h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '存储迁移')),
            pendingMigration
              ? h('div', { style: css.notice },
                `新位置：${pendingMigration.to}`,
                h('div', { style: { ...css.hint, marginTop: '4px' } }, '重启 DSH 时自动搬迁；当前仍使用旧目录。迁移完成后旧目录保留，可在这里清理。'),
                data.meta.dataDirSource === 'patch'
                  ? null
                  : h('div', { style: { marginTop: '8px' } },
                    h('button', {
                      style: { ...css.button, ...css.tiny },
                      onClick: () => saveConfig({ dataDir: data.meta.dataDir }, '已取消待执行的迁移')
                    }, '取消搬迁')))
              : null,
            previousDataDir
              ? h('div', { style: { padding: '0 10px 10px' } },
                h('div', { style: { ...css.hint, marginBottom: '6px' } }, `旧数据目录：${previousDataDir}`),
                h('button', {
                  style: { ...css.button, ...css.tiny, ...css.danger },
                  onClick: () => setConfirmCleanup(true)
                }, '清理旧数据'))
              : null)
          : null,

        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '数量上限')),
          h('div', { style: { padding: '0 10px 10px' } },
            h('div', { style: { ...css.hint, marginBottom: '4px' } }, `预设上限（1–200，当前 ${data.limits.presetCount} 个）`),
            h('input', { style: { ...css.input, marginBottom: '8px' }, value: presetLimit, onChange: (e) => setPresetLimit(e.target.value) }),
            h('div', { style: { ...css.hint, marginBottom: '4px' } }, '自动快照上限（1–500）'),
            h('input', { style: { ...css.input, marginBottom: '8px' }, value: autoLimit, onChange: (e) => setAutoLimit(e.target.value) }),
            h('div', { style: { ...css.hint, marginBottom: '4px' } }, '手动备份上限（1–500，独立计数）'),
            h('input', { style: { ...css.input, marginBottom: '8px' }, value: manualLimit, onChange: (e) => setManualLimit(e.target.value) }),
            h('button', {
              style: { ...css.button, ...css.primary, ...css.tiny },
              onClick: () => saveConfig({
                presetLimit: Number(presetLimit),
                autoBackupLimit: Number(autoLimit),
                manualBackupLimit: Number(manualLimit)
              }, '上限已保存')
            }, '保存上限'),
            h('div', { style: { ...css.hint, marginTop: '6px' } }, '改小上限不会立刻删文件，下一次写入时按新上限清理。'))),

        data.meta.warnings.length > 0
          ? h('div', { style: css.warnNotice }, h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '存储告警'),
            data.meta.warnings.map((warning, index) => h('div', { key: index }, warning)))
          : null,

        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '归档会话清理')),
          h('div', { style: css.desc }, '删除已归档或已不存在会话的插件快照、配置、备份和装配记录；不删除全局片段库、预设和设置。'),
          h('div', { style: { padding: '0 10px 10px' } },
            h('button', {
              style: { ...css.button, ...css.tiny, ...css.danger },
              onClick: () => setConfirmPurge(true)
            }, '删除归档会话插件信息'))),

        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '当前会话')),
          h('div', { style: css.desc }, '清除本会话的全部覆盖与新增段。片段库、预设和备份不动。'),
          data.session.locked === true
            ? h('div', { style: { ...css.hint, padding: '0 10px 10px' } }, '首轮已开始，提示词已锁定；清除覆盖已禁用。')
            : h('div', { style: { padding: '0 10px 10px' } },
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => setConfirmReset(true)
              }, '清除本会话覆盖'))),

        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '危险操作')),
          h('div', { style: css.desc }, '删除当前数据目录下的片段库、已保存预设、所有会话覆盖/新增段与备份、草稿、设置，将插件恢复至最初状态；旧迁移目录需单独清理。'),
          h('div', { style: { padding: '0 10px 10px' } },
            h('button', {
              style: { ...css.button, ...css.danger, ...css.tiny },
              onClick: () => setConfirmWipe(true)
            }, '清除本插件的全部数据'))),

        h('div', { style: { ...css.hint, marginTop: '4px' } },
          h('div', null, '只作用于显式开启的单个会话；未开启的会话走官方装配。'),
          h('div', null, '不修改会话日志。'),
          h('div', null, '提示词会影响 agent 的真实动作（工具调用、文件写入、网络请求），部分操作可能会导致当前会话出错无法正常加载，本插件不承担这部分后果。')),

        confirmReset
          ? h(ConfirmDialog, {
            title: '清除本会话覆盖？',
            message: '将清空本会话的全部覆盖与新增段；片段库和备份不会被删除。',
            confirmLabel: '清除',
            danger: false,
            onCancel: () => setConfirmReset(false),
            onConfirm: () => {
              setConfirmReset(false)
              run(call('session.reset', { sessionId }), '已清除')
            }
          })
          : null,

        confirmCleanup
          ? h(ConfirmDialog, {
            title: '清理旧数据？',
            message: `将删除旧目录 ${previousDataDir || '（未知）'} 下的 library、sessions、drafts。插件配置 config.json 会保留；此操作不可撤销。`,
            confirmLabel: '清理旧数据',
            danger: true,
            onCancel: () => setConfirmCleanup(false),
            onConfirm: () => {
              setConfirmCleanup(false)
              cleanupOldData()
            }
          })
          : null,

        confirmPurge
          ? h(ConfirmDialog, {
            title: '删除归档会话插件信息？',
            message: '将删除已归档或已不存在会话的提示词快照、会话配置、备份和装配记录。全局片段库、预设和设置不受影响；此操作不可撤销。',
            confirmLabel: '删除归档信息',
            danger: true,
            onCancel: () => setConfirmPurge(false),
            onConfirm: () => {
              setConfirmPurge(false)
              purgeArchived()
            }
          })
          : null,

        confirmWipe
          ? h(ConfirmDialog, {
            title: '清除本插件的全部数据？',
            message: '将删除当前数据目录下的片段库、已保存预设、所有会话覆盖/新增段与备份、草稿、设置，将插件恢复至最初状态；旧迁移目录需单独清理；此操作不可撤销。',
            confirmLabel: '全部清除',
            danger: true,
            onCancel: () => setConfirmWipe(false),
            onConfirm: () => {
              setConfirmWipe(false)
              wipeAllData()
            }
          })
          : null
      )
    }

    // ---------------------------------------------------------- library tab
    const SESSION_STATUS = {
      live: '运行中',
      archived: '已归档，可恢复',
      saved: '已保存',
      missing: '会话不存在',
      unknown: '状态未知',
      draft: '草稿窗口'
    }
    function LibraryTab ({ sessionId, data, refresh, setError, setToast }) {
      const [sub, setSub] = useState('sections')
      const [list, setList] = useState(null)
      const [openId, setOpenId] = useState(null)
      const [confirming, setConfirming] = useState(null)
      const [renaming, setRenaming] = useState(null)
      const [renameValue, setRenameValue] = useState('')
      const [creating, setCreating] = useState(false)
      const [newKey, setNewKey] = useState('custom:note')
      const [newLabel, setNewLabel] = useState('')
      const [newText, setNewText] = useState('')
      const [inserting, setInserting] = useState(null)
      const [insertName, setInsertName] = useState('')
      const [insertAnchor, setInsertAnchor] = useState('__end__')
      const [editingText, setEditingText] = useState(null)
      const [editText, setEditText] = useState('')

      const load = useCallback(async () => {
        try {
          setList(await call('library.list', { sessionId }))
        } catch (error) {
          setError(String(error.message || error))
        }
      }, [sessionId, setError])

      useEffect(() => {
        load()
      }, [load])

      const remove = async (fragment, cascade) => {
        try {
          const next = await call('fragment.delete', { sessionId, id: fragment.id, cascade })
          if (next) refresh(next)
          if (typeof setToast === 'function') {
            setToast(next?.deleted?.draftReferenced
              ? '已删除片段；当前窗口的草稿映射也引用了它，已标为失效'
              : '已删除片段')
          }
          setConfirming(null)
          setOpenId(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const askDelete = (fragment) => {
        setConfirming(fragment.id)
      }

      const rows = list?.fragments ?? []
      const usageText = (fragment) => {
        const usage = fragment.usage ?? { sessions: [], drafts: [], presets: [] }
        const total = usage.sessions.length + (usage.drafts ?? []).length + usage.presets.length
        if (total === 0) return '未被引用'
        return `会话 ${usage.sessions.length} · 草稿 ${(usage.drafts ?? []).length} · 预设 ${usage.presets.length}`
      }

      const startRename = (fragment) => {
        setRenaming(fragment.id)
        setRenameValue(fragment.label || '默认')
      }

      const renameTemplate = async (fragment) => {
        const next = renameValue.trim()
        if (next === '') {
          setError('模板名称不能为空')
          return
        }
        try {
          const value = await call('fragment.rename', { sessionId, id: fragment.id, label: next })
          if (value) refresh(value)
          if (typeof setToast === 'function') setToast('已重命名')
          setRenaming(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const createText = async () => {
        if (newText.trim() === '') {
          setError('段文本不能为空')
          return
        }
        try {
          const value = await call('sectionText.create', {
            sessionId,
            key: newKey,
            label: newLabel,
            text: newText
          })
          if (value) refresh(value)
          if (typeof setToast === 'function') setToast('已保存段文本')
          setCreating(false)
          setNewText('')
          setNewLabel('')
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const startInsert = (fragment) => {
        setInserting(fragment.id)
        setInsertName(fragment.key)
        setInsertAnchor('__end__')
      }

      const confirmInsert = async (fragment) => {
        try {
          const value = await call('sectionText.insert', {
            sessionId,
            id: fragment.id,
            name: insertName,
            anchor: insertAnchor
          })
          if (value) refresh(value)
          if (typeof setToast === 'function') {
            setToast(value?.session?.draft
              ? '已插入到草稿；发送第一条消息后提交'
              : '已插入到当前会话')
          }
          setInserting(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const startEditText = async (fragment) => {
        if (editingText === fragment.id) {
          setEditingText(null)
          return
        }
        try {
          const entry = await call('sectionText.get', { id: fragment.id })
          setEditText(typeof entry.text === 'string' ? entry.text : '')
          setEditingText(fragment.id)
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const saveText = async (fragment) => {
        if (editText.trim() === '') {
          setError('段文本不能为空')
          return
        }
        try {
          const value = await call('sectionText.update', { sessionId, id: fragment.id, text: editText })
          if (value) refresh(value)
          if (typeof setToast === 'function') setToast('已更新段文本')
          setEditingText(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const renderTemplate = (fragment) => {
        const usage = fragment.usage ?? { sessions: [], drafts: [], presets: [] }
        const persistentSessions = usage.sessions.filter((entry) =>
          typeof entry === 'string' || entry.status !== 'missing')
        const drafts = usage.drafts ?? []
        const referenced = persistentSessions.length > 0 || drafts.length > 0 || usage.presets.length > 0
        return h('div', { key: fragment.id, style: { ...css.card, marginBottom: '6px' } },
          h('div', { style: css.cardHead },
            h('span', { style: css.name, title: fragment.key }, fragment.label || '默认'),
            badge(fragment.mode === 'empty' ? '置空' : '替换'),
            fragment.readOnly ? badge('只读', PALETTE.faint) : null,
            fragment.blocked === true
              ? badge('不生效', PALETTE.faint)
              : fragment.orphan === true ? badge('失效', PALETTE.danger) : null,
            h('span', { style: { ...css.hint, marginLeft: 'auto' } }, tok(fragment.tokens))),
          h('div', { style: css.desc },
            `${fragment.key}　·　${usageText(fragment)}　·　更新于 ${new Date(fragment.updatedAt || 0).toLocaleString()}`),
          h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap', alignItems: 'center' } },
            fragment.target === 'insert'
              ? null
              : h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => setOpenId(openId === fragment.id ? null : fragment.id)
              }, openId === fragment.id ? '收起正文' : '查看正文'),
            fragment.target === 'insert'
              ? h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => void startEditText(fragment)
              }, editingText === fragment.id ? '收起编辑' : '编辑正文')
              : null,
            fragment.insertable
              ? h('button', {
                style: { ...css.button, ...css.tiny, ...css.primary },
                onClick: () => startInsert(fragment)
              }, '插入到当前会话')
              : null,
            fragment.readOnly
              ? null
              : h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => startRename(fragment)
              }, '重命名'),
            h('button', {
              style: { ...css.button, ...css.tiny, ...css.danger },
              onClick: () => askDelete(fragment)
            }, '删除')),

          inserting === fragment.id
            ? h('div', { style: { padding: '0 10px 10px' } },
              h('div', { style: { ...css.hint, marginBottom: '4px' } }, '插入为当前会话的新增段：'),
              h('input', {
                style: { ...css.input, marginBottom: '4px' },
                value: insertName,
                spellCheck: false,
                onChange: (event) => setInsertName(event.target.value)
              }),
              h('select', {
                style: { ...css.input, marginBottom: '4px' },
                value: insertAnchor,
                onChange: (event) => setInsertAnchor(event.target.value)
              },
              h('option', { value: '__start__' }, '最前面'),
              h('option', { value: '__end__' }, '最后面'),
              (data.prompt.officialNames ?? []).map((name) => h('option', { key: name, value: name }, `在 ${name} 之后`))),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { style: { ...css.button, ...css.tiny, ...css.primary }, onClick: () => void confirmInsert(fragment) }, '插入'),
                h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setInserting(null) }, '取消')))
            : null,

          editingText === fragment.id
            ? h('div', { style: { padding: '0 10px 10px' } },
              h('div', { style: { ...css.hint, marginBottom: '4px' } }, '编辑库正文；引用它的会话会同步更新。'),
              h('textarea', {
                style: { ...css.textarea, minHeight: '100px' },
                value: editText,
                spellCheck: false,
                onChange: (event) => setEditText(event.target.value)
              }),
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                h('button', { style: { ...css.button, ...css.tiny, ...css.primary }, onClick: () => void saveText(fragment) }, '保存正文'),
                h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setEditingText(null) }, '取消')))
            : null,

          renaming === fragment.id
            ? h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap' } },
              h('input', {
                style: { ...css.input, flex: '1 1 160px' },
                value: renameValue,
                spellCheck: false,
                onChange: (event) => setRenameValue(event.target.value)
              }),
              h('button', { style: { ...css.button, ...css.tiny, ...css.primary }, onClick: () => renameTemplate(fragment) }, '保存名称'),
              h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setRenaming(null) }, '取消'))
            : null,

          openId === fragment.id && fragment.target !== 'insert'
            ? h('div', { style: { padding: '0 10px 10px' } },
              h('pre', {
                style: {
                  margin: 0,
                  maxHeight: '240px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: `1px solid ${PALETTE.line}`,
                  borderRadius: '8px',
                  background: PALETTE.bgField,
                  padding: '8px',
                  font: '11.5px/1.55 ' + PALETTE.mono
                }
              }, fragment.mode === 'empty' ? '（置空：保存后这一段从提示词中消失）' : (fragment.preview || '（空）')),
              fragment.mode !== 'empty' && fragment.tokens > 0
                ? h('div', { style: { ...css.hint, marginTop: '4px' } }, '只显示前 400 字符。')
                : null)
            : null,

          confirming === fragment.id
            ? h('div', { style: { margin: '0 10px 10px', border: `1px solid ${PALETTE.line}`, borderLeft: `3px solid ${referenced ? PALETTE.danger : PALETTE.warn}`, borderRadius: '8px', padding: '8px 10px', background: referenced ? PALETTE.dangerSoft : PALETTE.warnSoft } },
              h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, referenced ? '这个模板仍被引用' : '删除这个模板？'),
              h('div', { style: css.hint }, referenced
                ? (fragment.target === 'insert'
                  ? '删除后这些会话里的新增段会被移除，文本条目本身不能再恢复；请确认列表。'
                  : '删除后这些会话的对应段会回退到官方文本，预设中也会移除该片段。')
                : '这个模板未被任何会话或预设引用，删除后只会从文本库移除。'),
              referenced && usage.sessions.length > 0
                ? h('div', { style: { ...css.hint, fontFamily: PALETTE.mono, marginTop: '4px' } },
                  usage.sessions.map((entry) => {
                    const entryId = typeof entry === 'string' ? entry : entry.id
                    const status = typeof entry === 'string' ? null : (entry.draft ? 'draft' : entry.status)
                    const suffix = status ? `（${SESSION_STATUS[status] ?? status}）` : ''
                    return h('div', { key: entryId }, `会话 ${entryId === sessionId ? `${entryId.slice(0, 12)}（本会话）` : entryId}${suffix}`)
                  }))
                : null,
              referenced && drafts.length > 0
                ? h('div', { style: { ...css.hint, fontFamily: PALETTE.mono, marginTop: '4px' } },
                  drafts.map((entry) => h('div', { key: entry.id },
                    `草稿窗口 ${entry.id === sessionId ? `${entry.id.slice(0, 12)}（本窗口）` : entry.id}`)))
                : null,
              referenced && usage.presets.length > 0
                ? h('div', { style: { ...css.hint, marginTop: '4px' } }, `预设：${usage.presets.join('、')}`)
                : null,
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', justifyContent: 'flex-end' } },
                h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setConfirming(null) }, '取消'),
                h('button', {
                  style: { ...css.button, ...css.tiny, ...css.danger },
                  onClick: () => {
                    setConfirming(null)
                    remove(fragment, referenced)
                  }
                }, referenced ? '连带清理并删除' : '删除')))
            : null)
      }

      const keyOrder = new Map((list?.groups ?? []).map((group, index) => [group.key, index]))
      const buildGroups = (listRows, target) => {
        const map = new Map()
        for (const fragment of listRows) {
          let group = map.get(fragment.key)
          if (group === undefined) {
            group = {
              key: fragment.key,
              target,
              source: fragment.source,
              sensitivity: fragment.sensitivity,
              readOnly: fragment.readOnly,
              templateCount: 0,
              orphan: fragment.orphan,
              blocked: fragment.blocked,
              usage: { sessions: 0, drafts: 0, presets: 0 },
              _sessionIds: new Set(),
              _draftIds: new Set(),
              _presets: new Set(),
              templates: []
            }
            map.set(fragment.key, group)
          }
          group.templateCount += 1
          group.templates.push(fragment)
          for (const session of fragment.usage?.sessions ?? []) group._sessionIds.add(session.id)
          for (const draft of fragment.usage?.drafts ?? []) group._draftIds.add(draft.id)
          for (const preset of fragment.usage?.presets ?? []) group._presets.add(preset)
        }
        const result = [...map.values()]
        for (const group of result) {
          group.usage = {
            sessions: group._sessionIds.size,
            drafts: group._draftIds.size,
            presets: group._presets.size
          }
          delete group._sessionIds
          delete group._draftIds
          delete group._presets
        }
        result.sort((a, b) => {
          const left = keyOrder.get(a.key)
          const right = keyOrder.get(b.key)
          const lo = left === undefined ? Number.MAX_SAFE_INTEGER : left
          const ro = right === undefined ? Number.MAX_SAFE_INTEGER : right
          if (lo !== ro) return lo - ro
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
        })
        return result
      }

      const overrideGroups = buildGroups(rows.filter((fragment) => fragment.target !== 'insert'), 'override')
      const insertGroups = buildGroups(rows.filter((fragment) => fragment.target === 'insert'), 'insert')

      const renderGroup = (group) => h('div', {
        key: `${group.target}:${group.key}`,
        style: { ...css.card, marginBottom: '10px' }
      },
      h('div', { style: { ...css.cardHead, background: PALETTE.soft } },
        h('span', { style: css.name, title: group.key }, group.key),
        group.source ? badge(SOURCE[group.source].label, SOURCE[group.source].color) : null,
        group.sensitivity ? badge(TIER[group.sensitivity].label, TIER[group.sensitivity].color) : null,
        group.readOnly ? badge('只读', PALETTE.faint) : null,
        badge(`${group.templateCount} 个模板`),
        group.blocked === true
          ? badge('不生效', PALETTE.faint)
          : group.orphan === true ? badge('失效', PALETTE.danger) : null,
        h('span', { style: { ...css.hint, marginLeft: 'auto' } },
          `会话 ${group.usage.sessions} · 草稿 ${group.usage.drafts} · 预设 ${group.usage.presets}`)),
      h('div', { style: { padding: '8px 10px 2px' } }, group.templates.map(renderTemplate)))

      return h('div', null,
        h('div', { style: { display: 'flex', gap: '4px', marginBottom: '8px' } },
          h('button', {
            style: { ...css.tab, ...(sub === 'sections' ? css.tabActive : {}) },
            onClick: () => setSub('sections')
          }, '段文本'),
          h('button', {
            style: { ...css.tab, ...(sub === 'messages' ? css.tabActive : {}) },
            onClick: () => setSub('messages')
          }, '消息文本')),
        sub === 'messages'
          ? h(MessageTextLibrary, { sessionId, refresh, setError, setToast })
          : h('div', null,
        h('div', { style: css.notice }, '段文本按段保存、可跨会话复用。同一个段名可以有多个模板；官方段模板用于覆盖，新增段文本可以插入为当前会话的新增段。删除仍被引用的文本会连带清理会话引用。'),
        h('div', { style: { ...css.hint, marginBottom: '8px' } }, '文本库是全局的：草稿窗口里新增/修改的文本也会立即出现在这里。草稿只暂存窗口映射与启用状态。'),
        list?.completeActive
          ? h('div', { style: { ...css.hint, color: PALETTE.faint, marginBottom: '8px' } }, '当前会话使用完整提示词：这些模板都处于「不生效」状态，不是失效。')
          : null,

        rows.length === 0 ? h('div', { style: css.hint }, '段文本库还是空的。') : null,

        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '10px 0 6px' } },
          h('strong', { style: { fontSize: '13px' } }, '官方段模板'),
          badge(String(overrideGroups.length), PALETTE.dim),
          h('span', { style: css.hint }, '通过改写/置空官方段保存；选择后映射到官方段。')),
        overrideGroups.length === 0
          ? h('div', { style: { ...css.hint, marginBottom: '8px' } }, '还没有官方段模板。')
          : overrideGroups.map(renderGroup),

        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '16px 0 6px' } },
          h('strong', { style: { fontSize: '13px' } }, '新增段文本'),
          badge(String(insertGroups.length), PALETTE.dim),
          h('span', { style: css.hint }, '通过新建段/新增段保存；可插入到当前会话为常驻段。')),
        h('div', { style: { display: 'flex', gap: '6px', margin: '8px 0' } },
          h('button', {
            style: { ...css.button, ...css.tiny, ...css.primary },
            onClick: () => setCreating((value) => !value)
          }, creating ? '收起新建' : '＋ 新建段文本')),

        creating
          ? h('div', { style: { ...css.card, padding: '10px', marginBottom: '10px' } },
            h('div', { style: { ...css.hint, marginBottom: '4px' } }, '段名（新增段文本可插入当前会话）'),
            h('input', {
              style: { ...css.input, marginBottom: '6px' },
              value: newKey,
              spellCheck: false,
              onChange: (event) => setNewKey(event.target.value)
            }),
            h('input', {
              style: { ...css.input, marginBottom: '6px' },
              value: newLabel,
              spellCheck: false,
              placeholder: '名称（可留空自动命名）',
              onChange: (event) => setNewLabel(event.target.value)
            }),
            h('textarea', {
              style: { ...css.textarea, minHeight: '100px' },
              value: newText,
              spellCheck: false,
              placeholder: '段文本正文…',
              onChange: (event) => setNewText(event.target.value)
            }),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
              h('button', { style: { ...css.button, ...css.primary }, disabled: newText.trim() === '', onClick: () => void createText() }, '保存段文本'),
              h('button', { style: css.button, onClick: () => setCreating(false) }, '取消')))
          : null,

        insertGroups.length === 0
          ? h('div', { style: { ...css.hint, marginBottom: '8px' } }, '还没有新增段文本。')
          : insertGroups.map(renderGroup)
      ))
    }

    function MessageTextLibrary ({ sessionId, refresh, setError, setToast }) {
      const [list, setList] = useState(null)
      const [filter, setFilter] = useState('')
      const [openId, setOpenId] = useState(null)
      const [confirming, setConfirming] = useState(null)
      const [editingId, setEditingId] = useState(null)
      const [editLabel, setEditLabel] = useState('')
      const [editingTextId, setEditingTextId] = useState(null)
      const [editTextValue, setEditTextValue] = useState('')
      const [creating, setCreating] = useState(false)
      const [newLabel, setNewLabel] = useState('')
      const [newText, setNewText] = useState('')

      const load = useCallback(async () => {
        try {
          setList(await call('messages.text.list', { sessionId }))
        } catch (error) {
          setError(String(error.message || error))
        }
      }, [sessionId, setError])

      useEffect(() => {
        load()
      }, [load])

      const entries = (list?.entries ?? []).filter((entry) => {
        const needle = filter.trim().toLowerCase()
        if (needle === '') return true
        return entry.label.toLowerCase().includes(needle) || entry.text.toLowerCase().includes(needle)
      })

      const save = async (id, labelValue, textValue) => {
        if (textValue.trim() === '') {
          setError('消息文本不能为空')
          return
        }
        try {
          const value = await call('messages.text.save', {
            sessionId,
            id: id ?? undefined,
            label: labelValue,
            text: textValue
          })
          if (value) refresh(value)
          if (typeof setToast === 'function') setToast(id ? '已更新消息文本' : '已保存消息文本')
          setCreating(false)
          setNewText('')
          setNewLabel('')
          setEditingId(null)
          setEditingTextId(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const rename = async (entry, nextLabel) => {
        const value = nextLabel.trim()
        if (value === '') {
          setError('名称不能为空')
          return
        }
        try {
          const next = await call('messages.text.save', {
            sessionId,
            id: entry.id,
            label: value,
            text: entry.text
          })
          if (next) refresh(next)
          setEditingId(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      const remove = async (entry) => {
        try {
          const value = await call('messages.text.delete', { sessionId, id: entry.id })
          if (value) refresh(value)
          if (typeof setToast === 'function') setToast('已删除消息文本')
          setConfirming(null)
          setOpenId(null)
          await load()
        } catch (error) {
          setError(String(error.message || error))
        }
      }

      return h('div', null,
        h('div', { style: css.notice }, '消息文本是全局库，可被消息管理的四个文本框插入；发送追加/预填充消息时，若库中没有相同文本会自动存入。消息文本不进入预设或备份。'),
        h('div', { style: { display: 'flex', gap: '6px', margin: '8px 0', flexWrap: 'wrap' } },
          h('input', {
            style: { ...css.input, flex: '1 1 160px' },
            value: filter,
            spellCheck: false,
            placeholder: '过滤名称或正文…',
            onChange: (event) => setFilter(event.target.value)
          }),
          h('button', {
            style: { ...css.button, ...css.tiny, ...css.primary },
            onClick: () => setCreating((value) => !value)
          }, creating ? '收起新建' : '＋ 新建消息文本')),

        creating
          ? h('div', { style: { ...css.card, padding: '10px', marginBottom: '10px' } },
            h('input', {
              style: { ...css.input, marginBottom: '6px' },
              value: newLabel,
              spellCheck: false,
              placeholder: '名称（可留空自动命名）',
              onChange: (event) => setNewLabel(event.target.value)
            }),
            h('textarea', {
              style: { ...css.textarea, minHeight: '100px' },
              value: newText,
              spellCheck: false,
              placeholder: '消息文本正文…',
              onChange: (event) => setNewText(event.target.value)
            }),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } },
              h('button', { style: { ...css.button, ...css.primary }, onClick: () => void save(null, newLabel, newText) }, '保存消息文本'),
              h('button', { style: css.button, onClick: () => setCreating(false) }, '取消')))
          : null,

        entries.length === 0 ? h('div', { style: css.hint }, '消息文本库还是空的。') : null,

        entries.map((entry) => {
          return h('div', { key: entry.id, style: { ...css.card, marginBottom: '6px' } },
            h('div', { style: css.cardHead },
              h('span', { style: css.name }, entry.label || '默认'),
              badge(`${entry.tokens} tok`, PALETTE.faint),
              h('span', { style: { ...css.hint, marginLeft: 'auto' } },
                new Date(entry.updatedAt || 0).toLocaleString())),
            h('div', { style: css.desc }, entry.preview || '（空）'),
            h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px', flexWrap: 'wrap' } },
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => setOpenId(openId === entry.id ? null : entry.id)
              }, openId === entry.id ? '收起正文' : '查看正文'),
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => {
                  setEditingTextId(editingTextId === entry.id ? null : entry.id)
                  setEditTextValue(entry.text)
                }
              }, editingTextId === entry.id ? '收起编辑' : '编辑正文'),
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => {
                  setEditingId(entry.id)
                  setEditLabel(entry.label || '默认')
                }
              }, '重命名'),
              h('button', {
                style: { ...css.button, ...css.tiny, ...css.danger },
                onClick: () => setConfirming(entry.id)
              }, '删除')),

            editingId === entry.id
              ? h('div', { style: { display: 'flex', gap: '6px', padding: '0 10px 10px' } },
                h('input', {
                  style: { ...css.input, flex: '1 1 160px' },
                  value: editLabel,
                  spellCheck: false,
                  onChange: (event) => setEditLabel(event.target.value)
                }),
                h('button', { style: { ...css.button, ...css.tiny, ...css.primary }, onClick: () => void rename(entry, editLabel) }, '保存名称'),
                h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setEditingId(null) }, '取消'))
              : null,

            openId === entry.id
              ? h('pre', {
                style: {
                  margin: '0 10px 10px',
                  maxHeight: '240px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: `1px solid ${PALETTE.line}`,
                  borderRadius: '8px',
                  background: PALETTE.bgField,
                  padding: '8px',
                  font: '11.5px/1.55 ' + PALETTE.mono
                }
              }, entry.text || '（空）')
              : null,

            editingTextId === entry.id
              ? h('div', { style: { padding: '0 10px 10px' } },
                h('div', { style: { ...css.hint, marginBottom: '4px' } }, '编辑库正文；已发送的历史消息不受影响。'),
                h('textarea', {
                  style: { ...css.textarea, minHeight: '100px' },
                  value: editTextValue,
                  spellCheck: false,
                  onChange: (event) => setEditTextValue(event.target.value)
                }),
                h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
                  h('button', {
                    style: { ...css.button, ...css.tiny, ...css.primary },
                    onClick: () => void save(entry.id, entry.label, editTextValue)
                  }, '保存正文'),
                  h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setEditingTextId(null) }, '取消')))
              : null,

            confirming === entry.id
              ? h('div', { style: { margin: '0 10px 10px', border: `1px solid ${PALETTE.line}`, borderLeft: `3px solid ${PALETTE.warn}`, borderRadius: '8px', padding: '8px 10px', background: PALETTE.warnSoft } },
                h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, '删除这条消息文本？'),
                h('div', { style: css.hint }, '已发送的历史消息不受影响；删除只从消息文本库移除，之后需要重新输入。'),
                h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', justifyContent: 'flex-end' } },
                  h('button', { style: { ...css.button, ...css.tiny }, onClick: () => setConfirming(null) }, '取消'),
                  h('button', {
                    style: { ...css.button, ...css.tiny, ...css.danger },
                    onClick: () => void remove(entry)
                  }, '删除')))
              : null)
        }),
        list?.limits
          ? h('div', { style: { ...css.hint, color: PALETTE.faint, marginTop: '6px' } },
            `消息文本 ${entries.length} / ${list.limits.entries} 条；单条最长 ${list.limits.text} 字符。`)
          : null)
    }

    // ----------------------------------------------------------------- panel
    function PlaceholderTab ({ title, description, items }) {
      return h('div', { style: css.card },
        h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, title)),
        h('div', { style: css.desc }, description),
        h('div', { style: { ...css.hint, padding: '0 10px 10px' } },
          ...items.map((text, index) => h('div', { key: index }, `· ${text}`))),
        h('div', { style: { ...css.hint, color: PALETTE.faint, padding: '0 10px 12px' } },
          '这是 0.3.0 的页面占位；当前不会改动会话或生效。'))
    }

    function CapabilityTab ({ sessionId, data, refresh, setError, setToast }) {
      const [tools, setTools] = useState(null)
      const [busy, setBusy] = useState(false)
      const [showLocked, setShowLocked] = useState(false)

      const load = useCallback(async () => {
        try {
          setTools(await call('tools.list', { sessionId }))
        } catch (error) {
          setError(String(error.message || error))
        }
      }, [sessionId, setError])

      useEffect(() => {
        load()
      }, [load, data.session.enabled, data.session.committed])

      const toggle = async (tool) => {
        if (data.session.enabled !== true) {
          setError('先打开「对本会话生效」，工具开关才会应用。')
          return
        }
        if (tool.global === false && !tool.denied) {
          setError('这个工具由 agent preset/scoped 注册，当前面板不能控制。')
          return
        }
        setBusy(true)
        try {
          const current = new Set(tools?.policy?.deny ?? [])
          if (tool.denied) current.delete(tool.name)
          else current.add(tool.name)
          const next = await call('tools.set', { sessionId, deny: [...current] })
          refresh(next)
          setTools(next.tools ?? await call('tools.list', { sessionId }))
          if (typeof setToast === 'function') setToast(tool.denied ? `已启用 ${tool.name}` : `已关闭 ${tool.name}`)
        } catch (error) {
          setError(String(error.message || error))
        } finally {
          setBusy(false)
        }
      }

      if (tools === null) return h('div', { style: css.hint }, '读取工具列表…')

      const enabled = data.session.enabled === true
      const rows = tools.tools ?? []
      const editable = rows.filter((tool) => tool.global !== false)
      const locked = rows.filter((tool) => tool.global === false)

      const renderTool = (tool, isLocked) => h('div', {
        key: tool.name,
        style: { ...css.card, marginBottom: '6px', opacity: enabled && !isLocked ? 1 : 0.62 }
      },
      h('div', { style: css.cardHead },
        h('span', { style: css.name, title: tool.name }, tool.name),
        tool.denied ? badge('已关闭', PALETTE.warn) : badge('已开启', PALETTE.ok),
        isLocked ? badge('不可更改', PALETTE.faint) : null),
      tool.description
        ? h('div', { style: { ...css.hint, padding: '0 10px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '72px', overflow: 'hidden' } }, tool.description)
        : h('div', { style: { ...css.hint, padding: '0 10px 8px' } }, '当前工具列表中没有这个工具；策略会保留，工具出现后再应用。'),
      isLocked
        ? null
        : h('div', { style: { padding: '0 10px 10px', display: 'flex', justifyContent: 'flex-start' } },
          h('button', {
            style: { ...css.button, ...css.tiny },
            disabled: busy || !enabled,
            onClick: () => toggle(tool)
          }, tool.denied ? '启用' : '关闭')))

      return h('div', null,
        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '工具开关')),
          h('div', { style: { ...css.hint, padding: '0 10px 10px' } },
            !enabled ? '当前会话未开启「对本会话生效」，开关只保存配置，不会应用。' : null,
            !tools.hasAgent ? h('div', null, '当前没有 live agent；工具列表使用全局注册表，首轮对话后生效。') : null,
            tools.hasAgent ? h('div', null, '只对 global 工具生效；agent preset/scoped 工具仍由 preset 控制。') : null,
            data.session.completeActive ? h('div', null, 'complete 模式下 section 已整体消失；工具开关仍单独生效。') : null),
          editable.length === 0
            ? h('div', { style: css.hint }, '没有可更改的 global 工具。')
            : h('div', null, ...editable.map((tool) => renderTool(tool, false))),
          locked.length > 0
            ? h('div', { style: { marginTop: '8px' } },
              h('div', {
                style: { ...css.cardHead, cursor: 'pointer' },
                onClick: () => setShowLocked((value) => !value)
              },
              h('strong', { style: { fontSize: '12.5px' } }, `不可更改的工具（${locked.length}）`),
              h('button', {
                style: { ...css.button, ...css.tiny, marginLeft: 'auto' },
                onClick: (event) => {
                  event.stopPropagation()
                  setShowLocked((value) => !value)
                }
              }, showLocked ? '收起' : '展开')),
              showLocked ? h('div', { style: { marginTop: '6px' } }, ...locked.map((tool) => renderTool(tool, true))) : null)
            : null),
        h('div', { style: { ...css.hint, color: PALETTE.faint } },
          '能力设置当前只包含工具开关；其他能力未排期。'))
    }

    function PendingLockOverlay (props) {
      const sessionId = props?.sessionId
      const [pending, setPending] = useState(null)
      const [busy, setBusy] = useState(false)
      const refresh = useCallback(async () => {
        if (!sessionId) return
        try {
          setPending(await call('pending.status', { sessionId }))
        } catch {
          setPending(null)
        }
      }, [sessionId])

      useEffect(() => {
        refresh()
        const onChange = () => { void refresh() }
        window.addEventListener('prompt-lab:pending-changed', onChange)
        const timer = setInterval(refresh, 2000)
        return () => {
          window.removeEventListener('prompt-lab:pending-changed', onChange)
          clearInterval(timer)
        }
      }, [refresh])

      const locked = pending?.pending === true && pending?.locked !== false
      const overlayRef = React.useRef(null)
      useEffect(() => {
        if (!locked) return undefined
        const onKey = (event) => {
          event.preventDefault()
          event.stopImmediatePropagation()
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
        }
        window.addEventListener('keydown', onKey, true)
        try { overlayRef.current?.focus() } catch { /* focus is best-effort */ }
        return () => window.removeEventListener('keydown', onKey, true)
      }, [locked])

      if (!locked) return null
      const unlock = async () => {
        if (busy) return
        const first = window.confirm('解锁后未重启就发送消息，可能使本会话的 turn 编号不一致并损坏日志。确定解锁？')
        if (!first) return
        const second = window.confirm('再次确认：即使解锁，也强烈建议立即通过任务栏完全重启 DSH。仍要解锁？')
        if (!second) return
        setBusy(true)
        try {
          setPending(await call('pending.unlock', { sessionId }))
          try { window.dispatchEvent(new Event('prompt-lab:pending-changed')) } catch { /* UI-only */ }
        } catch (error) {
          window.alert(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const content = h('div', {
        ref: overlayRef,
        tabIndex: -1,
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '10px',
          background: PALETTE.modalOverlay,
          backdropFilter: 'blur(2px)'
        }
      },
      h('div', { style: { ...css.card, maxWidth: '520px', padding: '12px' } },
        h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '本会话已锁定：需要重载'),
        h('div', { style: { ...css.hint, lineHeight: 1.5 } },
          '预填充/assistant 注入已写入。若未通过任务栏完全重启 DSH 就继续发送，turn 编号可能不一致。',
          h('div', { style: { marginTop: '4px' } }, `状态：${pending.status ?? 'unknown'}；类型：${pending.kind ?? 'unknown'}`)),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
          h('button', { style: { ...css.button, ...css.danger }, disabled: busy, onClick: unlock }, busy ? '解锁中…' : '解锁（需二次确认）'))))
      return typeof document !== 'undefined' && ReactDOM?.createPortal
        ? ReactDOM.createPortal(content, document.body)
        : content
    }

    function MessageTextPicker ({ entries, onReplace, onAppend, onClose }) {
      const [filter, setFilter] = useState('')
      const needle = filter.trim().toLowerCase()
      const visible = entries.filter((entry) => needle === '' ||
        entry.label.toLowerCase().includes(needle) ||
        entry.text.toLowerCase().includes(needle))
      return h('div', { style: { ...css.card, padding: '8px', marginTop: '6px' } },
        h('div', { style: { display: 'flex', gap: '6px', marginBottom: '6px' } },
          h('input', {
            style: { ...css.input, flex: '1 1 160px' },
            value: filter,
            spellCheck: false,
            placeholder: '过滤消息文本…',
            onChange: (event) => setFilter(event.target.value)
          }),
          h('button', { style: { ...css.button, ...css.tiny }, onClick: onClose }, '收起')),
        visible.length === 0
          ? h('div', { style: css.hint }, '消息文本库为空，或没有匹配项。')
          : h('div', { style: { maxHeight: '220px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } },
            visible.map((entry) => h('div', {
              key: entry.id,
              style: { border: `1px solid ${PALETTE.line}`, borderRadius: '6px', padding: '6px' }
            },
            h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
              h('span', { style: { fontWeight: 600, fontSize: '12px' } }, entry.label || '默认'),
              badge(`${entry.tokens} tok`, PALETTE.faint),
              h('span', { style: { flex: 1 } }),
              h('button', {
                style: { ...css.button, ...css.tiny, ...css.primary },
                onClick: () => onReplace(entry.text)
              }, '替换'),
              h('button', {
                style: { ...css.button, ...css.tiny },
                onClick: () => onAppend(entry.text)
              }, '追加')),
            h('div', { style: { ...css.hint, marginTop: '3px', whiteSpace: 'pre-wrap' } }, entry.preview)))))
    }

    function MessagesTab ({ sessionId, data, refresh, setError, setToast }) {
      const [value, setValue] = useState('')
      const [busy, setBusy] = useState(false)
      const [assistantText, setAssistantText] = useState('')
      const [assistantBusy, setAssistantBusy] = useState(false)
      const [messageEntries, setMessageEntries] = useState([])
      const [picker, setPicker] = useState(null)
      const [pickerBusy, setPickerBusy] = useState(false)

      const loadMessageTexts = useCallback(async () => {
        try {
          const next = await call('messages.text.list', { sessionId })
          setMessageEntries(next.entries ?? [])
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }, [sessionId, setError])

      useEffect(() => {
        loadMessageTexts()
      }, [loadMessageTexts])

      const saveMessageText = async (label, text) => {
        if (text.trim() === '') return
        setPickerBusy(true)
        try {
          const next = await call('messages.text.save', { sessionId, label, text })
          if (next) refresh(next)
          await loadMessageTexts()
          if (typeof setToast === 'function') setToast('已保存到消息文本库')
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setPickerBusy(false)
        }
      }

      const reload = async () => {
        try {
          const next = await call('state.get', { sessionId })
          if (typeof refresh === 'function') refresh(next)
          try { window.dispatchEvent(new Event('prompt-lab:pending-changed')) } catch { /* UI-only */ }
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }

      const append = async () => {
        if (value.trim() === '') return
        setBusy(true)
        try {
          const next = await call('messages.appendUser', { sessionId, text: value })
          if (next.ok !== true) {
            const reason = next.reason === 'not-idle'
              ? '当前会话正在运行，等本轮结束后再追加。'
              : next.reason === 'disabled'
                ? '先开启「对本会话生效」。'
                : next.reason === 'no-turn'
                  ? '首轮对话后才能追加消息。'
                  : `追加失败：${next.reason ?? 'unknown'}`
            setError(reason)
            return
          }
          setValue('')
          await reload()
          await loadMessageTexts()
          if (typeof setToast === 'function') setToast('已追加 user 表层消息')
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const appendAssistant = async () => {
        if (assistantText.trim() === '') return
        setAssistantBusy(true)
        try {
          const next = await call('messages.appendAssistant', { sessionId, text: assistantText })
          if (next.ok !== true) {
            const reason = next.reason === 'not-idle'
              ? '当前会话正在运行，等本轮结束后再追加。'
              : next.reason === 'disabled'
                ? '先开启「对本会话生效」。'
                : next.reason === 'no-turn'
                  ? '首轮对话后才能追加消息。'
                  : next.reason === 'no-model'
                    ? '当前会话没有可用的模型路由，不能追加 assistant。'
                    : `追加失败：${next.reason ?? 'unknown'}`
            setError(reason)
            return
          }
          setAssistantText('')
          await reload()
          await loadMessageTexts()
          if (typeof setToast === 'function') setToast('已写入；必须完全重启 DSH 后再使用本会话')
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setAssistantBusy(false)
        }
      }

      const enabled = data.session.enabled === true
      const canAppend = enabled && data.session.draft !== true
      const pending = data.session.pending
      const locked = pending?.pending === true && pending?.locked !== false
      const restartWarning = '必须重启：请通过任务栏完全退出 DSH 并重启；仅刷新页面会被锁定，未重启继续发送可能损坏本会话。'

      const pickerRow = (key, current, apply) => h('div', { style: { marginTop: '6px' } },
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            style: { ...css.button, ...css.tiny },
            onClick: () => setPicker(picker === key ? null : key)
          }, picker === key ? '收起消息文本库' : '消息文本库'),
          h('button', {
            style: { ...css.button, ...css.tiny },
            disabled: pickerBusy || current.trim() === '',
            onClick: () => void saveMessageText('', current)
          }, '保存当前消息文本')),
        picker === key
          ? h(MessageTextPicker, {
            entries: messageEntries,
            onReplace: (next) => apply(next, false),
            onAppend: (next) => apply(next, true),
            onClose: () => setPicker(null)
          })
          : null)

      return h('div', null,
        h('div', { style: css.card },
          h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '追加 user 表层消息')),
          h('div', { style: { ...css.hint, padding: '0 10px 6px' } }, '会作为真实 user 历史写入。'),
          h('textarea', {
            style: { ...css.textarea, minHeight: '80px' },
            value,
            disabled: !canAppend || locked,
            placeholder: canAppend ? '输入要追加的 user 表层消息…' : '开启会话并在首轮后可用',
            onChange: (event) => setValue(event.target.value)
          }),
          pickerRow('user', value, (next, append) => setValue((prev) =>
            append && prev ? `${prev}\n\n${next}` : next)),
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center' } },
            h('button', {
              style: { ...css.button, ...css.primary },
              disabled: busy || !canAppend || locked || value.trim() === '',
              onClick: append
            }, busy ? '写入中…' : '追加 user 表层消息'),
            h('span', { style: css.hint }, '首轮前不可用。'))),
        h('div', { style: { ...css.card, marginTop: '10px' } },
          h('div', { style: css.cardHead },
            h('strong', { style: { fontSize: '12.5px' } }, '追加 assistant 表层消息'),
            badge('特殊功能', PALETTE.warn)),
          h('div', { style: { ...css.hint, padding: '0 10px 6px' } },
            '会写入完整合成轮；模型会把它当成自己说过的话。'),
          h('textarea', {
            style: { ...css.textarea, minHeight: '80px' },
            value: assistantText,
            disabled: !canAppend || assistantBusy || locked,
            placeholder: canAppend ? '输入要追加的 assistant 表层消息…' : '开启会话并在首轮后可用',
            onChange: (event) => setAssistantText(event.target.value)
          }),
          pickerRow('assistant', assistantText, (next, append) => setAssistantText((prev) =>
            append && prev ? `${prev}\n\n${next}` : next)),
          h('div', { style: { ...css.warnNotice, margin: '8px 10px 0', borderLeftColor: PALETTE.danger } },
            restartWarning),
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', alignItems: 'center' } },
            h('button', {
              style: { ...css.button, ...css.primary },
              disabled: assistantBusy || !canAppend || locked || assistantText.trim() === '',
              onClick: appendAssistant
            }, assistantBusy ? '写入中…' : '追加 assistant 表层消息'),
            h('span', { style: css.hint }, '首轮前不可用。'))),
        pending?.pending === true
          ? h('div', { style: { ...css.warnNotice, marginTop: '10px', borderLeftColor: locked ? PALETTE.danger : PALETTE.warn } },
            `当前有未完成注入（${pending.kind ?? 'unknown'}），状态：${pending.status ?? 'unknown'}。${locked ? '会话已锁定，必须重启 DSH。' : '已解锁，但仍建议重启。'}`)
          : null)
    }

    function AssemblyTab ({ sessionId, data, cache, setCache }) {
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const current = cache?.sessionId === sessionId ? cache : null

      const formatBytes = (bytes) => {
        const value = Number(bytes) || 0
        if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
        if (value >= 1024) return `${Math.round(value / 1024)} KB`
        return `${value} B`
      }
      const formatLoadedAt = (value) => {
        try { return new Date(value).toLocaleTimeString() } catch { return '刚刚' }
      }
      const load = async () => {
        setLoading(true)
        setError('')
        try {
          const next = await call('assembly.overview', { sessionId })
          setCache({ sessionId, data: next, loadedAt: Date.now() })
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setLoading(false)
        }
      }
      const card = (key, title, summary, description) => h('div', { key, style: css.card },
        h('div', { style: { ...css.cardHead, alignItems: 'flex-start' } },
          h('strong', { style: { fontSize: '12.5px', flex: 1, minWidth: 0 } }, title),
          h('span', { style: { ...css.badge, marginLeft: 'auto', whiteSpace: 'nowrap' } }, summary)),
        h('div', { style: { ...css.desc, paddingTop: 0 } }, description))

      if (current === null) {
        return h('div', null,
          h('div', { style: css.card },
            h('div', { style: css.cardHead }, h('strong', { style: { fontSize: '12.5px' } }, '装配结构')),
            h('div', { style: css.desc }, '只读概览：列出组成当前会话请求的几大块。不会修改提示词、工具或会话记录。'),
            h('div', { style: css.hint, padding: '0 10px 6px' }, '初始不读取；点击一次后保留结果，可手动刷新。'),
            h('div', { style: { padding: '0 10px 12px' } },
              h('button', {
                style: { ...css.button, ...css.primary },
                disabled: loading,
                onClick: load
              }, loading ? '读取中…' : '加载当前装配'))),
          error ? h('div', { style: { ...css.warnNotice, marginTop: '10px', borderLeftColor: PALETTE.danger } }, error) : null)
      }

      const summary = current.data
      const system = summary?.systemPrompt ?? {}
      const tools = summary?.tools ?? {}
      const instructions = summary?.instructions ?? {}
      const history = summary?.history ?? {}
      const stale = summary?.structureHash && data?.session?.structureHash && summary.structureHash !== data.session.structureHash
      const systemSummary = summary?.completeActive
        ? `完整提示词 · 约 ${system.tokens ?? 0} tok`
        : `${system.sectionCount ?? 0} 段 · 约 ${system.tokens ?? 0} tok`
      const instructionSummary = instructions.available === false
        ? '不可用'
        : instructions.files > 0
          ? `${instructions.files} 个文件 · ${formatBytes(instructions.bytes)}`
          : '未找到'
      const historySummary = history.available ? `${history.count ?? 0} 条消息` : '会话未打开'
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: '13px' } }, '当前会话结构'),
          h('span', { style: { ...css.hint, marginLeft: 'auto' } }, `加载于 ${formatLoadedAt(current.loadedAt)}`),
          h('button', { style: { ...css.button, ...css.tiny }, disabled: loading, onClick: load }, loading ? '刷新中…' : '刷新')),
        error ? h('div', { style: { ...css.warnNotice, borderLeftColor: PALETTE.danger } }, error) : null,
        stale ? h('div', { style: css.warnNotice }, '会话结构已变化，当前是旧快照；点击「刷新」更新。') : null,
        card('system', '系统提示词', systemSummary,
          summary?.completeActive
            ? '当前使用 complete 完整提示词；普通分段装配不进入本轮请求。'
            : summary?.captured
              ? `身份、persona、计划/团队规则、工具说明等系统指令。覆盖 ${system.overrideCount ?? 0} 个，置空 ${system.emptyCount ?? 0} 个，新增 ${system.extraCount ?? 0} 个。`
              : '尚未采样到官方基线；请先在「提示词」页打开一次或发一条消息。'),
        card('tools', '工具 schema', `${tools.count ?? 0} 个 · ${tools.visible ?? 0} 可见`,
          `模型本轮可调用的工具定义；${tools.denied ? `本会话关闭 ${tools.denied} 个，` : ''}内容由 DSH 工具注册表提供。`),
        card('runtime', '运行时上下文', 'DSH 注入',
          '工作目录、沙箱、审批、时间等运行时事实；以会话上下文形式进入模型。'),
        card('instructions', '指令文件', instructionSummary,
          '工作目录链上的 AGENTS/CLAUDE 指令文件；只读。'),
        card('history', '会话历史', historySummary,
          '本会话已有的 user / assistant 消息；不含本轮尚未发送的输入。'),
        card('current', '当前输入', '本轮',
          '本轮用户输入和附件；由 DSH 直接送入请求。'))
    }

    function PanelView ({ sessionId, pane, onClose }) {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [tab, setTab] = useState('prompt')
      const [globalView, setGlobalView] = useState(null)
      const [loading, setLoading] = useState(false)
      const [toast, setToast] = useState('')
      const [assemblyCache, setAssemblyCache] = useState({ sessionId: null, data: null, loadedAt: 0 })
      const [, setFontRevision] = useState(0)
      const autoCapture = React.useRef({ sessionId: null, done: false })

      const load = useCallback(async () => {
        if (!sessionId) return
        setLoading(true)
        setError('')
        try {
          let value = await call('state.get', { sessionId })
          if (!value?.session || !value?.prompt) throw new Error('返回数据不完整；请重新打开面板。')
          if (!value?.prompt?.captured && !(autoCapture.current.sessionId === sessionId && autoCapture.current.done)) {
            autoCapture.current = { sessionId, done: true }
            let last = value
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const next = await call('assemble.capture', { sessionId })
                if (next) last = next
                if (last?.prompt?.captured || last?.capture?.ok === true) break
              } catch {
                /* keep the uncaptured snapshot and retry */
              }
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
            }
            value = last
          }
          setData(value)
        } catch (cause) {
          setError(String(cause.message || cause))
        } finally {
          setLoading(false)
        }
      }, [sessionId])

      useEffect(() => {
        setData(null)
        setTab('prompt')
        setGlobalView(null)
        load()
      }, [load])

      useEffect(() => {
        if (!toast) return undefined
        const timer = setTimeout(() => setToast(''), 2600)
        return () => clearTimeout(timer)
      }, [toast])

      useEffect(() => {
        setAssemblyCache({ sessionId: null, data: null, loadedAt: 0 })
      }, [sessionId])

      useEffect(() => {
        const onChange = () => setFontRevision((value) => value + 1)
        window.addEventListener('prompt-lab:font-scale', onChange)
        window.addEventListener('prompt-lab:theme', onChange)
        return () => {
          window.removeEventListener('prompt-lab:font-scale', onChange)
          window.removeEventListener('prompt-lab:theme', onChange)
        }
      }, [])

      useEffect(() => {
        const timers = []
        const onSent = (event) => {
          if (event?.detail?.sessionId !== sessionId) return
          void load()
          // After the first send the Host locks the session and the prompt
          // snapshot changes; refresh a few times so the locked state appears
          // without a manual refresh.
          for (const delay of [600, 1500, 3000, 5000]) {
            timers.push(setTimeout(() => { void load() }, delay))
          }
        }
        window.addEventListener('prompt-lab:user-sent', onSent)
        return () => {
          window.removeEventListener('prompt-lab:user-sent', onSent)
          for (const timer of timers) clearTimeout(timer)
        }
      }, [load, sessionId])

      const close = () => {
        if (typeof onClose === 'function') onClose()
      }
      const refresh = (next) => {
        if (!next || typeof next !== 'object') return
        if (next.session === undefined || next.prompt === undefined) {
          setError('返回数据不完整；请点刷新重新读取本会话。')
          return
        }
        setError('')
        setData(next)
        notifyStateChanged({
          sessionId: next.session.id,
          enabled: next.session.enabled === true
        })
      }

      useEffect(() => {
        if (!sessionId || pane) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [sessionId, pane])

      if (!sessionId) return null

      const tabs = [
        ['prompt', '提示词'],
        ['capabilities', '能力设置'],
        ['messages', '消息管理'],
        ['backups', '备份'],
        ['presets', '预设'],
        ['assembly', '装配结构']
      ]

      const shell = h('div', { style: pane ? css.paneShell : css.panel },
        h('div', { style: css.header },
          h('div', { style: css.headerRow },
            h('span', { style: css.title }, '提示词实验室'),
            data?.session?.draft
              ? h('span', { style: { ...css.tag, color: PALETTE.warn } }, '草稿')
              : null,
            h('span', { style: { flex: 1 } }),
            // preset-editor: Agent presets sit left of 文本管理.
            data
              ? h('button', {
                style: {
                  ...css.button,
                  padding: '6px 10px',
                  fontSize: '13px',
                  minHeight: '30px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  ...(globalView === 'agentPresets' ? css.primary : {})
                },
                title: '管理本机注册的 Agent 预设；新会话生效',
                onClick: () => setGlobalView(globalView === 'agentPresets' ? null : 'agentPresets')
              },
              h('svg', {
                viewBox: '0 0 16 16',
                width: 14,
                height: 14,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round',
                strokeLinejoin: 'round'
              },
              h('path', { d: 'M3 13V6.5M8 13V3M13 13V8.5' })),
              'Agent 预设')
              : null,
            data
              ? h('button', {
                style: {
                  ...css.button,
                  padding: '6px 10px',
                  fontSize: '13px',
                  minHeight: '30px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  ...(globalView === 'library' ? css.primary : {})
                },
                onClick: () => setGlobalView(globalView === 'library' ? null : 'library')
              },
              h('svg', {
                viewBox: '0 0 16 16',
                width: 14,
                height: 14,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round',
                strokeLinejoin: 'round'
              },
              h('rect', { x: 2.5, y: 2.5, width: 4, height: 11, rx: 1 }),
              h('rect', { x: 9.5, y: 2.5, width: 4, height: 11, rx: 1 })),
              '文本管理')
              : null,
            data
              ? h('button', {
                style: {
                  ...css.button,
                  padding: '6px 10px',
                  fontSize: '13px',
                  minHeight: '30px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  ...(globalView === 'settings' ? css.primary : {})
                },
                onClick: () => setGlobalView(globalView === 'settings' ? null : 'settings')
              },
              h('svg', {
                viewBox: '0 0 16 16',
                width: 14,
                height: 14,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.4,
                strokeLinecap: 'round'
              },
              h('path', { d: 'M2 4h12M2 8h12M2 12h12' }),
              h('circle', { cx: 5, cy: 4, r: 1.5, fill: 'currentColor', stroke: 'none' }),
              h('circle', { cx: 10, cy: 8, r: 1.5, fill: 'currentColor', stroke: 'none' }),
              h('circle', { cx: 6, cy: 12, r: 1.5, fill: 'currentColor', stroke: 'none' })),
              '设置')
              : null,
            data
              ? h('button', {
                style: { ...css.button, padding: '6px 10px', fontSize: '13px', minHeight: '30px' },
                disabled: loading,
                onClick: () => load()
              }, loading ? '刷新中…' : '刷新')
              : null,
            pane ? null : h('button', {
              style: { ...css.button, padding: '6px 10px', fontSize: '13px', minHeight: '30px' },
              onClick: close
            }, '关闭')),
          h('div', { style: css.headerRow },
            data
              ? h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': data.session.enabled === true,
                style: {
                  appearance: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  border: `1px solid ${data.session.enabled ? PALETTE.ok : PALETTE.line}`,
                  background: data.session.enabled ? PALETTE.okSoft : PALETTE.soft,
                  color: PALETTE.text,
                  borderRadius: '999px',
                  padding: '4px 10px 4px 6px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontFamily: 'inherit',
                  lineHeight: '1.2'
                },
                onClick: async () => {
                  try {
                    refresh(await call('session.set', { sessionId, enabled: data.session.enabled !== true }))
                  } catch (cause) {
                    setError(String(cause.message || cause))
                  }
                }
              },
              h('span', {
                style: {
                  position: 'relative',
                  display: 'inline-block',
                  width: '30px',
                  height: '16px',
                  borderRadius: '999px',
                  background: data.session.enabled ? PALETTE.ok : PALETTE.dim,
                  transition: 'background 120ms'
                }
              },
              h('span', {
                style: {
                  position: 'absolute',
                  top: '2px',
                  left: data.session.enabled ? '16px' : '2px',
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  background: '#fff',
                  transition: 'left 120ms'
                }
              })),
              h('span', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1px' } },
                h('span', { style: { fontSize: '12px' } }, '对本会话生效'),
                h('span', { style: { fontSize: '10.5px', color: data.session.enabled ? PALETTE.ok : PALETTE.dim } },
                  data.session.enabled ? '已开启' : '未开启')))
              : null,
            h('span', { style: { flex: 1 } }),
            h('span', { style: { ...css.tag, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis' } }, sessionId.slice(0, 12)))),

        data
          ? h('div', { style: css.tabs },
            globalView
              ? [
                h('span', { key: 'global', style: { ...css.tab, ...css.tabActive, cursor: 'default' } },
                  globalView === 'library' ? '文本管理（全局）' : globalView === 'agentPresets' ? 'Agent 预设（全局）' : '设置（全局）'),
                h('span', { key: 'flex', style: { flex: 1 } }),
                h('button', {
                  key: 'back',
                  style: css.tab,
                  onClick: () => setGlobalView(null)
                }, '← 返回会话')
              ]
              : tabs.map(([key, text]) => h('button', {
                key,
                style: { ...css.tab, ...(tab === key ? css.tabActive : {}) },
                onClick: () => {
                  setTab(key)
                  setGlobalView(null)
                }
              }, text)))
          : null,

        (error || toast)
          ? h('div', { style: css.statusBar },
            error
              ? h('div', { style: { ...css.warnNotice, marginBottom: toast ? '6px' : 0, borderLeftColor: PALETTE.danger, background: PALETTE.dangerSoft } }, error)
              : null,
            toast
              ? h('div', { style: { ...css.notice, marginBottom: 0, borderLeftColor: PALETTE.ok } }, toast)
              : null)
          : null,

        h('div', { style: css.body },
          loading ? h('div', { style: css.hint }, '读取中…') : null,
          !data && !loading && !error ? h('div', { style: css.hint }, '没有数据。') : null,

          data && globalView === 'library' ? h(LibraryTab, { sessionId, data, refresh, setError, setToast }) : null,
          data && globalView === 'agentPresets' ? h(AgentPresetBoundary, null, h(AgentPresetTab, { sessionId, data, refresh, setError, setToast })) : null,
          data && globalView === 'settings' ? h(SettingsTab, { sessionId, data, refresh, setError, setToast }) : null,
          data && !globalView && tab === 'prompt' ? h(PromptTab, { sessionId, data, refresh, setError, setToast }) : null,
          data && !globalView && tab === 'capabilities' ? h(CapabilityTab, { sessionId, data, refresh, setError, setToast }) : null,
          data && !globalView && tab === 'messages'
            ? h(MessagesTab, { sessionId, data, refresh, setError, setToast })
            : null,
          data && !globalView && tab === 'backups' ? h(BackupTab, { sessionId, data, refresh, setError, setToast }) : null,
          data && !globalView && tab === 'presets' ? h(PresetTab, { sessionId, data, refresh, setError, setToast }) : null,
          data && !globalView && tab === 'assembly'
            ? h(AssemblyTab, { sessionId, data, cache: assemblyCache, setCache: setAssemblyCache })
            : null
        )
      )

      if (pane) return shell
      return h('div', {
        style: css.overlay,
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) close()
        }
      }, shell)
    }

    // ------------------------------------------------------------- entry pill
    function DockButton (props) {
      const sessionId = props?.sessionId
      const openSidebar = props?.openSidebar
      const [enabled, setEnabled] = useState(false)
      const [, setThemeRevision] = useState(0)
      // Only the phase is needed. Selecting the whole InputState made this
      // composer pill re-render on every keystroke.
      const phase = typeof props?.useInput === 'function' ? props.useInput((state) => state?.phase) : undefined
      const wasSending = React.useRef(false)

      useEffect(() => {
        const onChange = () => setThemeRevision((value) => value + 1)
        window.addEventListener('prompt-lab:theme', onChange)
        window.addEventListener('prompt-lab:font-scale', onChange)
        return () => {
          window.removeEventListener('prompt-lab:theme', onChange)
          window.removeEventListener('prompt-lab:font-scale', onChange)
        }
      }, [])

      useEffect(() => {
        if (phase === 'sending') {
          wasSending.current = true
          return
        }
        if (wasSending.current && phase === 'plain') {
          wasSending.current = false
          try {
            window.dispatchEvent(new CustomEvent('prompt-lab:user-sent', { detail: { sessionId } }))
          } catch {
            /* UI-only notification */
          }
        }
      }, [phase, sessionId])

      useEffect(() => {
        let alive = true
        if (!sessionId) return undefined
        const refresh = () => {
          if (!alive) return
          call('state.get', { sessionId })
            .then((value) => { if (alive) setEnabled(value?.session?.enabled === true) })
            .catch(() => {})
        }
        const onChanged = (event) => {
          const detail = event?.detail
          if (detail?.sessionId !== sessionId) return
          if (typeof detail?.enabled === 'boolean') setEnabled(detail.enabled)
          refresh()
        }
        refresh()
        window.addEventListener('prompt-lab:state-changed', onChanged)
        return () => {
          alive = false
          window.removeEventListener('prompt-lab:state-changed', onChanged)
        }
      }, [sessionId])

      return h('button', {
        type: 'button',
        style: css.dock,
        title: 'Prompt Lab：编辑本会话的系统提示词',
        onClick: () => {
          if (!sessionId) return
          let opened = false
          try {
            opened = typeof openSidebar === 'function' && openSidebar(sessionId) !== false
          } catch (error) {
            console.warn('[prompt-lab] sidebar open failed:', error)
          }
          if (!opened) ui.patch({ open: sessionId })
        }
      },
      enabled ? h('span', { style: css.dockDot }) : null,
      h('span', null, 'Prompt Lab'))
    }

    function OverlayHost () {
      const view = useUi()
      if (!view.open) return null
      return h(PanelView, {
        sessionId: view.open,
        pane: false,
        onClose: () => ui.patch({ open: null })
      })
    }

    function SidebarPanel (props) {
      const sessionId = props?.sessionId
      if (!sessionId) {
        return h('div', { style: { padding: '16px', ...css.hint } }, '这个标签页需要会话上下文；请从输入框旁的 Prompt Lab 打开。')
      }
      return h(PanelView, { sessionId, pane: true })
    }

    function SidebarTitle () {
      return h('span', null, '提示词实验室')
    }

    const TAB_ID = 'prompt-lab'
    const TAB_KIND = 'prompt-lab'

    return {
      inject: ['slots'],
      apply (ctx) {
        let sidebar = null
        const themeService = typeof ctx.get === 'function' ? ctx.get('theme') : undefined
        const initialScheme = themeService?.getTheme?.()?.active?.colorScheme
        const media = (() => {
          try {
            return window.matchMedia?.('(prefers-color-scheme: dark)')
          } catch {
            return undefined
          }
        })()
        setColorScheme(initialScheme || (media?.matches ? 'dark' : 'light'))
        try {
          ctx.on?.('theme/change', (snapshot) => setColorScheme(snapshot?.active?.colorScheme))
        } catch {
          /* theme service unavailable in older hosts */
        }
        try {
          media?.addEventListener?.('change', () => {
            if (!themeService) setColorScheme(media.matches ? 'dark' : 'light')
          })
        } catch {
          /* media query listener is best-effort */
        }

        const openSidebar = (sessionId) => {
          const service = sidebar?.service ?? (typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined)
          if (!service) {
            console.warn('[prompt-lab] sidebarRight not ready; using the overlay')
            return false
          }
          try {
            if (typeof service.openTabIn === 'function' && sessionId) service.openTabIn(sessionId, TAB_KIND)
            else service.openTab(TAB_KIND)
            return true
          } catch (error) {
            console.warn('[prompt-lab] cannot open the sidebar tab:', error)
            return false
          }
        }

        // The composer's bottom row renders in both the empty-session hero
        // layout and a live conversation, so it is the entry that always exists.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'prompt-lab.entry',
          order: 5,
          inject: (sessionId) => ({ sessionId, openSidebar })
        }, DockButton))


        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'prompt-lab.pending-lock',
          order: 100,
          inject: (sessionId) => ({ sessionId })
        }, PendingLockOverlay))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'prompt-lab.panel'
        }, OverlayHost))

        const mountSidebar = (scope) => {
          try {
            scope.effect(() => scope.sidebarRightTabs.register({
              id: TAB_ID,
              kind: TAB_KIND,
              priority: 'extension',
              title: () => '提示词实验室'
            }), 'prompt-lab: sidebar tab type')
          } catch (error) {
            console.warn('[prompt-lab] sidebar tab type unavailable:', error)
            return
          }
          sidebar = { scope, service: scope.sidebarRight }
          try {
            scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
              name: 'sidebar.right.pane.tab',
              key: TAB_ID,
              inject: (sessionId) => ({ sessionId })
            }, SidebarPanel))
            scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
              name: 'sidebar.right.pane.tab.title',
              key: TAB_ID
            }, SidebarTitle))
          } catch (error) {
            console.warn('[prompt-lab] sidebar tab slots unavailable:', error)
          }
        }

        if (typeof ctx.inject === 'function') ctx.inject(['sidebarRight', 'sidebarRightTabs'], mountSidebar)
        else {
          try {
            mountSidebar(ctx)
          } catch (error) {
            console.warn('[prompt-lab] sidebar unavailable:', error)
          }
        }
      }
    }
  }
})
