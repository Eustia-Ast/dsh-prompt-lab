# Prompt Lab（提示词实验室）

以会话为范围控制系统提示词分段，支持覆盖/置空/新增；结合agent预设编辑、工具开关、消息追加等功能，在首轮对话前完成高自由度的提示词配置。

Prompt Lab 是一个 DeepSeek Harness（DSH）插件。打开一个会话的 Prompt Lab 并显式开启后，它可以在首轮对话之前改写、置空或在任意位置新增该会话的提示词分段，首轮后配置只读，仅提供当前提示词的状态参考；其他没有开启的会话继续使用 DSH 的官方装配。同时插件提供追加user消息和伪造的assistant消息的能力。插件提供一个简单的agent preset编辑界面，通过管理preset挂载的工具补足会话内插件的能力边界。它还提供模板库、提示词预设、自动备份、空白窗口草稿和按会话的 global 工具开关。首轮对话之后提示词编辑、提示词预设、自动备份等影响提示词装配的能力关闭，防止重复装配多版提示词。本插件暂不提供破限文本或预设。

> 当前版本：`1.2.1`。面板 UI 为中文；支持 DSH `0.2.2-rc.2` 到 `0.2.2-rc.5`。
>
> Prompt Lab 会改变模型收到的系统提示词和工具可见性，从而影响 Agent 的真实动作。修改系统提示词不是权限边界，也不能替代 DSH 的审批、沙箱或工具策略。

## 功能

- **按会话生效**：只处理你明确打开「对本会话生效」的会话；其他会话不受影响。
- **新会话分段编辑**：替换或置空系统提示词中的单个 section，不重写整篇提示词。首轮对话后该功能锁定，系统提示词段转为只读。
- **可复用模板**：同一 section 可以保存多个模板，首轮对话前随时切换或另存。
- **追加user消息**：可在单轮对话内主动追加多条user消息。
- **追加assistant消息**：构造完整轮次以达到人为构造一条assistant消息的效果。（该功能偏实验性，为防止轮次编号出现问题导致会话损坏，需要重启dsh以同步轮次）
- **预设**：把覆盖、新增段和工具开关保存为一组配置，应用到其他会话。
- **自动备份与恢复**：每次写入前保存会话快照；手动备份单独计数，恢复前再留一份快照。首轮对话后该功能关闭，快照自动删除。
- **空白窗口草稿**：会话开始首轮前先把配置写成草稿，首轮开始时自动提交；关闭窗口不会丢弃全局模板。
- **漂移检测**：首轮后，官方 section 文本变化时，已保存的覆盖会显示为「挂起」，会话中被覆盖的段官方文本变化后自动让位，插件不再参与更改。
- **完整提示词识别**：如果当前 preset 使用 `complete` 整篇提示词，面板会明确提示分段编辑不生效。
- **工具开关**：按会话关闭 global 工具，并同步隐藏对应的 `tool:<name>` 提示词段；agent preset/scoped 工具仍由 preset 控制。
- **敏感、越级项只读**：敏感来源只读：AGENTS/CLAUDE 指令文件、工具列表、装配结构只读；提示词段本身在首轮前可编辑（需额外确认）。
- **Agent 预设**：在「Agent 预设」页（面板右上角，位于「文本管理」左侧）新建/编辑/停用/删除本机注册的预设；提示词部分直接引用片段库，保存时物化为 `dsh-persona` 的前缀。Prompt Lab 用同一个公开接口注册自己的预设，因此不需要为每个预设装 bundle，也不写 profile patch：定义保存在 `<dataDir>/library/agent-presets.json`，Host 每次启动时重新注册。只影响新会话，已开启的会话保持它启动时的 preset，不会被改写，也没有“应用到当前会话”。内置 `standard / ptc / minimal / cordis` 只读：注册接口只拒绝“此刻已在名册里”的 id，先注册的行会赢，所以编辑器静态拒绝这四个 id，避免顶掉内置预设。手动添加的插件行只允许随 DSH 发布的包；复制官方预设时行名原样保留（若包含 profile 包，该行只能 JSON 编辑）。片段正文按所选顺序用空行拼接成 `dsh-persona` 的 `prefix`。停用插件时注册随 Cordis effect 一起撤掉。


