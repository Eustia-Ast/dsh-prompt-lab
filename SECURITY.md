# 安全策略

## 范围

Prompt Lab 是一个本机、单用户的 DeepSeek Harness 插件。它可以改变某个会话的系统提示词和该会话可见的 global 工具集合，也可以向会话追加 user 消息或构造 assistant 消息。它的本地 HTTP API 只接受 loopback 客户端、loopback Host 和 JSON 写请求；带 `Origin` 时要求与 loopback Host 同源，并拒绝 `null` Origin 及跨站 `Sec-Fetch-Site`。不要通过反向代理、隧道或其他方式将该接口暴露给不可信网络。

首轮对话开始后，本会话的 Prompt Lab 配置转为只读：提示词快照冻结，不再接受改写、新增、恢复或预设应用。快照 v2 记录每段的官方 hash；官方文本变化时，被覆盖的段会让位，改用新的官方文本。

本地 API 的每个写请求先经过 DSH Connection 的 `requestRejection`：Host/Origin 栅栏加浏览器会话认证，未认证请求返回 401/403；只有通过这些检查后，才继续做 loopback 客户端、loopback Host、JSON 内容类型与 `Origin`/`Sec-Fetch-Site` 校验。没有 `connection` 服务的旧宿主会退回这项本地校验。

## 报告问题

请不要开公开 issue。请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告，并附上：

- 受影响的版本；
- 最小复现步骤；
- 问题是否需要本机进程、网页，或一个已经开启 Prompt Lab 的会话来触发。

## 支持的版本

安全修复只进入最新的 `1.1.x` 候选/正式版本；旧版本不维护。

## 已知边界

- 提示词内容由用户编写。一段让模型误用工具的提示词不是本插件的漏洞。
- 追加的 assistant 消息会被模型当作真实历史；这是用户显式执行的消息管理操作，不是身份认证绕过。
- API 没有独立用户认证。写请求的 loopback/Origin/Sec-Fetch-Site/Content-Type 检查是 CSRF 与网络暴露的纵深防御，不是身份认证。请不要通过反向代理、隧道或其他方式把 API 暴露到不可信网络。
- Prompt Lab 不替代 DSH 的审批、沙箱或工具策略。
