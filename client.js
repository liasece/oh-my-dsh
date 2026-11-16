/**
 * 浏览器入口提供输入框控件和统一设置页。候选与历史共用一次 Typert 挂载。
 * 创建会话由宿主的 agent 工具执行，浏览器只负责它的设置开关。
 */
window.__ModuleLoader__.load({
  id: 'oh-my-dsh',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { z } = require('zod')
    const h = React.createElement

    /** 插件包名，也是 profile 里的条目 id 与设置命名空间。 */
    const PACKAGE = 'oh-my-dsh'
    /** 输入框上方那一行（提示词候选与输入历史共用）。 */
    const DOCK_SLOT = 'conversation.input.dock'

    //#region Typert remote info（取自 @deepseek-ai/dsh-typert-protocol/remote-info，MIT）
    function createTypertRemoteInfo(spec, zod) { return new RemoteInfo(spec, zod) }
    class RemoteInfo {
      constructor(spec, zod) { this.spec = spec; this.zod = zod; this.index = undefined }
      get package() { return this.spec.package }
      get descriptors() { return this.resolve().descriptors }
      get methods() { return this.resolve().methods }
      resolve() {
        if (this.index !== undefined) return this.index
        const zod = this.zod
        const descriptors = []
        const methods = Object.create(null)
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
          const separator = endpoint.indexOf('/')
          const namespace = endpoint.slice(0, separator)
          const method = endpoint.slice(separator + 1)
          const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }))
          const descriptor = {
            ...definition,
            id: `${this.spec.package}#${endpoint}`,
            namespace,
            method,
            parameters,
            result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
          }
          if (definition.invocation.kind === 'direct') {
            const inputs = []
            methods[endpoint] = Object.assign(descriptor, {
              input(options) {
                const strict = options?.strict === true
                return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod)
              },
              invoke(remote, input, signal) {
                const values = parameters.map(parameter => input[parameter.wire])
                if (definition.cancellation !== undefined) values.push(signal)
                const receiver = Reflect.get(remote, namespace)
                const call = Reflect.get(receiver, method)
                return call.apply(receiver, values)
              },
            })
          }
          descriptors.push(descriptor)
        }
        return this.index = { descriptors, methods }
      }
    }
    const optional = parameter => parameter.source === 'json' && parameter.acceptsUndefined === true
    class NamedInput {
      constructor(parameters, strict, zod) { this.parameters = parameters; this.strict = strict; this.zod = zod }
      codec(parameter) { return this.strict ? parameter.strictCodec : parameter.codec }
      create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map(parameter => {
        const value = this.codec(parameter).create()
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()]
      })))
      get jsonSchema() { return this.project().jsonSchema }
      get jsonSchemaError() { return this.project().jsonSchemaError }
      project() {
        if (this.projection !== undefined) return this.projection
        const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined)
        if (unavailable !== undefined) return this.projection = { jsonSchemaError: `No JSON Schema for parameter ${unavailable.wire}` }
        return this.projection = {
          jsonSchema: {
            type: 'object',
            properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
              ...this.codec(parameter).jsonSchema,
              ...(parameter.description === undefined ? {} : { description: parameter.description }),
            }])),
            required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
            additionalProperties: false,
          },
        }
      }
    }
    class ResultValue {
      constructor(spec) { this.spec = spec }
      get mode() { return this.spec.mode }
      get typeSymbol() { return this.spec.typeSymbol }
      get create() { return this.spec.create }
      get decode() { return this.spec.decode }
      get encode() { return this.spec.encode }
      get description() { return this.spec.description }
      get jsonSchemaError() { return this.spec.jsonSchemaError }
      get jsonSchema() {
        if (this.projection === undefined) {
          const schema = this.spec.jsonSchema
          this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } }
        }
        return this.projection.value
      }
    }
    //#endregion
    //#endregion

    //#region Remote spec（与 Host 的 lib/remote.js 一致）
    const CANDIDATES_REQUEST_JSON = {
      type: 'object',
      properties: { sessionId: { type: 'string', description: '刚刚结束一个回合的会话。' } },
      required: ['sessionId'],
    }
    const CANDIDATES_RESULT_JSON = {
      type: 'object',
      properties: {
        suggestions: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
      required: ['suggestions', 'reason'],
    }
    const HISTORY_REQUEST_JSON = {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要读取历史的会话。' },
        limit: { type: 'number', description: '最多往回翻多少条，取值 1–200。' },
      },
      required: ['sessionId'],
    }
    const HISTORY_RESULT_JSON = {
      type: 'object',
      properties: {
        messages: { type: 'array', items: { type: 'string' } },
      },
      required: ['messages'],
    }
    let candidatesRequest, strictCandidatesRequest, candidatesResult
    let historyRequest, strictHistoryRequest, historyResult
    const TYPERT_REMOTE = createTypertRemoteInfo({
      package: PACKAGE,
      methods: {
        'ohMyDsh/candidates': {
          service: 'ohMyDsh',
          description: '为刚结束一个回合的会话生成最多 N 条下一条提示词候选。',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request',
            description: '会话身份。',
            source: 'json',
            codec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE}/types#CandidatesRequest`,
              create: () => (candidatesRequest ??= z.object({ sessionId: z.string() })),
              jsonSchema: { ...CANDIDATES_REQUEST_JSON, additionalProperties: true },
            },
            strictCodec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE}/types#CandidatesRequest`,
              create: () => (strictCandidatesRequest ??= z.strictObject({ sessionId: z.string() })),
              jsonSchema: { ...CANDIDATES_REQUEST_JSON, additionalProperties: false },
            },
          }],
          cancellation: { parameter: 'signal' },
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#ohMyDsh/candidates:result`,
            create: () => (candidatesResult ??= z.object({ suggestions: z.array(z.string()), reason: z.string() })),
            description: '候选列表，空数组表示本轮不展示。',
            jsonSchema: CANDIDATES_RESULT_JSON,
          },
        },
        'ohMyDsh/history': {
          service: 'ohMyDsh',
          description: '读取一个会话里用户发送过的消息文本，供输入框按 ↑ 召回。',
          invocation: { kind: 'direct' },
          parameters: [{
            name: 'request',
            description: '会话与条数上限。',
            source: 'json',
            codec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE}/types#HistoryRequest`,
              create: () => (historyRequest ??= z.object({ sessionId: z.string(), limit: z.number().optional() })),
              jsonSchema: { ...HISTORY_REQUEST_JSON, additionalProperties: true },
            },
            strictCodec: {
              mode: 'strict',
              typeSymbol: `${PACKAGE}/types#HistoryRequest`,
              create: () => (strictHistoryRequest ??= z.strictObject({ sessionId: z.string(), limit: z.number().optional() })),
              jsonSchema: { ...HISTORY_REQUEST_JSON, additionalProperties: false },
            },
          }],
          result: {
            mode: 'strict',
            typeSymbol: `${PACKAGE}#ohMyDsh/history:result`,
            create: () => (historyResult ??= z.object({ messages: z.array(z.string()) })),
            description: '用户消息文本，最早的一条在前；没有历史时是空数组。',
            jsonSchema: HISTORY_RESULT_JSON,
          },
        },
      },
    }, z)
    //#endregion

    //#region 配置：三段一张表单，读写都按 `config.<段名>` 走
    /**
     * 取本插件的配置表单；宿主没挂 configForms 时返回 undefined。
     * @param ctx 浏览器侧上下文。
     */
    function configFormOf(ctx) {
      const forms = ctx.get?.('configForms')
      if (forms === undefined || typeof forms.get !== 'function') return undefined
      return forms.get(PACKAGE)
    }

    /**
     * 读某个功能段的当前值。
     *
     * 段里的每个字段都是 volatile 引用，逐个拆开；段缺席时给空对象，让各功能退回
     * 自己的默认值。
     * @param form 配置表单（可能是 undefined）。
     * @param key 配置段名。
     */
    function readSection(form, key) {
      const raw = form?.getSnapshot?.()?.value?.[key]
      if (raw === null || typeof raw !== 'object') return {}
      return Object.fromEntries(Object.entries(raw).map(([field, value]) => [field, plain(value)]))
    }

    /**
     * 某个功能是否启用。
     *
     * 配置读不到时一律当作启用：功能在旧宿主上照样能用，只是没有开关。
     * @param form 配置表单（可能是 undefined）。
     * @param key 段名。
     */
    function sectionEnabled(form, key) {
      if (form === undefined) return true
      return readSection(form, key).enabled !== false
    }

    /**
     * 写某个功能段里的字段。
     *
     * 路径必须落到 volatile 的叶子（`['peakValley', 'sessions']`）：宿主不接受
     * 对整段的写入，也不会在没有写入通道时静默成功。
     * @param form 配置表单。
     * @param key 段名。
     * @param patch 只带要改的字段。
     * @returns 宿主是否接受。
     */
    function writeSection(form, key, patch) {
      if (form === undefined || typeof form.mutate !== 'function') return Promise.resolve(false)
      const ops = Object.entries(patch).map(([field, value]) => ({ op: 'set', path: [key, field], value }))
      if (ops.length === 0) return Promise.resolve(true)
      return Promise.resolve(form.mutate(ops))
    }

    /**
     * 订阅某个功能段的启用状态，供「不渲染就不该请求」的组件使用。
     * @param form 配置表单。
     * @param key 段名。
     * @returns 当前是否启用；配置改动后自动刷新。
     */
    function useSectionEnabled(form, key) {
      const read = () => sectionEnabled(form, key)
      const [enabled, setEnabled] = React.useState(read)
      React.useEffect(() => {
        const sync = () => setEnabled(read())
        sync()
        if (form === undefined || typeof form.subscribe !== 'function') return undefined
        return form.subscribe(sync)
      }, [form, key])
      return enabled
    }
    //#endregion


    const PRIMITIVES = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? {}
      } catch {
        return {}
      }
    })()

    /** 退化的弹层容器：只补宿主的表面视觉，其余照旧。 */
    const FallbackSurface = React.forwardRef(function FallbackSurface({ children, className, ...rest }, ref) {
      return React.createElement(
        'div',
        { ...rest, ref, className: `${className ?? ''} pvm-panelFallback` },
        children,
      )
    })

    const MenuSurface = PRIMITIVES.MenuSurface ?? FallbackSurface

    /** 退化的图标：画一个中性齿轮 / 叉，避免整块空白。 */
    const FallbackIcon = (path) => function IconFallback(props) {
      return React.createElement(
        'svg',
        { viewBox: '0 0 16 16', width: props.size ?? 16, height: props.size ?? 16, 'aria-hidden': true },
        React.createElement('path', { fill: 'currentColor', d: path }),
      )
    }

    const IconSettingsOutlineRegular = PRIMITIVES.IconSettingsOutlineRegular
      ?? FallbackIcon('M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Zm0 1.6a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Zm6.4 1.2c0 .34-.03.66-.09.98l1.09.85-1.2 2.08-1.3-.52c-.5.42-1.07.75-1.7.96l-.2 1.38h-2.4l-.2-1.38a5.2 5.2 0 0 1-1.7-.96l-1.3.52-1.2-2.08 1.09-.85a5.4 5.4 0 0 1 0-1.96L2.6 6.37l1.2-2.08 1.3.52c.5-.42 1.07-.75 1.7-.96l.2-1.38h2.4l.2 1.38c.63.21 1.2.54 1.7.96l1.3-.52 1.2 2.08-1.09.85c.06.32.09.64.09.98Z')
    const IconCloseOutlineRegular = PRIMITIVES.IconCloseOutlineRegular
      ?? FallbackIcon('M4.2 3.4 8 7.2l3.8-3.8 1.4 1.4L9.4 8.6l3.8 3.8-1.4 1.4L8 10l-3.8 3.8-1.4-1.4 3.8-3.8-3.8-3.8 1.4-1.4Z')

    const PEAK_VALLEY_NS = 'oh-my-dsh.peak-valley'

    /** 宿主条目 id，同时是设置命名空间。 */
    const CONFIG_NS = PACKAGE

    /** 峰谷参考时区。 */
    const TIME_ZONE = 'Asia/Shanghai'

    /** 下拉里可选的参考时区（覆盖常用地区，另加配置里已有的值）。 */
    const TIME_ZONE_OPTIONS = [
      'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul',
      'Asia/Singapore', 'Asia/Bangkok', 'Asia/Kolkata', 'Asia/Dubai',
      'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
      'Australia/Sydney', 'Pacific/Auckland', 'UTC',
    ]

    /** 时间下拉的粒度：15 分钟，一天 96 个选项。 */
    const CLOCK_STEP_MINUTES = 15

    /** 生成一天的时间选项。 */
    function clockOptions() {
      const options = []
      for (let minute = 0; minute < 24 * 60; minute += CLOCK_STEP_MINUTES) {
        options.push(formatClock(minute))
      }
      return options
    }

    /** 配置缺席时的兜底时段表：沿用官方工作日两段，路由与谷时相同（等于不切换）。 */
    const FALLBACK_WINDOWS = [
      { start: '09:00', end: '12:00', provider: 'deepseek-account', model: 'deepseek-flash' },
      { start: '14:00', end: '18:00', provider: 'deepseek-account', model: 'deepseek-flash' },
    ]

    /** 拆开 volatile 引用对象：它是 `{ get(), [write]() }`，界面只想要值。 */
    function plain(value) {
      if (value !== null && typeof value === 'object' && typeof value.get === 'function' && value.get.length === 0) {
        return value.get()
      }
      return value
    }

    /** 把瞬间换算到参考时区的星期与当日分钟；与 lib/period.js 同一算法。 */
    function zonedParts(instant, timeZone) {
      const fallback = () => {
        const shifted = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
        return { day: shifted.getUTCDay(), minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() }
      }
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone,
          weekday: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(instant)
        const pick = (type) => parts.find((part) => part.type === type)?.value
        const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
        const day = days[pick('weekday')]
        const hour = Number(pick('hour'))
        const minute = Number(pick('minute'))
        if (day === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) return fallback()
        return { day, minute: hour * 60 + minute }
      } catch {
        return fallback()
      }
    }

    /** 解析 `HH:MM` 为当日分钟；与 lib/period.js 同一规则。 */
    function parseClock(text) {
      if (typeof text !== 'string') return undefined
      const match = /^\s*(\d{1,2}):(\d{2})\s*$/u.exec(text)
      if (match === null) return undefined
      const hour = Number(match[1])
      const minute = Number(match[2])
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
      return hour * 60 + minute
    }

    /** 把当日分钟格式化成 `HH:MM`。 */
    function formatClock(minutes) {
      return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    }

    /** 当日分钟是否落在区间内（左闭右开，支持跨零点）。 */
    function within(minute, start, end) {
      if (start === end) return false
      if (start < end) return minute >= start && minute < end
      return minute >= start || minute < end
    }

    /**
     * 找出某个瞬间命中的时段；与宿主侧 windowAt 同一口径。
     *
     * 周末整天不命中（走窗口外路由），所以界面与真实路由不会打架。
     * @param windows 配置里的 peakWindows。
     * @param instant 判定时刻。
     * @param timeZone 参考时区。
     */
    function windowAt(windows, instant, timeZone = TIME_ZONE) {
      if (!Array.isArray(windows)) return undefined
      const { day, minute } = zonedParts(instant, timeZone)
      if (day === 0 || day === 6) return undefined
      for (let index = 0; index < windows.length; index += 1) {
        const raw = windows[index]
        if (raw === null || typeof raw !== 'object') continue
        const start = parseClock(raw.start)
        const end = parseClock(raw.end)
        if (start === undefined || end === undefined) continue
        if (within(minute, start, end)) {
          return { index, start, end, route: { provider: raw.provider, model: raw.model } }
        }
      }
      return undefined
    }

    const peakValleyZh = {
      chipOn: '峰谷动态',
      chipOff: '峰谷已关闭',
      chipPeak: '峰时',
      chipOffPeak: '谷时',
      chipEnable: '开启峰谷动态：按当前时段选真实路由',
      chipDisable: '关闭峰谷动态：切到退出目标',
      chipBusy: '切换中…',
      chipFailed: '切换失败：{error}',
      chipFailedShort: '开关失败',
      openSettings: '打开峰谷动态设置',
      close: '关闭',
      stateLabel: '峰谷动态',
      featureLabel: '功能开关',
      featureHint: '关掉后不再改动任何会话的模型位；下面这些设置原样保留，重新打开即恢复。',
      featureOn: '已开启',
      featureOff: '已关闭',
      defaultState: '按会话开启',
      defaultStateHint: '开关只作用于单个会话；新建会话沿用你上一次切换的结果，已有会话不受影响。',
      statesCount: '已开启 {count} 个会话',
      nextSessionOn: '新会话：开',
      nextSessionOff: '新会话：关',
      routeHint: '填写 provider 与 model，保存后立即生效。',
      timeZoneLabel: '参考时区',
      timeZoneHint: '峰谷时段按这个时区判定，默认 Asia/Shanghai。',
      overridesLabel: '按会话覆盖',
      overridesNone: '没有会话与默认值不同。',
      overridesCount: '有 {count} 个会话与默认值不同。',
      overridesClear: '全部恢复默认',
      saved: '已保存',
      invalid: '时区与窗口外路由的 provider/model 都不能为空。',
      invalidWindow: '每个时段的时间必须是合法 HH:MM，provider 与 model 也不能为空。',
      chipOutside: '时段外',
      windowsLabel: '时段表',
      windowsHint: '落在某个时段内就用该时段的模型；时段只在工作日生效，周末与时段外走下面的路由。',
      windowLabel: '时段 {index}',
      startLabel: '开始',
      endLabel: '结束',
      addWindow: '添加时段',
      remove: '删除',
      offPeakHint: '时段之外（含周末）使用的路由。',
      title: '峰谷动态',
      description: '按 DeepSeek 官方峰谷时段，用 DSH 原生模型选择在两条真实路由之间切换。选中「峰谷动态」的会话即由本插件托管，跨时段自动改写。',
      state: '本会话',
      stateOn: '托管中',
      stateOff: '已关闭',
      currentPeriod: '当前时段',
      periodPeak: '峰时（全价）',
      periodOffPeak: '谷时（半价）',
      peakRoute: '峰时路由',
      offPeakRoute: '谷时路由',
      notConfigurable: '本部署没有开放峰谷配置的写入，这里只显示当前值。',
      saveFailed: '保存失败：{error}',
      providerLabel: '提供方',
      modelLabel: '模型',
      noSession: '当前没有打开的会话。',
    }

    const peakValleyEn = {
      chipOn: 'Peak/Valley',
      chipOff: 'Peak/Valley off',
      chipPeak: 'Peak',
      chipOffPeak: 'Off-peak',
      chipEnable: 'Enable Peak/Valley: route by the current period',
      chipDisable: 'Disable Peak/Valley: switch to the exit target',
      chipBusy: 'Switching…',
      chipFailed: 'Switch failed: {error}',
      chipFailedShort: 'Toggle failed',
      openSettings: 'Open Peak/Valley settings',
      close: 'Close',
      stateLabel: 'Peak/Valley',
      featureLabel: 'Feature switch',
      featureHint: 'When off, no session model is touched; the settings below stay as they are and take effect again when you turn it back on.',
      featureOn: 'On',
      featureOff: 'Off',
      defaultState: 'Per-session',
      defaultStateHint: 'The switch applies to one session. New sessions start at your last toggle; existing sessions are untouched.',
      statesCount: '{count} session(s) on',
      nextSessionOn: 'New sessions: on',
      nextSessionOff: 'New sessions: off',
      routeHint: 'Provider and model; saved values take effect immediately.',
      timeZoneLabel: 'Reference time zone',
      timeZoneHint: 'Peak windows are evaluated in this zone; defaults to Asia/Shanghai.',
      overridesLabel: 'Per-session overrides',
      overridesNone: 'No session differs from the default.',
      overridesCount: '{count} session(s) differ from the default.',
      overridesClear: 'Reset all to default',
      saved: 'Saved',
      invalid: 'Time zone and the outside-window route both need a provider and a model.',
      invalidWindow: 'Every window needs a valid HH:MM range and a provider plus model.',
      chipOutside: 'Outside windows',
      windowsLabel: 'Time windows',
      windowsHint: 'A window uses its own model while active. Windows apply on weekdays; weekends and gaps use the route below.',
      windowLabel: 'Window {index}',
      startLabel: 'Start',
      endLabel: 'End',
      addWindow: 'Add window',
      remove: 'Remove',
      offPeakHint: 'Route used outside every window, including weekends.',
      title: 'Peak/Valley',
      description: 'Switch between two real routes on DeepSeek official peak and off-peak hours through the native model selection. A session that selects Peak/Valley is managed and rewritten when the period changes.',
      state: 'This session',
      stateOn: 'Managed',
      stateOff: 'Off',
      currentPeriod: 'Current period',
      periodPeak: 'Peak (full price)',
      periodOffPeak: 'Off-peak (half price)',
      peakRoute: 'Peak route',
      offPeakRoute: 'Off-peak route',
      notConfigurable: 'This deployment does not expose Peak/Valley config writes; the current values are read-only here.',
      saveFailed: 'Save failed: {error}',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      noSession: 'No session is open.',
    }

    /** 只用主题令牌；类名带本插件前缀，随宿主的明暗主题自动切换。 */
    const CSS = `
/* 整组：开关 + 齿轮，作为输入框右侧的一个紧凑控件。 */
.pvm-root{display:inline-flex;align-items:center;gap:2px;position:relative;flex:none}
/*
 * 功能开关：胶囊轨道 + 圆钮 + 文案。
 *
 * 设置页板块的「功能开关」与输入框右侧的峰谷开关共用这一套形状，所以类名
 * 用插件级前缀 omd-，不随某个功能走。轨道宽度与宿主自己的 switch 同构，
 * 只是缩小到 26×15 以适配 36px 的输入框工具条。
 */
.omd-switch{box-sizing:border-box;border:none;outline:none;background:0 0;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 8px 0 6px;border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.omd-switch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.omd-switch:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.omd-switch:disabled{opacity:.55;cursor:default}
.omd-switch[data-on="true"]{color:var(--dsw-alias-label-primary)}
.omd-switchTrack{position:relative;display:inline-block;flex:none;width:26px;height:15px;border-radius:999px;background:var(--dsw-alias-state-idle-primary);transition:background .15s ease}
.omd-switch[data-on="true"] .omd-switchTrack{background:var(--dsw-alias-state-success-primary)}
.omd-switch[data-busy="true"] .omd-switchTrack{background:var(--dsw-alias-state-warn-primary)}
.omd-switchThumb{position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}
.omd-switch[data-on="true"] .omd-switchThumb{transform:translateX(11px)}
.omd-switchText{display:inline-flex;align-items:baseline;gap:5px;min-width:0}
.omd-switchLabel{font-size:13px;line-height:20px}
.omd-switchLabel[data-error="true"]{color:var(--dsw-alias-state-error-primary)}
.pvm-period{color:var(--dsw-alias-label-caption);font-size:12px}
/* 设置齿轮：与开关同高的图标按钮。 */
.pvm-gear{box-sizing:border-box;border:none;outline:none;background:0 0;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-caption)}
.pvm-gear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pvm-gear:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
/* 降级提示：拿不到快捷键服务时告诉用户设置在哪一页。 */
/*
 * 浮层：外观全部由宿主的 MenuSurface 提供 —— 它的 material 子层已经画了
 * --dsw-menu-surface-fill 与毛玻璃，外层还带 --dsw-radius-lg。
 * 所以这里绝不能自己设 background / box-shadow / border-radius，否则会盖住它。
 *
 * 唯一必须由调用方提供的是 position:fixed：MenuSurface 自身是 relative
 * （官方模型菜单的样式里同样自己声明了 fixed）。
 */
.pvm-panel{box-sizing:border-box;position:fixed;width:min(420px,calc(100vw - 32px));padding:12px 14px;z-index:1100;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column}
.pvm-panelFallback{background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-2));box-shadow:var(--dsw-elevation-prominent,0 4px 16px rgba(0,0,0,.18));backdrop-filter:var(--dsw-menu-backdrop-filter,none);border-radius:var(--dsw-radius-lg)}
.pvm-panelBody{max-height:min(64vh,520px);overflow:auto;overscroll-behavior:contain;flex-direction:column;display:flex;gap:10px;margin-top:8px}
.pvm-panelHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}
.pvm-panelTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:20px}
.pvm-iconButton{box-sizing:border-box;border:none;outline:none;background:0 0;cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-caption);padding:0}
.pvm-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.pvm-iconButton:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.pvm-errorDot{position:absolute;top:1px;right:1px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
.pvm-section{max-width:720px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.pvm-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}
.pvm-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}
.pvm-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:16px;padding:14px 0;display:flex}
.pvm-rowText{flex-direction:column;flex:1;gap:3px;min-width:0;display:flex}
.pvm-rowTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.pvm-rowHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.pvm-value{color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;word-break:break-all}
.pvm-error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}
.pvm-ok{color:var(--dsw-alias-state-success-primary);margin:0;font-size:12px;line-height:18px}
.pvm-badge{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:1px 6px;font-size:11px;line-height:16px}
.pvm-field{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);flex-direction:column;gap:8px;padding:10px 12px;display:flex}
.pvm-fieldHead{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;display:flex;align-items:center;gap:8px}
.pvm-inputs{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr);gap:8px;display:grid}
/* 下拉：与输入框同一套度量，只把箭头换成宿主的中性样式。 */
.pvm-selectWrap{display:block;min-width:0;position:relative}
.pvm-select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);width:100%;height:32px;font:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 26px 0 8px;font-size:13px;line-height:20px;appearance:none;cursor:pointer;text-overflow:ellipsis}
.pvm-select:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.pvm-select:disabled{opacity:.6;cursor:default}
.pvm-selectWrap::after{content:"";pointer-events:none;position:absolute;right:9px;top:50%;width:6px;height:6px;margin-top:-4px;border-right:1.2px solid var(--dsw-alias-label-caption);border-bottom:1.2px solid var(--dsw-alias-label-caption);transform:rotate(45deg)}
.pvm-srOnly{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.pvm-actions{display:flex;align-items:center;gap:10px}
.pvm-button{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);height:32px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;align-items:center;padding:0 14px;font-size:13px;line-height:20px;display:inline-flex}
.pvm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pvm-button:disabled{opacity:.4;cursor:default}
.pvm-linkButton{border:none;background:0 0;font:inherit;color:var(--dsw-alias-state-error-primary);cursor:pointer;margin-left:auto;padding:0 2px;font-size:12px;line-height:18px}
.pvm-linkButton:hover:not(:disabled){text-decoration:underline}
.pvm-linkButton:disabled{opacity:.4;cursor:default}
`

    /** 模板替换：`{error}` 这类占位符。 */
    function format(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (whole, key) => (values[key] === undefined ? whole : String(values[key])))
    }

    /**
     * 某个会话此刻是否启用峰谷动态。
     *
     * 有覆盖用覆盖，没有就用默认值 —— 与宿主侧 stateForSession 同一口径，
     * 所以新会话会继承「上一次操作」的结果。
     * @param state readState() 的结果。
     * @param sessionId 会话 id。
     */
    function sessionOn(state, sessionId) {
      if (sessionId === undefined) return false
      return state.sessions[sessionId] === true
    }

    /** 永远返回 undefined 的只读源：某个可观察值此刻不存在时用它占位。 */
    const ABSENT_SOURCE = { getSnapshot: () => undefined, subscribe: () => () => {} }

    /**
     * 在模块加载时就把样式挂上 head。
     *
     * 宿主自带的客户端包（ui-conversation、ui-model-selection 等）都在模块
     * 顶层做这件事，而不是放进 apply：apply 的时机由插件的依赖激活顺序决定，
     * 一旦晚于首帧渲染，组件先以无样式状态出现。这里跟随宿主约定。
     */
    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'oh-my-dsh/client.css'
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PACKAGE
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    installStyles()

    /**
     * 胶囊开关：一条圆角轨道，里面一枚圆钮，右侧跟一句状态文案。
     *
     * 设置页板块的「功能开关」与输入框右侧的峰谷开关都用它，保证同一控件在
     * 两个位置看起来是同一个东西。文案由调用方给（设置页是「已开启／已关闭」，
     * 峰谷在文案后面再挂一段时段）。
     *
     * @param {object} props
     * @param {boolean} props.on 当前是否打开。
     * @param {string} props.label 文案。
     * @param {() => void} props.onClick 点击切换。
     * @param {string} [props.title] 悬停说明。
     * @param {string} [props.ariaLabel] 无障碍名称；有可见文案时可不传。
     * @param {boolean} [props.disabled] 不可点时置灰。
     * @param {boolean} [props.busy] 写入中：轨道转黄、文案换成「切换中」。
     * @param {boolean} [props.error] 出错：文案用错误色。
     * @param {import('react').ReactNode} [props.extra] 文案右侧的补充信息。
     */
    function CapsuleSwitch(props) {
      const { on, label, onClick, title, ariaLabel, disabled, busy, error, extra } = props
      return h(
        'button',
        {
          type: 'button',
          className: 'omd-switch',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'data-on': on ? 'true' : 'false',
          ...(busy ? { 'data-busy': 'true' } : {}),
          disabled,
          onClick,
          ...(title === undefined ? {} : { title }),
          ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
        },
        h('span', { className: 'omd-switchTrack', 'aria-hidden': true }, h('span', { className: 'omd-switchThumb' })),
        h(
          'span',
          { className: 'omd-switchText' },
          h('span', { className: 'omd-switchLabel', ...(error ? { 'data-error': 'true' } : {}) }, label),
          extra ?? null,
        ),
      )
    }

    function registerPeakValley(ctx) {
      ctx.effect(() => ctx.locale.register(PEAK_VALLEY_NS, { zh: peakValleyZh, en: peakValleyEn }), 'oh-my-dsh: peak-valley dictionaries')
      const t = ctx.locale.bind(PEAK_VALLEY_NS)


      /** 取本插件的配置表单；宿主没挂 configForms 时返回 undefined。 */
      const configForm = () => {
        const forms = ctx.get('configForms')
        if (forms === undefined || typeof forms.get !== 'function') return undefined
        return forms.get(CONFIG_NS)
      }

      /**
       * 读一次宿主提供的模型目录（provider → models）。
       *
       * 用于把「provider / model」做成下拉：能选就不该让人手打。
       * 读取失败不抛给界面，只让下拉退化成「只有当前值」。
       * @returns {Promise<{groups: Array<{id: string, models: Array<{id: string, name: string}>}>}>}
       */
      let catalogOnce
      const loadCatalog = () => {
        if (catalogOnce !== undefined) return catalogOnce
        catalogOnce = Promise.resolve()
          .then(() => ctx.remote.session.modelCatalog())
          .then((response) => {
            if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
            const groups = Array.isArray(response.value?.groups) ? response.value.groups : []
            return {
              groups: groups.map((group) => ({
                id: String(group.id),
                models: (Array.isArray(group.models) ? group.models : []).map((model) => ({
                  id: String(model.id),
                  name: typeof model.name === 'string' && model.name !== '' ? model.name : String(model.id),
                })),
              })),
            }
          })
          .catch((error) => {
            ctx.logger?.debug?.('peak-valley: 读取模型目录失败: ' + String(error))
            // 失败不缓存，下次打开还能重试。
            catalogOnce = undefined
            return { groups: [] }
          })
        return catalogOnce
      }

      /**
       * 读插件配置的当前值。
       *
       * 配置缺席时退回与宿主一致的默认值，让开关在插件刚装好时也能用。
       * `writable` 表示有没有写入通道（没有 configForms 就只能只读显示）。
       */
      const readState = (form) => {
        const snapshot = form?.getSnapshot?.()
        const value = readSection(form, 'peakValley')
        const sessions = value.sessions !== null && typeof value.sessions === 'object' ? value.sessions : {}
        return {
          enabled: value.enabled !== false,
          sessions,
          lastToggle: value.lastToggle ?? { on: false, at: 0 },
          timeZone: value.timeZone ?? TIME_ZONE,
          peakWindows: Array.isArray(value.peakWindows) ? value.peakWindows : FALLBACK_WINDOWS,
          offPeakRoute: value.offPeakRoute ?? { provider: 'deepseek-account', model: 'deepseek-flash' },
          writable: form !== undefined && snapshot?.writable !== false,
        }
      }

      /**
       * 切换某个会话的峰谷动态。
       *
       * 只写 `sessions`：打开即记键，关闭即删键。没有「全局默认值」这种东西，
       * 所以一次操作不可能波及别的会话。
       */
      const setSessionEnabled = (form, sessionId, next) => {
        if (form === undefined || sessionId === undefined) return Promise.resolve(false)
        const state = readState(form)
        const sessions = { ...state.sessions }
        if (next) sessions[sessionId] = true
        else delete sessions[sessionId]
        // 同时记下「最近一次动作」：之后新建的会话用它做初始状态。
        // 已有会话不受影响 —— 那要靠会话创建时间与 at 比较，宿主才判断得了。
        const lastToggle = { on: next, at: Date.now() }
        const ops = [
          { op: 'set', path: ['peakValley', 'sessions'], value: sessions },
          { op: 'set', path: ['peakValley', 'lastToggle'], value: lastToggle },
        ]
        if (typeof form.mutate !== 'function') return Promise.resolve(false)
        return Promise.resolve(form.mutate(ops))
      }

      /**
       * 保存「时区 + 两条路由」。
       *
       * 一次原子写入多个路径；任意一项被宿主拒绝就整份失败，不会留下半套配置。
       * @param form 配置表单。
       * @param patch 只带需要改的字段。
       * @returns 宿主是否接受。
       */
      const saveRoutes = (form, patch) => {
        if (form === undefined || typeof form.mutate !== 'function') return Promise.resolve(false)
        const ops = []
        if (patch.timeZone !== undefined) ops.push({ op: 'set', path: ['peakValley', 'timeZone'], value: patch.timeZone })
        if (patch.peakWindows !== undefined) ops.push({ op: 'set', path: ['peakValley', 'peakWindows'], value: patch.peakWindows })
        if (patch.offPeakRoute !== undefined) ops.push({ op: 'set', path: ['peakValley', 'offPeakRoute'], value: patch.offPeakRoute })
        if (ops.length === 0) return Promise.resolve(true)
        return Promise.resolve(form.mutate(ops))
      }

      /**
       * 清掉所有「按会话覆盖」，让每个会话都回到默认值。
       * @param form 配置表单。
       * @returns 宿主是否接受。
       */
      const clearSessions = (form) => {
        if (form === undefined || typeof form.mutate !== 'function') return Promise.resolve(false)
        return Promise.resolve(form.mutate([{ op: 'set', path: ['peakValley', 'sessions'], value: {} }]))
      }

      /**
       * 设置页需要的动作。
       *
       * 设置页与齿轮弹层共用这一份，保证两处行为完全一致。
       */
      const settingsActions = () => {
        const form = configForm()
        return {
          form,
          readState: () => readState(form),
          // 设置页改的是「新会话的默认值」，不动任何既有会话。
          setEnabled: (next) => setSessionEnabled(form, undefined, next),
          // 整个功能的开关：关掉后宿主不再改动任何会话的模型位。
          setFeatureEnabled: (next) => writeSection(form, 'peakValley', { enabled: next }),
          saveRoutes: (patch) => saveRoutes(form, patch),
          clearSessions: () => clearSessions(form),
          loadCatalog,
        }
      }

      // -----------------------------------------------------------------
      // 输入框右侧的开关胶囊（齿轮弹出同一份设置）
      // -----------------------------------------------------------------
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'oh-my-dsh.peak-valley-toggle',
            order: 10,
            locale: PEAK_VALLEY_NS,
            inject: (sessionId) => {
              const form = configForm()
              return {
                sessionId,
                settingsActions,
                readState: () => readState(form),
                setEnabled: (next) => setSessionEnabled(form, sessionId, next),
                // 可观察源 → `useConfig`。session 作用域的标准源是严格的：
                // 缺键会在渲染期抛错，所以缺席时用只读空源占位。
                hooks: { config: form ?? ABSENT_SOURCE },
              }
            },
          },
          PeakValleyChip,
        ),
      )

      // 设置页只有一个（见 registerUi）：这里只交出本功能那一段的渲染入口，
      // 由合并页按板块摆放。
      return { t, Settings: PeakValleySettings, actions: settingsActions }
    }

    /**
     * 输入框右侧的开关胶囊。
     *
     * 状态来自配置里 `sessions[sessionId]`：这个会话打开过就是开，否则就是关，
     * 与会话选了哪个模型无关。点一下写回配置，宿主下一次请求就按新值走。
     */
    function PeakValleyChip({ sessionId, useConfig, readState, setEnabled, settingsActions, t }) {
      // hook 必须无条件、固定顺序调用（React 规则）。
      const configSnapshot = useConfig((value) => value)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      // 齿轮弹出一个「宿主同款」浮层：portal 到 body，避免被输入框裁切。
      const [showPanel, setShowPanel] = React.useState(false)
      const [panelPos, setPanelPos] = React.useState(null)
      const rootRef = React.useRef(null)
      const panelRef = React.useRef(null)

      // 点浮层外面或按 Esc 关闭，与宿主菜单的手感一致。
      React.useEffect(() => {
        if (!showPanel) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target) === true) return
          if (panelRef.current?.contains(event.target) === true) return
          setShowPanel(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setShowPanel(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [showPanel])
      const [, setTick] = React.useState(0)

      // 跨时段后时段标签要跟着变：15 秒一跳，开销可忽略。
      React.useEffect(() => {
        const timer = setInterval(() => setTick((value) => value + 1), 15000)
        return () => clearInterval(timer)
      }, [])

      // 配置快照只用于触发重渲染；真值从同一份表单读，避免两处口径不一致。
      void configSnapshot
      const state = readState()
      const on = sessionOn(state, sessionId)

      // 当前命中的时段（没有命中就走窗口外路由）。
      const now = new Date()
      const hit = windowAt(state.peakWindows, now, state.timeZone ?? TIME_ZONE)

      const onClick = () => {
        if (busy) return
        setError(null)
        setBusy(true)
        setEnabled(!on)
          .then((accepted) => {
            if (accepted === false) throw new Error(t('notConfigurable'))
            // 这里刻意不直接改模型位：轮次进行中换模型会让下一次请求在工具循环
            // 中途换路由，服务端会拒绝「thinking 没有原样传回」。模型位由宿主
            // 在轮次之间统一对齐（切完开关宿主会立刻对齐一次，不必等巡检）。
            return undefined
          })
          .catch((failure) => {
            setError(format(t('chipFailed'), { error: failure?.message ?? String(failure) }))
          })
          .finally(() => setBusy(false))
      }

      const route = hit === undefined ? state.offPeakRoute : hit.route
      const label = on ? t('chipOn') : t('chipOff')
      const title = error ?? (on
        ? `${t('chipDisable')}\n${route.provider} / ${route.model}`
        : t('chipEnable'))

      // 开关本体：与设置页的「功能开关」同一个胶囊控件。
      const toggle = h(CapsuleSwitch, {
        on,
        busy,
        disabled: busy,
        label: busy ? t('chipBusy') : error !== null ? t('chipFailedShort') : label,
        error: error !== null,
        title,
        ariaLabel: `${t('title')}：${on ? t('stateOn') : t('stateOff')}`,
        onClick,
        extra: on && !busy
          ? h(
            'span',
            { className: 'pvm-period' },
            hit === undefined ? t('chipOutside') : `${formatClock(hit.start)}-${formatClock(hit.end)}`,
          )
          : null,
      })

      // 设置入口：用宿主自己的设置图标，点开同一份设置面板。
      const gear = h(
        'button',
        {
          type: 'button',
          className: 'pvm-iconButton pvm-gear',
          onClick: () => setShowPanel((value) => !value),
          'aria-expanded': showPanel,
          'aria-haspopup': 'dialog',
          title: t('openSettings'),
          'aria-label': t('openSettings'),
        },
        h(IconSettingsOutlineRegular, { size: 16 }),
      )

      // 浮层定位：贴在齿轮上方，超出视口就夹回来；滚动或尺寸变化时跟随。
      React.useLayoutEffect(() => {
        if (!showPanel) {
          setPanelPos(null)
          return undefined
        }
        const place = () => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const MARGIN = 12
          const width = panelRef.current?.offsetWidth ?? 0
          const height = panelRef.current?.offsetHeight ?? 0
          let left = rect.right - width
          let top = rect.top - 8 - height
          if (width > 0) left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN)
          if (height > 0) top = Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN)
          setPanelPos({ left, top })
        }
        place()
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        let observer
        if (typeof ResizeObserver !== 'undefined' && panelRef.current !== null) {
          observer = new ResizeObserver(place)
          observer.observe(panelRef.current)
        }
        return () => {
          observer?.disconnect()
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
        }
      }, [showPanel])

      // 弹层里复用设置页组件：两处看到的是同一份配置、同一套动作。
      // 未定位前先隐藏但参与布局，好让 offsetWidth/Height 是真的（官方菜单同做法）。
      const canPortal = typeof document !== 'undefined' && document.body != null
      const panel = !showPanel || settingsActions === undefined || !canPortal ? null : ReactDOM.createPortal(
        h(
          MenuSurface,
          {
            ref: panelRef,
            className: 'pvm-panel',
            style: panelPos ?? { visibility: 'hidden', left: 0, top: 0 },
            role: 'dialog',
            'aria-label': t('title'),
          },
          h(
            'div',
            { className: 'pvm-panelHead' },
            h('span', { className: 'pvm-panelTitle' }, t('title')),
            h(
              'button',
              {
                type: 'button',
                className: 'pvm-iconButton',
                title: t('close'),
                'aria-label': t('close'),
                onClick: () => setShowPanel(false),
              },
              h(IconCloseOutlineRegular, { size: 16 }),
            ),
          ),
          h('div', { className: 'pvm-panelBody' }, h(PeakValleySettings, { ...settingsActions(), t, compact: true })),
        ),
        document.body,
      )

      // 功能整体关掉时开关不出现：此时宿主也不会改动任何会话的模型位。
      if (!state.enabled) return null

      return h(
        'span',
        { className: 'pvm-root', ref: rootRef },
        toggle,
        gear,
        panel,
        error !== null ? h('span', { className: 'pvm-errorDot', title: error, 'aria-hidden': true }) : null,
      )
    }

    /** 把一份配置快照转成表单草稿。 */
    function draftOf(state) {
      const route = (value) => ({ provider: value?.provider ?? '', model: value?.model ?? '' })
      return {
        timeZone: state.timeZone ?? TIME_ZONE,
        off: route(state.offPeakRoute),
        windows: (Array.isArray(state.peakWindows) ? state.peakWindows : []).map((raw) => ({
          start: raw?.start ?? '',
          end: raw?.end ?? '',
          provider: raw?.provider ?? '',
          model: raw?.model ?? '',
        })),
      }
    }

    /** 设置页：默认开关 + 时段表（时间 + 模型）+ 窗口外路由 + 时区 + 覆盖清理。 */
    function PeakValleySettings({ form, readState, setEnabled, setFeatureEnabled, saveRoutes, clearSessions, loadCatalog, t, compact = false, embedded = false }) {
      const [state, setState] = React.useState(() => readState())
      const [draft, setDraft] = React.useState(() => draftOf(readState()))
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      // 模型目录：provider / model 下拉的选项来源。
      const [groups, setGroups] = React.useState([])

      // 载入宿主模型目录，供 provider / model 下拉使用。
      React.useEffect(() => {
        if (typeof loadCatalog !== 'function') return undefined
        let live = true
        loadCatalog()
          .then((catalog) => {
            if (live) setGroups(catalog.groups)
          })
          .catch(() => {})
        return () => {
          live = false
        }
      }, [])

      // 配置在别处被改（含胶囊）时同步显示值与草稿。
      React.useEffect(() => {
        if (form === undefined || typeof form.subscribe !== 'function') return undefined
        return form.subscribe(() => {
          const next = readState()
          setState(next)
          // 写入还没落地时，快照里还是旧值；此时覆盖草稿会让用户刚改的选择跳回去。
          if (pendingWrites.current === 0) setDraft(draftOf(next))
        })
      }, [])

      const writable = state.writable
      const hit = windowAt(state.peakWindows, new Date(), state.timeZone ?? TIME_ZONE)
      const overrides = Object.keys(state.sessions ?? {}).length
      const routeText = (route) => (route === undefined ? '—' : `${route.provider} / ${route.model}`)
      /** 当前开启了峰谷动态的会话数。 */
      const enabledCount = Object.values(state.sessions ?? {}).filter((value) => value === true).length

      /** 保存提示只闪一下，不打断编辑。 */
      const flashTimer = React.useRef(undefined)
      React.useEffect(() => () => clearTimeout(flashTimer.current), [])
      /** 写入串行化：保证连点两次时，后一次基于前一次的结果，不会互相覆盖。 */
      const queue = React.useRef(Promise.resolve())
      /** 正在写入的次数：>0 时不要用配置快照覆盖用户刚做的选择。 */
      const pendingWrites = React.useRef(0)

      /**
       * 改一下就写。
       *
       * 没有保存按钮：下拉一变就落库。界面先按用户的选择更新（乐观），
       * 写入失败再把错误显示出来；校验不过只提示、不把坏值写进配置。
       *
       * @param next 界面上的下一份草稿。
       * @param patch 要写的字段（只写变了的）。
       * @param problem 校验错误文案；有值就只提示不写。
       */
      const commit = (next, patch, problem) => {
        setDraft(next)
        if (problem !== undefined) {
          setError(problem)
          return
        }
        setError(null)
        if (!writable) return
        pendingWrites.current += 1
        queue.current = queue.current
          .then(() => saveRoutes(patch))
          .then((accepted) => {
            if (accepted === false) throw new Error(t('notConfigurable'))
            setSaved(true)
            clearTimeout(flashTimer.current)
            flashTimer.current = setTimeout(() => setSaved(false), 1500)
            setState(readState())
          })
          .catch((failure) => {
            setError(format(t('saveFailed'), { error: failure?.message ?? String(failure) }))
          })
          .finally(() => {
            pendingWrites.current -= 1
          })
      }

      /** 一行时段是否可用：时间能解析 + 路由不缺项。 */
      const rowProblem = (row) => (
        parseClock(row.start.trim()) === undefined || parseClock(row.end.trim()) === undefined
        || row.provider.trim() === '' || row.model.trim() === ''
          ? t('invalidWindow')
          : undefined
      )

      /** 逐行校验整张时段表。 */
      const windowsProblem = (windows) => {
        for (const row of windows) {
          const problem = rowProblem(row)
          if (problem !== undefined) return problem
        }
        return undefined
      }

      /** 写进配置的形状：时间统一成 `HH:MM`。 */
      const storedWindows = (windows) => windows.map((row) => ({
        start: formatClock(parseClock(row.start.trim())),
        end: formatClock(parseClock(row.end.trim())),
        provider: row.provider.trim(),
        model: row.model.trim(),
      }))

      const setWindow = (index, patch) => {
        const windows = draft.windows.map((row, at) => (at === index ? { ...row, ...patch } : row))
        const problem = windowsProblem(windows)
        commit(
          { ...draft, windows },
          problem === undefined ? { peakWindows: storedWindows(windows) } : undefined,
          problem,
        )
      }

      const addWindow = () => {
        const last = draft.windows[draft.windows.length - 1]
        const windows = [
          ...draft.windows,
          { start: '00:00', end: '00:00', provider: last?.provider ?? '', model: last?.model ?? '' },
        ]
        const problem = windowsProblem(windows)
        commit(
          { ...draft, windows },
          problem === undefined ? { peakWindows: storedWindows(windows) } : undefined,
          problem,
        )
      }

      const removeWindow = (index) => {
        const windows = draft.windows.filter((_row, at) => at !== index)
        const problem = windowsProblem(windows)
        commit(
          { ...draft, windows },
          problem === undefined ? { peakWindows: storedWindows(windows) } : undefined,
          problem,
        )
      }

      /** 时区与窗口外路由也是改即写。 */
      const setTimeZone = (timeZone) => {
        commit(
          { ...draft, timeZone },
          timeZone.trim() === '' ? undefined : { timeZone: timeZone.trim() },
          timeZone.trim() === '' ? t('invalid') : undefined,
        )
      }

      const setOffRoute = (off) => {
        const route = { provider: off.provider.trim(), model: off.model.trim() }
        commit(
          { ...draft, off: route },
          route.provider === '' || route.model === '' ? undefined : { offPeakRoute: route },
          route.provider === '' || route.model === '' ? t('invalid') : undefined,
        )
      }

      const run = (operation, label) => {
        if (busy || !writable) return
        setBusy(true)
        setError(null)
        setSaved(false)
        Promise.resolve(operation())
          .then((accepted) => {
            if (accepted === false) throw new Error(label)
            setSaved(true)
            setState(readState())
          })
          .catch((failure) => {
            setError(format(t('saveFailed'), { error: failure?.message ?? String(failure) }))
          })
          .finally(() => setBusy(false))
      }

      /**
       * 时间下拉：15 分钟一档。
       *
       * 当前值若不在这一档网格上（例如手写过 09:07），保留成一个选项，不擅自改配置。
       * @param value 当前 `HH:MM`。
       * @param onChange 变更回调。
       * @param label 无障碍标签。
       */
      const clockSelect = (value, onChange, label) => {
        const options = clockOptions()
        const normalized = typeof value === 'string' ? value : ''
        const list = options.includes(normalized) || normalized === '' ? options : [normalized, ...options]
        return h(
          'label',
          { className: 'pvm-selectWrap' },
          h('span', { className: 'pvm-srOnly' }, label),
          h(
            'select',
            {
              className: 'pvm-select',
              value: normalized,
              disabled: !writable || busy,
              onChange: (event) => onChange(event.target.value),
            },
            normalized === '' ? h('option', { value: '' }, label) : null,
            list.map((option) => h('option', { key: option, value: option }, option)),
          ),
        )
      }

      /**
       * 一组 provider / model 下拉。
       *
       * 选项来自宿主目录；当前值若不在目录里（刚被下线、或手工填过），
       * 仍然保留为一个选项，避免"打开设置就悄悄改掉配置"。
       * @param value 当前路由。
       * @param onChange 变更回调。
       * @param labelPrefix 无障碍标签前缀。
       */
      const routeSelects = (value, onChange, labelPrefix) => {
        const providerIds = groups.map((group) => group.id)
        const models = groups.find((group) => group.id === value.provider)?.models ?? []
        const providerOptions = providerIds.includes(value.provider) || value.provider === ''
          ? providerIds
          : [value.provider, ...providerIds]
        const modelIds = models.map((model) => model.id)
        const modelOptions = modelIds.includes(value.model) || value.model === ''
          ? modelIds
          : [value.model, ...modelIds]
        const modelName = (id) => models.find((model) => model.id === id)?.name ?? id

        return h(
          'div',
          { className: 'pvm-inputs' },
          h(
            'label',
            { className: 'pvm-selectWrap' },
            h('span', { className: 'pvm-srOnly' }, `${labelPrefix} ${t('providerLabel')}`),
            h(
              'select',
              {
                className: 'pvm-select',
                value: value.provider,
                disabled: !writable || busy,
                onChange: (event) => {
                  const provider = event.target.value
                  // 换 provider 时，模型跟着落到该 provider 的第一个模型。
                  const nextModels = groups.find((group) => group.id === provider)?.models ?? []
                  const keep = nextModels.some((model) => model.id === value.model)
                  onChange({ provider, model: keep ? value.model : (nextModels[0]?.id ?? '') })
                },
              },
              value.provider === '' ? h('option', { value: '' }, t('providerLabel')) : null,
              providerOptions.map((id) => h('option', { key: id, value: id }, id)),
            ),
          ),
          h(
            'label',
            { className: 'pvm-selectWrap' },
            h('span', { className: 'pvm-srOnly' }, `${labelPrefix} ${t('modelLabel')}`),
            h(
              'select',
              {
                className: 'pvm-select',
                value: value.model,
                disabled: !writable || busy || modelOptions.length === 0,
                onChange: (event) => onChange({ provider: value.provider, model: event.target.value }),
              },
              value.model === '' ? h('option', { value: '' }, t('modelLabel')) : null,
              modelOptions.map((id) => h('option', { key: id, value: id }, `${modelName(id)} · ${id}`)),
            ),
          ),
        )
      }

      /** 一个时段行：时间区间 + 该区间的模型 + 删除。 */
      const windowRow = (row, index) => h(
        'div',
        { className: 'pvm-field', key: `window-${index}` },
        h(
          'div',
          { className: 'pvm-fieldHead' },
          h('span', null, t('windowLabel', { index: index + 1 })),
          h(
            'button',
            {
              type: 'button',
              className: 'pvm-linkButton',
              disabled: !writable || busy,
              onClick: () => removeWindow(index),
            },
            t('remove'),
          ),
        ),
        h(
          'div',
          { className: 'pvm-inputs' },
          clockSelect(row.start, (start) => setWindow(index, { start }), `${t('windowLabel', { index: index + 1 })} ${t('startLabel')}`),
          clockSelect(row.end, (end) => setWindow(index, { end }), `${t('windowLabel', { index: index + 1 })} ${t('endLabel')}`),
        ),
        routeSelects(
          { provider: row.provider, model: row.model },
          (next) => setWindow(index, next),
          t('windowLabel', { index: index + 1 }),
        ),
      )

      return h(
        'div',
        { className: 'pvm-section' },
        // 独立的设置页（齿轮浮层）自带标题与说明；并入合并页时标题和开关
        // 由板块头负责，这里从简介开始画。
        compact || embedded ? null : h('h2', { className: 'pvm-heading' }, t('title')),
        compact ? null : h('p', { className: 'pvm-intro' }, t('description')),

        // 功能开关：关掉后宿主空转，界面上的开关与会话覆盖都随之失效。
        // 合并页把开关放在板块头（收起时也够得着），这里就不重复画了。
        embedded ? null : h(
          'div',
          { className: 'pvm-row' },
          h(
            'div',
            { className: 'pvm-rowText' },
            h('div', { className: 'pvm-rowTitle' }, t('featureLabel')),
            h('div', { className: 'pvm-rowHint' }, t('featureHint')),
          ),
          h(CapsuleSwitch, {
            on: state.enabled,
            disabled: !writable || busy,
            label: state.enabled ? t('featureOn') : t('featureOff'),
            ariaLabel: t('featureLabel'),
            onClick: () => run(() => setFeatureEnabled(!state.enabled), t('notConfigurable')),
          }),
        ),

        // 说明性行：开关是按会话的，这里没有「全局默认」。
        h(
          'div',
          { className: 'pvm-row' },
          h(
            'div',
            { className: 'pvm-rowText' },
            h('div', { className: 'pvm-rowTitle' }, t('defaultState')),
            h('div', { className: 'pvm-rowHint' }, t('defaultStateHint')),
          ),
          h(
            'span',
            { className: 'pvm-badge' },
            `${t('statesCount', { count: enabledCount })} · ${state.lastToggle?.on ? t('nextSessionOn') : t('nextSessionOff')}`,
          ),
        ),

        // 此刻生效的路由。
        h(
          'div',
          { className: 'pvm-row' },
          h(
            'div',
            { className: 'pvm-rowText' },
            h('div', { className: 'pvm-rowTitle' }, t('currentPeriod')),
            h('div', { className: 'pvm-value' }, routeText(hit === undefined ? state.offPeakRoute : hit.route)),
          ),
          h(
            'span',
            { className: 'pvm-badge' },
            hit === undefined ? t('chipOutside') : `${formatClock(hit.start)}-${formatClock(hit.end)}`,
          ),
        ),

        // 时段表。
        h('div', { className: 'pvm-fieldHead' }, t('windowsLabel')),
        h('div', { className: 'pvm-rowHint' }, t('windowsHint')),
        ...draft.windows.map(windowRow),
        h(
          'div',
          { className: 'pvm-actions' },
          h(
            'button',
            { type: 'button', className: 'pvm-button', disabled: !writable || busy, onClick: addWindow },
            t('addWindow'),
          ),
        ),

        // 窗口外路由。
        h(
          'div',
          { className: 'pvm-field' },
          h('div', { className: 'pvm-fieldHead' }, t('offPeakRoute')),
          h('div', { className: 'pvm-rowHint' }, t('offPeakHint')),
          routeSelects(draft.off, setOffRoute, t('offPeakRoute')),
        ),

        // 时区。
        h(
          'div',
          { className: 'pvm-field' },
          h('div', { className: 'pvm-fieldHead' }, t('timeZoneLabel')),
          h('div', { className: 'pvm-rowHint' }, t('timeZoneHint')),
          h(
            'label',
            { className: 'pvm-selectWrap' },
            h('span', { className: 'pvm-srOnly' }, t('timeZoneLabel')),
            h(
              'select',
              {
                className: 'pvm-select',
                value: draft.timeZone,
                disabled: !writable,
                onChange: (event) => setTimeZone(event.target.value),
              },
              (TIME_ZONE_OPTIONS.includes(draft.timeZone) ? TIME_ZONE_OPTIONS : [draft.timeZone, ...TIME_ZONE_OPTIONS])
                .filter((zone) => typeof zone === 'string' && zone !== '')
                .map((zone) => h('option', { key: zone, value: zone }, zone)),
            ),
          ),
        ),

        // 没有保存按钮：改动即写入，这里只留校验错误与一闪而过的「已保存」。
        error === null && !saved ? null : h(
          'div',
          { className: 'pvm-actions' },
          error === null ? null : h('p', { className: 'pvm-error', role: 'alert' }, error),
          saved && error === null ? h('p', { className: 'pvm-ok' }, t('saved')) : null,
        ),

        // 覆盖清理。
        h(
          'div',
          { className: 'pvm-row' },
          h(
            'div',
            { className: 'pvm-rowText' },
            h('div', { className: 'pvm-rowTitle' }, t('overridesLabel')),
            h('div', { className: 'pvm-rowHint' }, overrides === 0 ? t('overridesNone') : t('overridesCount', { count: overrides })),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'pvm-button',
              disabled: busy || !writable || overrides === 0,
              onClick: () => run(() => clearSessions(), t('notConfigurable')),
            },
            t('overridesClear'),
          ),
        ),
        writable ? null : h('p', { className: 'pvm-rowHint' }, t('notConfigurable')),
      )
    }


    /** 每个 Session 最近一次候选，切换会话再回来时不必重新生成。 */
    const bySession = new Map()

    const CANDIDATES_NS = 'oh-my-dsh.candidates'
    const candidatesZh = {
      'hint.acceptFirst': '采纳这条候选',
      'hint.dismiss': '关闭本次候选',
      'hint.group': '提示词候选',
      'settings.title': '输入框候选',
      'settings.enabled': '功能开关',
      'settings.enabledHint': '关掉后不再生成候选，输入框上方的这一行也不会出现。',
      'settings.on': '已开启',
      'settings.off': '已关闭',
      'settings.intro': '每回合结束后，用这个会话自己的模型读最近几条消息，生成几条下一条提示词候选，停在输入框上方；按 Tab 采纳第一条。',
      'settings.maxSuggestions': '最多生成几条建议',
      'settings.maxSuggestionsHint': '模型可以少给，但不会超过这个数。',
      'settings.maxSuggestionsUnit': '{count} 条',
      'settings.historyMessages': '送给模型的最近消息条数',
      'settings.historyMessagesHint': '用户消息与助手消息各算一条；最近的用户消息总会带上。',
      'settings.saved': '已保存',
      'settings.saveFailed': '保存失败：{error}',
      'settings.invalidNumber': '请输入 1 到 40 之间的整数。',
      'settings.notWritable': '当前配置不可写：宿主没有提供可编辑的配置层。',
      'settings.unavailable': '宿主还没有提供这份配置，稍后再打开这一页。',
    }
    const candidatesEn = {
      'hint.acceptFirst': 'Accept this candidate',
      'hint.dismiss': 'Dismiss these candidates',
      'hint.group': 'Prompt candidates',
      'settings.title': 'Prompt candidates',
      'settings.enabled': 'Feature switch',
      'settings.enabledHint': 'When off, no candidates are generated and the row above the composer stays hidden.',
      'settings.on': 'On',
      'settings.off': 'Off',
      'settings.intro': 'After each turn, the conversation model reads the latest messages and proposes a few next prompts above the composer. Press Tab to accept the first one.',
      'settings.maxSuggestions': 'Maximum suggestions',
      'settings.maxSuggestionsHint': 'The model may return fewer, never more.',
      'settings.maxSuggestionsUnit': '{count}',
      'settings.historyMessages': 'Recent messages read by the model',
      'settings.historyMessagesHint': 'User and assistant messages each count; the newest user message is always included.',
      'settings.saved': 'Saved',
      'settings.saveFailed': 'Could not save: {error}',
      'settings.invalidNumber': 'Enter a whole number from 1 to 40.',
      'settings.notWritable': 'Configuration is read-only: the host exposes no editable layer.',
      'settings.unavailable': 'The host does not serve this configuration yet; reopen this page later.',
    }

    // 与「目标」横条同一套视觉：菜单底色 + 面板阴影 + 36px 圆角条，停靠在输入框上方。
    const STYLE = `
.dpc-dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4);margin:0 auto}
.dpc-bar{isolation:isolate;box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4);
  height:36px;border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);
  align-items:center;gap:8px;margin:0 auto;padding:4px 5px 4px 10px;display:flex;position:relative}
.dpc-bar:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);
  backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}
.dpc-key{flex:none;display:inline-flex;align-items:center;height:20px;padding:0 6px;border-radius:6px;
  border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px}
.dpc-scroll{min-width:0;flex:1;display:flex;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;
  white-space:nowrap;scrollbar-width:none;overscroll-behavior-x:contain}
.dpc-scroll::-webkit-scrollbar{display:none}
.dpc-chip{flex:none;white-space:nowrap;
  border:0;border-radius:6px;background:0 0;padding:3px 8px;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dpc-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpc-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dpc-chip[data-first]{color:var(--dsw-alias-label-primary);font-weight:500}
.dpc-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
  padding:0;border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dpc-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dpc-close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dpc-note{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
/* 设置页：与官方设置页同一套排版（标题、说明、分隔行、右侧控件）。 */
.omd-set{box-sizing:border-box;max-width:720px;display:flex;flex-direction:column;gap:12px;
  color:var(--dsw-alias-label-primary)}
.omd-setIntro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
/* 合并后的 OhMyDSH 设置页：一个标题 + 每个功能一个可折叠板块。 */
.omd-page{box-sizing:border-box;max-width:720px;display:flex;flex-direction:column;gap:14px;
  color:var(--dsw-alias-label-primary)}
.omd-pageTitle{margin:0;font-size:18px;font-weight:600;line-height:26px}
.omd-pageIntro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.omd-block{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.omd-blockHead{display:flex;align-items:center;gap:16px;padding:12px 16px}
.omd-blockText{display:flex;flex-direction:column;flex:1;gap:3px;min-width:0}
.omd-blockTitle{font-size:14px;font-weight:600;line-height:22px}
.omd-blockHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.omd-blockError{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
/* 关掉的功能只留板块头（开关还在），正文用 grid 行高折叠，展开/收起都有过渡。 */
.omd-blockBody{display:grid;grid-template-rows:1fr;transition:grid-template-rows .2s ease}
.omd-block[data-open="false"] .omd-blockBody{grid-template-rows:0fr}
.omd-blockClip{min-height:0;overflow:hidden}
.omd-blockContent{padding:0 16px 6px}
.omd-blockContent .omd-setRow:last-child,.omd-blockContent .pvm-row:last-child{border-bottom:0}
@media (prefers-reduced-motion:reduce){.omd-blockBody{transition:none}}
.omd-setRow{display:flex;align-items:center;gap:16px;padding:14px 0;
  border-bottom:.5px solid var(--dsw-alias-border-l2)}
.omd-setText{display:flex;flex-direction:column;flex:1;gap:3px;min-width:0}
.omd-setTitle{font-size:14px;line-height:22px}
.omd-setHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.omd-selectWrap{position:relative;display:block;flex:none}
.omd-select{box-sizing:border-box;min-width:88px;height:32px;padding:0 26px 0 10px;font:inherit;font-size:13px;
  line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
  border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);appearance:none;cursor:pointer}
.omd-selectWrap:after{content:"";position:absolute;right:10px;top:50%;width:6px;height:6px;margin-top:-4px;
  border-right:1.2px solid var(--dsw-alias-label-caption);border-bottom:1.2px solid var(--dsw-alias-label-caption);
  transform:rotate(45deg);pointer-events:none}
.omd-number{box-sizing:border-box;flex:none;width:96px;height:32px;padding:0 10px;font:inherit;font-size:13px;
  line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
  border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md)}
.omd-select:focus,.omd-number:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}
.omd-select:disabled,.omd-number:disabled{opacity:.55;cursor:default}
.omd-setMsg{margin:0;font-size:12px;line-height:18px}
.omd-setSaved{color:var(--dsw-alias-state-success-primary)}
.omd-setError{color:var(--dsw-alias-state-error-primary)}
.omd-setNote{color:var(--dsw-alias-label-tertiary)}
/* 功能开关（.omd-switch）是插件级共用控件，样式在模块顶层的 CSS 里，板块开关与峰谷开关同一份。 */
.omd-srOnly{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', fill: 'none' }))
    }

    /**
     * 这些原因都是正常情况（回合没结束、模型这轮没给东西等），不打扰用户；
     * 其余原因属于真出问题，值得在输入框上方说一句。
     */
    const QUIET_REASONS = new Set([
      'disabled',
      'session-inactive',
      'aborted',
      'not-at-turn-end',
      'no-assistant-text',
      'no-request-header',
      'no-user-message',
      'no-candidates',
    ])

    /** 只有裸 Tab 才算采纳手势：带修饰键、输入法组合中或长按重复都放行。 */
    function isPlainTab(gesture) {
      return gesture.code === 'Tab' && !gesture.shift && !gesture.control && !gesture.alt && !gesture.meta
        && !gesture.composing && !gesture.repeat
    }

    function registerCandidates(ctx) {
      ctx.effect(() => ctx.locale.register(CANDIDATES_NS, { zh: candidatesZh, en: candidatesEn }), 'oh-my-dsh: candidates dictionaries')
      // 槽位一般会注入 `t`；万一没有，退回自己绑定的同一个命名空间。
      const fallback = ctx.locale.bind(CANDIDATES_NS)

      function CandidateRow(props) {
        const { sessionId, useSession, useInput, inputActions, configForm, t } = props
        const enabled = useSectionEnabled(configForm, 'candidates')
        const running = useSession(session => session?.running === true)
        const draftEmpty = useInput(input => (input?.draft ?? '') === '' && (input?.attachmentIds?.length ?? 0) === 0)
        const editable = useInput(input => input?.phase !== 'submitting' && input?.phase !== 'adjudicating')
        const tr = typeof t === 'function' ? t : fallback
        const [items, setItems] = React.useState(() => bySession.get(sessionId) ?? null)
        const [problem, setProblem] = React.useState(null)
        const sawRunning = React.useRef(running)
        const root = React.useRef(null)
        const scroller = React.useRef(null)

        // 回合结束（running 由真变假）或刚打开会话时，向 Host 要一次候选。
        React.useEffect(() => {
          // 功能关掉时不再发起请求，也不显示任何东西。
          if (!enabled) {
            bySession.delete(sessionId)
            setItems(null)
            setProblem(null)
            return
          }
          if (running) {
            sawRunning.current = true
            bySession.delete(sessionId)
            setItems(null)
            setProblem(null)
            return
          }
          if (!sawRunning.current && bySession.has(sessionId)) return
          sawRunning.current = false
          const controller = new AbortController()
          ctx.remote.ohMyDsh.candidates({ sessionId }, controller.signal).then(result => {
            if (controller.signal.aborted) return
            if (!result.ok) {
              console.warn('[oh-my-dsh] request failed', result.error)
              setProblem(`请求失败：${String(result.error)}`)
              return
            }
            if (result.value.suggestions.length === 0) {
              if (QUIET_REASONS.has(result.value.reason)) {
                console.debug('[oh-my-dsh] suppressed:', result.value.reason)
                return
              }
              setProblem(`本轮未生成：${result.value.reason}`)
              return
            }
            bySession.set(sessionId, result.value.suggestions)
            setItems(result.value.suggestions)
          }, error => {
            if (!controller.signal.aborted) {
              console.warn('[oh-my-dsh] request failed', error)
              setProblem(`请求失败：${String(error?.message ?? error)}`)
            }
          })
          return () => controller.abort()
        }, [enabled, running, sessionId])

        const visible = enabled && items !== null && items.length > 0 && draftEmpty && editable && !running
        const noteVisible = !visible && problem !== null && draftEmpty && editable && !running

        const accept = React.useCallback(index => {
          const text = items?.[index]
          if (text === undefined) return false
          const span = inputActions.captureInsertion?.()
          const inserted = inputActions.insertText(text, span)
          if (!inserted) inputActions.setDraft(text)
          bySession.delete(sessionId)
          setItems(null)
          setProblem(null)
          return true
        }, [items, inputActions, sessionId])

        const dismiss = React.useCallback(() => {
          bySession.delete(sessionId)
          setItems(null)
          setProblem(null)
          inputActions.focus?.()
        }, [sessionId, inputActions])

        // 只有候选可见时才占用输入框里的 Tab；其余 Tab 用法保持原生。
        React.useEffect(() => {
          if (!visible) return
          return ctx.shortcuts.observeFixedInput(input => {
            if (input.type !== 'keydown' || input.gesture.defaultPrevented || !isPlainTab(input.gesture)) return
            if (input.context.region !== 'editable' || input.context.modal !== null) return
            // 只接管当前这个 composer 座位里的 Tab；别处的编辑区不受影响。
            const seat = root.current?.closest('[data-composer-seat]')
            if (!seat || !(input.context.target instanceof Node) || !seat.contains(input.context.target)) return
            if (accept(0)) input.consume()
          })
        }, [visible, accept])

        // 候选可能很长：滚轮停在条上时转成横向滚动（React 的 onWheel 是 passive 的，只能手动挂）。
        React.useEffect(() => {
          const el = scroller.current
          if (!el) return
          const onWheel = event => {
            if (event.deltaY === 0 || el.scrollWidth <= el.clientWidth) return
            event.preventDefault()
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientWidth : 1
            const step = event.deltaX !== 0 ? event.deltaX * scale : Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY) * scale, 60)
            el.scrollLeft += step
          }
          el.addEventListener('wheel', onWheel, { passive: false })
          return () => el.removeEventListener('wheel', onWheel)
        }, [visible, items])

        if (!visible) {
          if (!noteVisible) return null
          return h('div', { className: 'dpc-dock', 'data-dsh-prompt-candidates': true },
            h('style', null, STYLE),
            h('div', { className: 'dpc-bar' },
              h('div', { className: 'dpc-note', title: problem }, problem),
              h('button', {
                type: 'button',
                className: 'dpc-close',
                title: tr('hint.dismiss'),
                'aria-label': tr('hint.dismiss'),
                onClick: dismiss,
              }, h(CloseIcon))))
        }
        // 按钮按下时保持编辑器焦点；它们是 Tab 与关闭的指针替身。
        const keepFocus = event => event.preventDefault()
        return h('div', { ref: root, className: 'dpc-dock', 'data-dsh-prompt-candidates': true },
          h('style', null, STYLE),
          h('div', { className: 'dpc-bar', role: 'group', 'aria-label': tr('hint.group') },
            h('span', { className: 'dpc-key', title: tr('hint.acceptFirst') }, 'Tab'),
            h('div', { className: 'dpc-scroll', ref: scroller },
              items.map((text, index) => h('button', {
                key: `${index}:${text}`,
                type: 'button',
                className: 'dpc-chip',
                ...(index === 0 ? { 'data-first': '' } : {}),
                title: text,
                'aria-label': index === 0 ? `${tr('hint.acceptFirst')}: ${text}` : text,
                onMouseDown: keepFocus,
                onClick: () => {
                  accept(index)
                  inputActions.focus?.()
                },
              }, text))),
            h('button', {
              type: 'button',
              className: 'dpc-close',
              title: tr('hint.dismiss'),
              'aria-label': tr('hint.dismiss'),
              onMouseDown: keepFocus,
              onClick: dismiss,
            }, h(CloseIcon))))
      }

      /**
       * 设置页只调这两项：宿主把 volatile 字段投影成一份可写表单。
       * `maxSuggestions` 与 `historyMessages` 在 Host 侧是活引用，写入后下一次生成就生效。
       */
      const DEFAULTS = { maxSuggestions: 2, historyMessages: 12 }
      const SUGGESTION_CHOICES = [1, 2, 3, 4, 5]
      const HISTORY_MIN = 1
      const HISTORY_MAX = 40

      /** 宿主按「profile 条目 id」登记配置表单；本插件的条目 id 就是包名。 */
      const configForm = () => {
        const forms = ctx.get('configForms')
        if (forms === undefined || typeof forms.get !== 'function') return undefined
        return forms.get(PACKAGE)
      }

      /** 把表单快照摊成页面直接使用的形状。 */
      const readForm = form => {
        const snapshot = form?.getSnapshot?.()
        const value = readSection(form, 'candidates')
        const pick = key => (Number.isInteger(value[key]) ? value[key] : DEFAULTS[key])
        return {
          status: snapshot?.status ?? 'missing',
          writable: snapshot?.status === 'ready' && snapshot?.writable === true,
          maxSuggestions: pick('maxSuggestions'),
          historyMessages: pick('historyMessages'),
        }
      }

      /** 一行设置：标题、说明、右侧控件。 */
      function settingsRow(title, hint, control) {
        return h('div', { className: 'omd-setRow' },
          h('div', { className: 'omd-setText' },
            h('div', { className: 'omd-setTitle' }, title),
            h('div', { className: 'omd-setHint' }, hint)),
          control)
      }

      /**
       * 设置页：改一下就写，没有保存按钮。
       *
       * 写入成功后宿主的表单快照会回来，页面跟着刷新；失败时按错误码提示。
       */
      function CandidateSettings(props) {
        const tr = typeof props.t === 'function' ? props.t : fallback
        const form = typeof props.getForm === 'function' ? props.getForm() : undefined
        const [view, setView] = React.useState(() => readForm(form))
        const [draft, setDraft] = React.useState(() => String(view.historyMessages))
        const [saved, setSaved] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        /** 在途写入数：>0 时不要拿旧快照覆盖用户刚输入的值。 */
        const pending = React.useRef(0)
        const timer = React.useRef(undefined)
        React.useEffect(() => () => clearTimeout(timer.current), [])

        // 配置被别处改动（含另一个窗口）时同步显示值与草稿。
        React.useEffect(() => {
          if (form === undefined || typeof form.subscribe !== 'function') return undefined
          const sync = () => {
            const next = readForm(form)
            setView(next)
            if (pending.current === 0) setDraft(String(next.historyMessages))
          }
          const off = form.subscribe(sync)
          sync()
          return off
        }, [form])

        const write = (field, value) => {
          if (form === undefined) return
          pending.current += 1
          setBusy(true)
          setError(null)
          setSaved(false)
          const request = form.mutate([{ op: 'set', path: ['candidates', field], value }])
          Promise.resolve(request)
            .then(accepted => {
              if (accepted === false) throw new Error(tr('settings.notWritable'))
              setSaved(true)
              clearTimeout(timer.current)
              timer.current = setTimeout(() => setSaved(false), 1500)
            })
            .catch(failure => setError(format(tr('settings.saveFailed'), { error: failure?.message ?? String(failure) })))
            .finally(() => {
              pending.current -= 1
              setBusy(false)
              setView(readForm(form))
            })
        }

        /** 条数输入框：离开焦点或回车时提交，非法值只提示、不写进配置。 */
        const commitHistory = () => {
          const value = Number(draft)
          if (!Number.isInteger(value) || value < HISTORY_MIN || value > HISTORY_MAX) {
            setError(tr('settings.invalidNumber'))
            return
          }
          setError(null)
          if (value !== view.historyMessages) write('historyMessages', value)
        }

        const disabled = !view.writable || busy
        // 标题与功能开关由合并页的板块头负责，这里只画这一段的设置内容。
        return h('section', { className: 'omd-set', 'data-dsh-prompt-candidates-settings': true },
          h('p', { className: 'omd-setIntro' }, tr('settings.intro')),
          settingsRow(
            tr('settings.maxSuggestions'),
            tr('settings.maxSuggestionsHint'),
            h('label', { className: 'omd-selectWrap' },
              h('span', { className: 'omd-srOnly' }, tr('settings.maxSuggestions')),
              h('select', {
                className: 'omd-select',
                value: view.maxSuggestions,
                disabled,
                onChange: event => write('maxSuggestions', Number(event.target.value)),
              }, SUGGESTION_CHOICES.map(count => h(
                'option',
                { key: count, value: count },
                format(tr('settings.maxSuggestionsUnit'), { count }),
              )))),
          ),
          settingsRow(
            tr('settings.historyMessages'),
            tr('settings.historyMessagesHint'),
            h('input', {
              className: 'omd-number',
              type: 'number',
              min: HISTORY_MIN,
              max: HISTORY_MAX,
              step: 1,
              value: draft,
              disabled,
              'aria-label': tr('settings.historyMessages'),
              onChange: event => setDraft(event.target.value),
              onBlur: commitHistory,
              onKeyDown: event => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                commitHistory()
              },
            }),
          ),
          view.status === 'unavailable'
            ? h('p', { className: 'omd-setMsg omd-setNote' }, tr('settings.unavailable'))
            : view.writable ? null : h('p', { className: 'omd-setMsg omd-setNote' }, tr('settings.notWritable')),
          error === null ? null : h('p', { className: 'omd-setMsg omd-setError', role: 'alert' }, error),
          saved && error === null ? h('p', { className: 'omd-setMsg omd-setSaved' }, tr('settings.saved')) : null,
        )
      }
      ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
        name: DOCK_SLOT,
        id: 'oh-my-dsh.candidates',
        order: 30,
        locale: CANDIDATES_NS,
        inject: () => ({ configForm: configFormOf(ctx) }),
      }, CandidateRow))
      // 设置页由 registerUi 统一注册；这里只交出本功能的设置内容。
      return { t: fallback, Settings: CandidateSettings }
    }


    //#region 输入历史：文案与条数上限
    const HISTORY_NS = 'oh-my-dsh.history'
    /** 默认一次往回翻多少条：与原 dsh-prompt-history 的运行值一致。 */
    const DEFAULT_LIMIT = 100
    /**
     * 向宿主请求条数时给的上界。
     *
     * 真正的条数由配置里的 `history.limit` 决定（宿主侧裁剪），这里只保证请求
     * 不会超过 schema 允许的最大值。
     */
    const HISTORY_LIMIT = 200

    const historyZh = {
      'settings.title': '输入历史',
      'settings.intro': '草稿为空时按 ↑ 召回你自己在本会话发过的上一条消息，继续按 ↑ 往前翻、按 ↓ 往后翻。助手、子 Agent 与框架注入的内容不会进入历史；召回只填进输入框，不会直接发送。',
      'settings.enabled': '功能开关',
      'settings.enabledHint': '关掉后 ↑/↓ 恢复编辑器原本的行为，历史记录本身不受影响。',
      'settings.on': '已开启',
      'settings.off': '已关闭',
      'settings.limit': '一次最多往回翻几条',
      'settings.limitHint': '取值 1–200，超过这个条数的更早消息不会被召回。',
      'settings.saved': '已保存',
      'settings.saveFailed': '保存失败：{error}',
      'settings.invalidNumber': '请输入 1 到 200 之间的整数。',
      'settings.notWritable': '当前配置不可写：宿主没有提供可编辑的配置层。',
      'settings.unavailable': '宿主还没有提供这份配置，稍后再打开这一页。',
    }
    const historyEn = {
      'settings.title': 'Prompt history',
      'settings.intro': 'Press Up in an empty composer to bring back the last message you sent in this session; keep pressing Up to go further back and Down to come forward. Assistant, sub-agent, and framework messages are not kept in this history, and recalled text only fills the draft, never sends it.',
      'settings.enabled': 'Feature switch',
      'settings.enabledHint': 'When off, Up/Down go back to the editor; the recorded history is unaffected.',
      'settings.on': 'On',
      'settings.off': 'Off',
      'settings.limit': 'Messages recalled at most',
      'settings.limitHint': 'From 1 to 200; older messages beyond this count are not recalled.',
      'settings.saved': 'Saved',
      'settings.saveFailed': 'Could not save: {error}',
      'settings.invalidNumber': 'Enter a whole number from 1 to 200.',
      'settings.notWritable': 'Configuration is read-only: the host exposes no editable layer.',
      'settings.unavailable': 'The host does not serve this configuration yet; reopen this page later.',
    }
    //#endregion


    /**
     * 编辑器会把段落末尾的空行裁掉，所以「草稿有没有被改过」不能只比全等。
     * @param a - 一侧文本。
     * @param b - 另一侧文本。
     * @returns 忽略尾部空白后是否相同。
     */
    const sameDraft = (a, b) => a === b || a.replace(/[\s\u200b]+$/u, '') === b.replace(/[\s\u200b]+$/u, '')

    /**
     * 光标落在第几行；多行草稿里把 ↑／↓ 留给光标移动。
     * @param actions - 输入框动作面，用 `captureInsertion` 读当前光标。
     * @param draft - 当前草稿文本。
     * @returns 光标是否在首行、是否在末行；读不到光标时按单行处理。
     */
    function caretLines(actions, draft) {
      if (!draft.includes('\n')) return { first: true, last: true }
      let span
      try {
        span = actions.captureInsertion?.()
      } catch {
        span = undefined
      }
      if (span === undefined || span === null) return { first: true, last: true }
      return {
        first: !draft.slice(0, span.start).includes('\n'),
        last: !draft.slice(span.end).includes('\n'),
      }
    }

    function registerHistory(ctx) {
      ctx.effect(() => ctx.locale.register(HISTORY_NS, { zh: historyZh, en: historyEn }), 'oh-my-dsh: history dictionaries')
      const fallback = ctx.locale.bind(HISTORY_NS)
      /**
       * 不渲染 DOM 的宿主组件：只订阅这个会话的输入状态，并把按键观察挂在插件生命周期上。
       *
       * 键盘回调不能随每次输入重新注册，所以用 `live` 影子对象读最新状态；
       * 召回位置与历史列表放在 `recall` 里，按会话重置。
       */
      function HistoryKeys(props) {
        const { sessionId, useInput, inputActions, configForm } = props
        const draft = useInput(input => input?.draft ?? '')
        const phase = useInput(input => input?.phase ?? 'plain')
        const attached = useInput(input => input?.attachmentIds?.length ?? 0)

        const live = React.useRef({ sessionId, draft, phase, attached })
        live.current = { sessionId, draft, phase, attached }
        const actions = React.useRef(inputActions)
        actions.current = inputActions
        // 功能开关：按键处理时现读，关掉后 ↑/↓ 完整交还给编辑器。
        const form = React.useRef(configForm)
        form.current = configForm

        /**
         * 每个会话一份状态：历史列表、在途请求、召回下标（0 = 最近一条）、
         * `stale` 表示列表可能还没读到刚提交的那条消息，`want` 是等待列表期间按下的 ↑ 次数。
         */
        const recall = React.useRef({
          session: null,
          messages: [],
          loading: null,
          index: -1,
          recalled: '',
          baseline: '',
          stale: true,
          want: 0,
        })

        const reset = React.useCallback(() => {
          const state = recall.current
          state.index = -1
          state.recalled = ''
          state.baseline = ''
          state.want = 0
        }, [])

        /** 把一段历史文本写进输入框，并记住「这是我们填的」。 */
        const fill = React.useCallback(text => {
          recall.current.recalled = text
          actions.current.setDraft(text)
        }, [])

        /** 焦点是否还在 composer 的编辑器里；异步回填前用它确认光标没有被挪走。 */
        const focused = () =>
          document.activeElement instanceof Element && document.activeElement.closest('[data-composer-input]') !== null

        /**
         * 读到历史后补上等待期间的 ↑：刚提交消息时列表更新比按键慢一点，
         * 这里回填最新一条（用户按过几次就退几步）。回填前重新确认输入框仍然空闲，
         * 不会覆盖用户在这段时间里写的草稿或加的附件。
         */
        const flush = React.useCallback(state => {
          const want = state.want
          state.want = 0
          if (want === 0 || state.index >= 0 || state.messages.length === 0) return
          const now = live.current
          if (now.phase !== 'plain' || now.attached > 0 || now.draft !== '' || !focused()) return
          state.baseline = now.draft
          state.index = Math.min(want - 1, state.messages.length - 1)
          fill(state.messages[state.messages.length - 1 - state.index])
        }, [fill])

        const load = React.useCallback(() => {
          const id = live.current.sessionId
          const state = recall.current
          if (id === undefined || state.loading !== null) return
          const pending = ctx.remote.ohMyDsh.history({ sessionId: id, limit: HISTORY_LIMIT })
          state.loading = pending
          pending.then(outcome => {
            if (state.loading === pending) state.loading = null
            if (recall.current !== state || live.current.sessionId !== id) return
            state.stale = false
            if (outcome.ok === false) {
              console.warn('[oh-my-dsh] 读取输入历史失败', outcome.error)
              return
            }
            const messages = outcome.value?.messages
            state.messages = Array.isArray(messages) ? messages.filter(text => typeof text === 'string' && text !== '') : []
            flush(state)
          }, error => {
            if (state.loading === pending) state.loading = null
            state.stale = false
            console.warn('[oh-my-dsh] 读取输入历史失败', error)
          })
        }, [flush])

        // 换会话：丢掉上一个会话的历史与召回位置，再读一次这个会话的历史。
        React.useEffect(() => {
          if (recall.current.session === sessionId) return
          recall.current.session = sessionId
          recall.current.messages = []
          recall.current.loading = null
          recall.current.stale = true
          reset()
          load()
        }, [sessionId, load, reset])

        // 一条输入被宿主接收后（输入框从冻结回到 plain），历史里就多了一条。
        // 消息落盘比提交回执慢，此刻读到的列表可能缺这一条，所以只标 stale，
        // 等下一次 ↑ 时再补读：那次读到的内容才可信。
        const lastPhase = React.useRef(phase)
        React.useEffect(() => {
          const before = lastPhase.current
          lastPhase.current = phase
          const settled = before === 'sending' || before === 'submitting' || before === 'adjudicating'
          if (settled && phase === 'plain') recall.current.stale = true
        }, [phase])

        React.useEffect(() => {
          return ctx.shortcuts.observeFixedInput(input => {
            if (input.type !== 'keydown') return
            const gesture = input.gesture
            if (gesture.composing || gesture.defaultPrevented) return
            if (gesture.control || gesture.alt || gesture.meta || gesture.shift) return
            const up = gesture.code === 'ArrowUp'
            if (!up && gesture.code !== 'ArrowDown') return
            if (input.context.region !== 'editable') return
            // 只接管 composer 自己的编辑器：会话标题、队列编辑这类别的编辑区保持原生。
            if (!(input.context.target instanceof Element)) return
            if (input.context.target.closest('[data-composer-input]') === null) return

            // 功能关掉时把 ↑/↓ 完整交还给编辑器。
            if (!sectionEnabled(form.current, 'history')) return
            const now = live.current
            const state = recall.current
            if (now.phase !== 'plain' || now.attached > 0) return
            if (state.session !== now.sessionId) return
            if (state.index >= state.messages.length) reset()

            // 用户改过被召回的文本：退出召回，接下来的按键按原生处理。
            if (state.index >= 0 && !sameDraft(now.draft, state.recalled)) reset()
            const lines = caretLines(actions.current, now.draft)

            if (up) {
              if (state.index >= 0) {
                if (!lines.first) return
                if (state.index + 1 < state.messages.length) {
                  state.index += 1
                  fill(state.messages[state.messages.length - 1 - state.index])
                }
                input.consume()
                return
              }
              // 草稿里已经有别的内容时，↑ 仍然是移动光标。
              if (now.draft.trim() !== '') return
              // 列表可能还没读到刚提交的消息：记下这次按键，读完历史再回填，避免只回填到旧的最近一条。
              if (state.stale) {
                state.want += 1
                load()
                input.consume()
                return
              }
              if (state.messages.length === 0) {
                load()
                return
              }
              state.baseline = now.draft
              state.index = 0
              fill(state.messages[state.messages.length - 1])
              input.consume()
              return
            }

            if (state.index < 0) return
            if (!lines.last) return
            input.consume()
            if (state.index === 0) {
              const baseline = state.baseline
              reset()
              fill(baseline)
              return
            }
            state.index -= 1
            fill(state.messages[state.messages.length - 1 - state.index])
          })
        }, [fill, load, reset])

        return null
      }


      ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register({
        name: DOCK_SLOT,
        id: 'oh-my-dsh.history',
        order: 40,
        locale: HISTORY_NS,
        inject: () => ({ configForm: configFormOf(ctx) }),
      }, HistoryKeys))

      /** 设置页的取值范围，与宿主 schema 一致。 */
      const LIMIT_MIN = 1
      const LIMIT_MAX = 200

      /** 把一份配置快照摊成页面直接使用的形状。 */
      function readHistoryForm(form) {
        const snapshot = form?.getSnapshot?.()
        const section = readSection(form, 'history')
        const status = snapshot?.status ?? 'missing'
        const limit = Number(section.limit)
        return {
          status,
          writable: status === 'ready' && snapshot?.writable === true,
          limit: Number.isInteger(limit) && limit >= LIMIT_MIN && limit <= LIMIT_MAX ? limit : DEFAULT_LIMIT,
        }
      }

      /** 设置页：功能开关 + 一次最多往回翻多少条。改一下就写，没有保存按钮。 */
      function HistorySettings(props) {
        const tr = typeof props.t === 'function' ? props.t : fallback
        const getForm = typeof props.getForm === 'function' ? props.getForm : () => undefined
        const [view, setView] = React.useState(() => readHistoryForm(getForm()))
        const [draft, setDraft] = React.useState(() => String(view.limit))
        const [saved, setSaved] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        /** 在途写入数：>0 时不要拿旧快照覆盖用户刚输入的值。 */
        const pending = React.useRef(0)
        const timer = React.useRef(undefined)
        React.useEffect(() => () => clearTimeout(timer.current), [])

        // 配置被别处改动（含另一个窗口）时同步显示值与草稿。
        React.useEffect(() => {
          const form = getForm()
          if (form === undefined || typeof form.subscribe !== 'function') return undefined
          const sync = () => {
            const next = readHistoryForm(form)
            setView(next)
            if (pending.current === 0) setDraft(String(next.limit))
          }
          const off = form.subscribe(sync)
          sync()
          return off
        }, [])

        const write = (patch) => {
          const form = getForm()
          if (form === undefined) return
          pending.current += 1
          setBusy(true)
          setError(null)
          setSaved(false)
          writeSection(form, 'history', patch)
            .then((accepted) => {
              if (accepted === false) throw new Error(tr('settings.notWritable'))
              setSaved(true)
              clearTimeout(timer.current)
              timer.current = setTimeout(() => setSaved(false), 1500)
            })
            .catch((failure) => setError(format(tr('settings.saveFailed'), { error: failure?.message ?? String(failure) })))
            .finally(() => {
              pending.current -= 1
              setBusy(false)
              setView(readHistoryForm(getForm()))
            })
        }

        /** 条数输入框：离开焦点或回车时提交，非法值只提示、不写进配置。 */
        const commitLimit = () => {
          const value = Number(draft)
          if (!Number.isInteger(value) || value < LIMIT_MIN || value > LIMIT_MAX) {
            setError(tr('settings.invalidNumber'))
            return
          }
          setError(null)
          if (value !== view.limit) write({ limit: value })
        }

        const disabled = !view.writable || busy
        // 标题与功能开关由合并页的板块头负责，这里只画这一段的设置内容。
        return h('section', { className: 'omd-set', 'data-oh-my-dsh-history-settings': true },
          h('p', { className: 'omd-setIntro' }, tr('settings.intro')),
          h('div', { className: 'omd-setRow' },
            h('div', { className: 'omd-setText' },
              h('div', { className: 'omd-setTitle' }, tr('settings.limit')),
              h('div', { className: 'omd-setHint' }, tr('settings.limitHint'))),
            h('input', {
              className: 'omd-number',
              type: 'number',
              min: LIMIT_MIN,
              max: LIMIT_MAX,
              step: 1,
              value: draft,
              disabled,
              'aria-label': tr('settings.limit'),
              onChange: (event) => setDraft(event.target.value),
              onBlur: commitLimit,
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                commitLimit()
              },
            }),
          ),
          view.status === 'unavailable'
            ? h('p', { className: 'omd-setMsg omd-setNote' }, tr('settings.unavailable'))
            : view.writable ? null : h('p', { className: 'omd-setMsg omd-setNote' }, tr('settings.notWritable')),
          error === null ? null : h('p', { className: 'omd-setMsg omd-setError', role: 'alert' }, error),
          saved && error === null ? h('p', { className: 'omd-setMsg omd-setSaved' }, tr('settings.saved')) : null,
        )
      }
      // 设置页由 registerUi 统一注册；这里只交出本功能的设置内容。
      return { t: fallback, Settings: HistorySettings }
    }

    //#region 合并后的设置页
    const PAGE_NS = 'oh-my-dsh.page'
    const pageZh = {
      title: 'OhMyDSH',
      intro: '各项功能可以单独开启或关闭，设置即时生效。',
      readOnly: '当前部署没有开放配置写入，这里只显示当前值。',
      sessionCreationTitle: '会话创建',
      sessionCreationDescription: '你可以让 agent 新开一个会话并交给它第一条任务。打开侧栏里的新会话即可继续对话。',
      sessionCreationOff: '已关闭会话创建。已有会话仍可继续使用。',
      on: '已开启',
      off: '已关闭',
      saveFailed: '保存失败：{error}',
    }
    const pageEn = {
      title: 'OhMyDSH',
      intro: 'Turn each feature on or off. Changes apply immediately.',
      readOnly: 'This deployment exposes no configuration writes; current values are read-only here.',
      sessionCreationTitle: 'Session creation',
      sessionCreationDescription: 'Ask your agent to start a separate conversation with a task. Open the new conversation in the sidebar to continue.',
      sessionCreationOff: 'Session creation is off. You can still use existing conversations.',
      on: 'On',
      off: 'Off',
      saveFailed: 'Could not save ({error})',
    }

    /** 设置导航图标：一峰一谷加一点火花，沿用插件的品牌形状。 */
    function OhMyDshIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M1.8 12 5.4 6.2 8.2 10 10.2 7 14.2 12',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 12.2, cy: 4, r: 1.4, fill: 'currentColor' }))
    }

    /**
     * 每项功能在同一页设置里占一个板块。
     *
     * 板块头就是功能开关；功能关掉时正文折叠（开关仍留在头上，随时能再打开）。
     * 正文保持挂载、用 grid 行高做过渡，所以收起再展开不会丢草稿。
     */
    function OhMyDshSettings({ getForm, peak, candidates, history, t }) {
      const form = typeof getForm === 'function' ? getForm() : undefined
      const snapshot = form?.getSnapshot?.()
      const writable = snapshot?.status === 'ready' && snapshot?.writable === true
      const peakOn = useSectionEnabled(form, 'peakValley')
      const candidatesOn = useSectionEnabled(form, 'candidates')
      const historyOn = useSectionEnabled(form, 'history')
      const creationOn = useSectionEnabled(form, 'sessionCreation')
      const [pending, setPending] = React.useState(null)
      const [failure, setFailure] = React.useState(null)

      const blocks = [
        {
          key: 'peakValley',
          on: peakOn,
          title: peak.t('title'),
          offHint: peak.t('featureHint'),
          labelOn: peak.t('featureOn'),
          labelOff: peak.t('featureOff'),
          notWritable: peak.t('notConfigurable'),
          saveFailed: error => format(peak.t('saveFailed'), { error }),
          body: h(peak.Settings, { ...peak.actions(), t: peak.t, embedded: true }),
        },
        {
          key: 'candidates',
          on: candidatesOn,
          title: candidates.t('settings.title'),
          offHint: candidates.t('settings.enabledHint'),
          labelOn: candidates.t('settings.on'),
          labelOff: candidates.t('settings.off'),
          notWritable: candidates.t('settings.notWritable'),
          saveFailed: error => format(candidates.t('settings.saveFailed'), { error }),
          body: h(candidates.Settings, { getForm: () => form, t: candidates.t }),
        },
        {
          key: 'history',
          on: historyOn,
          title: history.t('settings.title'),
          offHint: history.t('settings.enabledHint'),
          labelOn: history.t('settings.on'),
          labelOff: history.t('settings.off'),
          notWritable: history.t('settings.notWritable'),
          saveFailed: error => format(history.t('settings.saveFailed'), { error }),
          body: h(history.Settings, { getForm: () => form, t: history.t }),
        },
        {
          key: 'sessionCreation',
          on: creationOn,
          title: t('sessionCreationTitle'),
          offHint: t('sessionCreationOff'),
          labelOn: t('on'),
          labelOff: t('off'),
          notWritable: t('readOnly'),
          saveFailed: error => format(t('saveFailed'), { error }),
          body: h('p', { className: 'omd-setIntro' }, t('sessionCreationDescription')),
        },
      ]

      /** 切换某个功能的全局开关；失败时只在它自己的板块头里报错。 */
      const toggle = (block) => {
        if (!writable || pending !== null) return
        setPending(block.key)
        setFailure(null)
        Promise.resolve(writeSection(form, block.key, { enabled: !block.on }))
          .then((accepted) => {
            if (accepted === false) throw new Error(block.notWritable)
          })
          .catch((error) => setFailure({ key: block.key, message: block.saveFailed(error?.message ?? String(error)) }))
          .finally(() => setPending(null))
      }

      return h('section', { className: 'omd-page', 'data-oh-my-dsh-settings': true },
        h('style', null, STYLE),
        h('h2', { className: 'omd-pageTitle' }, t('title')),
        h('p', { className: 'omd-pageIntro' }, t('intro')),
        writable ? null : h('p', { className: 'omd-setMsg omd-setNote' }, t('readOnly')),
        blocks.map((block) => {
          const busy = pending === block.key
          return h('div', {
            key: block.key,
            className: 'omd-block',
            'data-feature': block.key,
            'data-open': block.on ? 'true' : 'false',
          },
            h('div', { className: 'omd-blockHead' },
              h('div', { className: 'omd-blockText' },
                h('div', { className: 'omd-blockTitle' }, block.title),
                block.on ? null : h('div', { className: 'omd-blockHint' }, block.offHint),
                failure?.key === block.key
                  ? h('div', { className: 'omd-blockError', role: 'alert' }, failure.message)
                  : null),
              h(CapsuleSwitch, {
                on: block.on,
                disabled: !writable || pending !== null,
                busy,
                label: block.on ? block.labelOn : block.labelOff,
                ariaLabel: block.title,
                onClick: () => toggle(block),
              })),
            h('div', {
              className: 'omd-blockBody',
              ...(block.on ? {} : { inert: '', 'aria-hidden': 'true' }),
            },
              h('div', { className: 'omd-blockClip' },
                h('div', { className: 'omd-blockContent' }, block.body))),
          )
        }),
      )
    }

    //#region 合并后的注册
    /**
     * 三个功能各自的界面注册，最后合成唯一一页设置。
     * @param ctx 已激活 `remote.ohMyDsh` 的浏览器侧上下文。
     */
    function registerUi(ctx) {
      const peak = registerPeakValley(ctx)
      const candidates = registerCandidates(ctx)
      const history = registerHistory(ctx)

      ctx.effect(
        () => ctx.locale.register(PAGE_NS, { zh: pageZh, en: pageEn }),
        'oh-my-dsh: page dictionaries',
      )
      const t = ctx.locale.bind(PAGE_NS)

      // 所有设置收在一页里，导航里只有一个「OhMyDSH」。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'oh-my-dsh',
        order: 35,
        label: () => t('title'),
        locale: PAGE_NS,
        inject: () => ({ getForm: () => configFormOf(ctx), peak, candidates, history, t }),
      }, OhMyDshSettings))
      ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
        name: 'settings.section.icon',
        id: 'oh-my-dsh',
        order: 35,
      }, OhMyDshIcon))
    }

    /**
     * 合并后需要的客户端服务。
     *
     * 与原插件的并集：峰谷动态要 `sessions` 与 `remote.session`（模型目录），
     * 候选与历史要 `shortcuts`（Tab / ↑ 的按键观察）。
     */
    const SERVICES = ['slots', 'remote', 'shortcuts', 'sessions', 'locale', 'remote.session']

    return {
      inject: SERVICES,
      async apply(ctx) {
        // 两个方法挂在同一个服务上：挂载一次，两边都可用。
        const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE)
        const ui = ctx.inject(
          ['remote.ohMyDsh', ...SERVICES.filter(name => name !== 'remote')],
          child => registerUi(child),
        )
        try {
          await ui
        } catch (error) {
          await ui.dispose()
          await unmountRemote()
          throw error
        }
        return async () => {
          await ui.dispose()
          await unmountRemote()
        }
      },
    }
  },
})
