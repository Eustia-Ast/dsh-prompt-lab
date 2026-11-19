# 发布检查清单

这个目录将作为 `https://github.com/Eustia-Ast/dsh-prompt-lab` 发布。

## 0. 确认仓库所有者

已统一填写为 GitHub 账号 **Eustia-Ast**：

- `package.json` 的 `repository`、`homepage`、`bugs`
- `release/awesome-entry.yml`
- `README.md` 的 GitHub 安装命令

如果以后改 GitHub 用户名或组织，这三处必须一起改。

## 1. 本地检查

```sh
npm test
npm run check:pack
npm run check:release
```

`npm publish` 也会自动运行 `prepublishOnly`（测试 + npm 包内容检查 + 发行元数据检查）。在真实 GitHub 所有者尚未填写前，发布检查应当失败；这是有意的保护，不要绕过。

包内应包含运行时代码、`locale/`、`docs/`、`assets/`、`icon.png`、`README.md`、`CHANGELOG.md`、`LICENSE`；不应包含 `test/`、开发说明、`node_modules/` 或本地配置。

再检查没有本地路径、个人姓名、邮箱、凭据或工作区路径：

```sh
grep -RIn --exclude-dir=.git -E "(Users[/\\\\]|/home/|api[_-]?key|secret|password|BEGIN (RSA|OPENSSH) PRIVATE KEY)" .
```

## 2. 创建 GitHub 仓库

仓库名：`dsh-prompt-lab`。

```sh
git init
git add .
git commit -m "Initial Prompt Lab release candidate"
git remote add origin https://github.com/Eustia-Ast/dsh-prompt-lab.git
git push -u origin main
```

然后：

- 给仓库加 topic **`dsh-plugin`**；
- 启用 GitHub Actions；
- 确认 CI 在 Node 22.19 和 24 上通过。

awesome-dsh-plugin 目录要求仓库创建满 **1 天** 后才能提交收录 PR。

## 3. 发布 npm（推荐）

包名是 `dsh-prompt-lab`，首个版本是 `1.0.0`。

```sh
npm login
npm publish
```

如果本机没有终端，也可以在 GitHub 网页操作：

1. 在仓库 **Settings → Secrets and variables → Actions** 新建 `NPM_TOKEN`（npm 的 Automation token）；
2. 打开 **Actions → Publish npm → Run workflow**；
3. 工作流会先跑测试，再执行 `npm publish --provenance --access public`。

发布后：

```sh
npm view dsh-prompt-lab version
```

npm 包的 `repository` 必须指回 GitHub 仓库。目录会自动采集 npm 映射，不要在 awesome 条目里手写 `npm:` 字段。

如果不发 npm，目录仍可收录 GitHub 仓库，但安装命令会变成 `github:Eustia-Ast/dsh-prompt-lab` 的源码安装，也没有下载量统计。

## 4. 在干净 Profile 中安装验证

```sh
dsh plugin --profile <profile> add dsh-prompt-lab
```

完全退出 DSH 再重启（不是只刷新页面）。确认：

- 输入框旁出现 Prompt Lab 入口；
- 侧栏 Tab 和覆盖层都能打开；
- 开启一个会话只影响该会话；
- 保存覆盖、应用预设、恢复备份、提交草稿都正常；
- 插件详情页显示图标、描述和功能示意图。

如果同一 Profile 里还装着改名前的本地版本，请先移除：两个包使用同一个 patch entry id，同时安装会产生重复条目。数据目录共用，改名不会删除数据。

## 5. 社区发现与目录投稿

这些入口彼此独立，不要把第三方目录等同于 DSH 内置市场。

### GitHub Topic / DSH 插件发现

为公开仓库添加：

- `dsh-plugin`
- `deepseek-harness`

当前 DSH 插件市场按插件索引源工作；索引是第三方内容，用户应只添加信任的来源。是否进入某个索引，取决于该索引自己的收录规则，不是发布 npm 后自动获得官方背书。

### awesome-dsh-plugin 社区精选目录

当前投稿方式是新增一个 YAML 文件，而不是编辑生成后的 README：

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`。
2. 将 `release/awesome-entry.yml` 复制为 `data/plugins/Eustia-Ast__dsh-prompt-lab.yml`。
3. 填写真实仓库 URL、名称、分类和准确描述。
4. 确认仓库包含 `package.json` 的 `dsh.bundle` manifest 和真实可用代码。
5. 确认仓库创建已满 1 天，并已添加 `dsh-plugin` topic。
6. 提交 PR；一个 PR 最多新增 3 条目。

不要手动修改该仓库生成的 README。投稿描述必须与实际代码一致；维护者会检查声明和源码。

### 其他社区市场

例如 DSH Marketplace 等第三方站点有各自的同步、审核或提交流程。按其当前站点说明操作，不要把“被 GitHub topic 收录”描述成安全审计或官方认证。

## 6. 可选后续

- 以后有真实截图时，在仓库根添加 `screenshots.json`；市场会自动读取，不需要再提目录 PR。
- 仓库地址确定后，在 README 顶部加 CI badge。
- 英文详情页已由 `docs/DETAIL.md` 提供；如需其他语言，再添加 `docs/DETAIL.<lang>.md` 并在对应 locale 中声明 `meta.detail`。没有声明 detail 时插件管理器会回退到英文或 README。
- 每个新 DSH 版本重新验证。插件使用 `agent.ctx.systemPrompt.section()`、`tools.restrict()` 和若干 Host 服务；`systemPrompt.layers` 是内部回退路径。
