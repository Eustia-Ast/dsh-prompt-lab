# Prompt Lab（提示词实验室）

以会话为范围控制系统提示词分段 section，支持覆盖/置空/新增，保留漂移检测与恢复机制。

Prompt Lab 是一个 DeepSeek Harness（DSH）插件。打开一个会话的 Prompt Lab 并显式开启后，它可以改写、置空或在任意位置新增该会话的提示词分段；其他没有开启的会话继续使用 DSH 的官方装配。同时插件提供追加user消息和伪造的assistant消息的能力。它还提供模板库、预设、自动备份、空白窗口草稿和按会话的 global 工具开关。本插件暂不提供破限文本或预设。

> 当前版本：`1.0.0`。面板 UI 为中文；支持 DSH `0.2.2-rc.2` 到 `0.2.2-rc.5`。
>
> Prompt Lab 会改变模型收到的系统提示词和工具可见性，以及，从而影响 Agent 的真实动作，修改系统提示词不是权限边界，也不能替代 DSH 的审批、沙箱或工具策略。

## 功能

- **按会话生效**：只处理你明确打开「对本会话生效」的会话；其他会话不受影响。
- **分段编辑**：替换或置空系统提示词中的单个 section，不重写整篇提示词。
- **可复用模板**：同一 section 可以保存多个模板，随时切换或另存。
- **新增段与临时段**：在指定官方 section 前后插入自定义内容；临时段只用于下一轮。
- **追加user消息**：可在单轮对话内主动追加多条user消息。
- **追加assistant消息**：构造完整轮次以达到人为构造一条assistant消息的效果。（该功能偏实验性，为防止轮次编号出现问题导致会话损坏，需要重启dsh以同步轮次）
- **预设**：把覆盖、新增段、临时段和工具开关保存为一组配置，应用到其他会话。
- **自动备份与恢复**：每次写入前保存会话快照；手动备份单独计数，恢复前再留一份快照。
- **空白窗口草稿**：会话开始首轮前先把配置写成草稿，首轮开始时自动提交；关闭窗口不会丢弃全局模板。
- **漂移检测**：官方 section 文本变化时，已保存的覆盖会显示为「挂起」，不会静默覆盖新文本。
- **完整提示词识别**：如果当前 preset 使用 `complete` 整篇提示词，面板会明确提示分段编辑不生效。
- **工具开关**：按会话关闭 global 工具，并同步隐藏对应的 `tool:<name>` 提示词段；agent preset/scoped 工具仍由 preset 控制。
- **敏感、越级项只读**：展示 AGENTS/CLAUDE 指令文件、工具列表和当前装配结构，不修改这些来源。

## 安装

要求：

- DeepSeek Harness `0.2.2-rc.2` 到 `0.2.2-rc.5`
- Node.js `22.19+` 或 `24+`

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

1. 打开一个会话。
2. 点击输入框左下角的 **Prompt Lab**。
3. 打开 **「对本会话生效」**。
4. 在「提示词」页编辑需要的 section，或在「预设」「文本管理」「备份」「设置」页管理配置。

首次打开时，插件会尝试读取当前会话的官方装配。这个操作不会发送模型请求，也不会写入会话日志。

### 草稿窗口

如果会话还没有开始首轮对话，编辑会先写入这个窗口的草稿：

- 模板、预设、文本库属于全局内容，立即生效；
- 当前窗口的映射、新增段和启用状态在首轮对话开始时提交；
- 关闭窗口不会丢掉全局模板；未提交的窗口映射会按清理规则处理。

### 完整提示词

如果会话的 agent preset 使用 `complete` 模式（比如dsh自带的极简模式），DSH 会用 preset 的整篇提示词替代普通分段。此时 Prompt Lab 仍可保存配置，但分段改动不会生效；需要更换 preset 或修改 preset 配置后新建会话。

### 消息管理

「消息管理」里的追加 user / assistant 消息是显式操作，会写入真实的会话日志和合成轮次。它不是编辑器预览；使用前请确认你了解它会改变模型的可见历史。追加的assistant消息会被模型默认为是模型自己输出的消息，写入 assistant 消息后，插件会锁定该会话并要求重启 DSH，避免 turn 编号不一致。

## 安全边界

Prompt Lab 能改变 Agent 看到的内容，因此请把它当作**高权限的提示词编辑器**：

- 插入或改写人格类 section 可能误导 Agent 的身份认定；
- 改写工具协议、权限说明、计划规则等 section 可能让 Agent 误用工具或误判权限；
- 关闭 global 工具会影响该会话能执行的动作；
- 新增段可以写入任意指令，包括与 DSH 官方规则冲突的指令；
- 完整提示词 preset 不受分段编辑控制。

插件自身不做权限判断，不替代 DSH 的审批、沙箱和工具策略。请只在你信任的会话里使用，并保留备份。

### 本地 HTTP 接口

面板通过 DSH Web server 上的同源路由 `/prompt-lab/api` 读写配置。该接口：

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
| `sessions/` | 每个会话的覆盖、新增段、工具策略和备份 |
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

仓库没有运行时 npm 依赖。

```sh
npm test
```

测试覆盖 Host 装配、API、草稿、迁移、预设/文本库、诊断、客户端 bundle smoke 和本版本的回归检查。

目录结构：

```text
index.js              Host 装配与生命周期
client.js             Web 面板
lib/engine.js         section 注册与装配采样
lib/store.js          数据存储
lib/api.js            JSON API
lib/migrate.js        数据目录迁移
lib/pending.js        重启锁
lib/liveness.js       会话状态分类
lib/diagnostics.js    装配失败归因
locale/               插件标题/描述
```

## License

MIT。见 [LICENSE](LICENSE)。