## 安装

要求：

- DeepSeek Harness `0.2.2-rc.2` 到 `0.2.2-rc.5`
- Node.js `>=24.9.0`（与 DSH `@deepseek-ai/dsh` 的 engines 一致）

从 npm 安装：

```sh
dsh plugin --profile desktop add dsh-prompt-lab
```

如果你使用 `web` 或其他 profile，把 `desktop` 换成对应的 profile 名。

从 GitHub 源码安装：

```sh
dsh plugin --profile desktop add github:Eustia-Ast/dsh-prompt-lab
```

安装或升级后，完全退出 DSH 再重启，让 Host 重新加载插件。

## 使用

1. 打开一个新会话。
2. 点击输入框左下角的 **Prompt Lab**。
3. 打开 **「对本会话生效」**。
4. 在「提示词」页编辑需要的 section，或在「预设」「文本管理」「备份」「设置」页管理配置。

首次打开时，插件会尝试读取当前会话的官方装配。这个操作不会发送模型请求，也不会写入会话日志。
首轮对话后系统提示词完成装配固定，之后插件不会再提供编辑系统提示词的功能。

### 草稿窗口

如果会话还没有开始首轮对话，编辑会先写入这个窗口的草稿：

- 模板、预设、文本库属于全局内容，立即生效；
- 当前窗口的映射、新增段和启用状态在首轮对话开始时提交；
- 关闭窗口不会丢掉全局模板；未提交的窗口映射会按清理规则处理。

### 完整提示词

如果会话的 agent preset 使用 `complete` 模式（比如dsh自带的极简模式），DSH 会用 preset 的整篇提示词替代普通分段。此时 Prompt Lab 仍可保存配置，但分段改动不会生效；需要更换 preset 或修改 preset 配置后新建会话。

### 消息管理

「消息管理」里的追加 user / assistant 消息是显式操作，会写入真实的会话日志和合成轮次。它不是编辑器预览；使用前请确认你了解它会改变模型的可见历史。追加的assistant消息会被模型默认为是模型自己输出的消息，写入 assistant 消息后，插件会锁定该会话并要求重启 DSH，避免 turn 编号不一致。

### agent预设

「agent预设」里可按自己的需求新建preset，也可复制官方preset的配置后继续更改，提供可视化的编辑界面，保存后新preset会出现在新会话的预设选择栏中。此功能作用在dsh全局范围内，新增的preset对所有新会话适用。

## 安全边界

Prompt Lab 能改变 Agent 看到的内容，因此请把它当作**高权限的提示词编辑器**：

- 插入或改写人格类 section 可能误导 Agent 的身份认定；
- 改写工具协议、权限说明、计划规则等 section 可能让 Agent 误用工具或误判权限；
- 关闭 global 工具会影响该会话能执行的动作；
- 新增段可以写入任意指令，包括与 DSH 官方规则冲突的指令；
- 完整提示词 preset 不受分段编辑控制。

插件自身不做权限判断，不替代 DSH 的审批、沙箱和工具策略。请只在你信任的会话里使用，重要会话保留备份。

### 本地 HTTP 接口

面板通过 DSH Web server 上的同源路由 `/prompt-lab/api` 读写配置。该接口：

- 每个写请求先经过 DSH 的 `connection.requestRejection`：Host/Origin 栅栏加浏览器会话认证，未通过返回 401/403；没有 `connection` 服务的旧宿主退回下面的本地校验；
- 写请求必须是 `application/json`；带 `Origin` 时会校验它必须与 loopback Host 同源；
- 某些 DSH 宿主在同源 POST 上不发送 `Origin`，此时仍要求 loopback 客户端、loopback Host，并校验存在时的 `Sec-Fetch-Site`；
- 非本机网络客户端、非 loopback Host、`null` Origin 和跨站 `Sec-Fetch-Site` 会被拒绝；
- 不提供远程鉴权，也不应该通过反向代理、隧道或其他方式向不可信网络开放；
- 不调用模型、不发送遥测、不访问外部网络。

如果 DSH 的 Web server 绑定到非本机地址，请不要直接把这个插件暴露给不可信网络。

## 数据与隐私

默认数据目录：

- `$DSH_HOME/plugins/dsh-prompt-lab`（设置了 `DSH_HOME` 时）
- 否则 `~/.dsh/plugins/dsh-prompt-lab`

可以在「设置」里改到其他绝对路径；路径不能位于当前工作区或磁盘根目录，改路径时新旧目录不能互相包含，也不能包含插件配置目录。改路径不会立即移动数据，重启 DSH 时迁移。

目录内容：

| 内容 | 说明 |
|---|---|
| `config.json` | bootstrap 配置：数据目录、备份/预设上限 |
| `library/` | 分段模板、消息文本、预设 |
| `sessions/` | 每个会话的 `state.json`（覆盖、新增段、工具策略）和锁定前的 `backups/`；首轮锁定后写入 `locked.json`（全部段与官方 hash，官方段不存正文；不保存工具开关），并自动删除 `backups/`，之后不再创建或恢复备份 |
| `drafts/` | 首轮前的窗口草稿 |
| `pending/` | 预填充/追加消息后的重启锁 |
| `PROMPT-LAB-WORKSPACE-WARNING.md` | 提醒 Agent 不要改这个目录 |
| `.prompt-lab-owner.json` | 删除/清理操作的所有权标记 |

插件不会读取凭据，不会把提示词内容发送到任何服务器。所有数据都在本机；请自行备份重要模板。

## 兼容性与限制

- 支持 DSH `0.2.2-rc.2` 到 `0.2.2-rc.5`；使用 `agent.ctx.systemPrompt.section()`、`tools.restrict()` 等接口。
- `clientModules.graph().release`、`systemPrompt.layers` 等 DSH 内部接口在后续版本可能变化；升级 DSH 后建议重新验证分段采样和工具开关。`systemPrompt.layers` 仅作为兼容回退，不是稳定扩展契约。
- 可能与其他提供提示词修改能力的插件冲突。
- 面板 UI 目前只有中文；locale 中的英文仅有标题和描述。
- 分段编辑对 `complete` preset 不生效。
- 工具开关只覆盖 global 工具；scoped/preset 工具不可在面板里控制。
- 没有云同步、跨设备同步或团队共享。
- 大文本库/消息库会一次性加载到面板；非常大的库可能变慢。

## 开发

仓库没有运行时 npm 依赖。官方预设声明的 YAML 解析使用 `lib/vendor/js-yaml.mjs`（vendored 的 js-yaml 4.3.2 单文件，MIT），不通过 npm 安装。

```sh
npm test
```

测试覆盖 Host 装配、API、草稿、迁移、预设/文本库、诊断、客户端 bundle smoke，以及首轮锁定/拒绝改写、锁定快照 v1→v2 迁移、漂移让位、顺序校准失败回退、旧临时段字段丢弃、工具限制、常驻文本插入、归档会话清理和预设/备份适配的回归检查。

目录结构：

```text
index.js              Host 装配与生命周期
client.js             Web 面板
lib/engine.js         section 注册与装配采样
lib/store.js          数据存储
lib/api.js            JSON API
lib/agent-presets.js  Agent 预设的存储、校验与运行时注册
lib/vendor/           vendored 依赖（js-yaml 单文件）
lib/migrate.js        数据目录迁移
lib/pending.js        重启锁
lib/liveness.js       会话状态分类
lib/diagnostics.js    装配失败归因
locale/               插件标题/描述
```

## License

MIT。见 [LICENSE](LICENSE)。
