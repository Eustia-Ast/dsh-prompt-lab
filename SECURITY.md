# 安全策略

## 范围

Prompt Lab 是一个本机、单用户的 DeepSeek Harness 插件。它可以改变某个会话的系统提示词，以及该会话可见的 global 工具集合。它的本地 HTTP API 只接受 loopback 客户端、loopback Host 和严格同源的 JSON 写请求。不要通过反向代理、隧道或其他方式将该接口暴露给不可信网络。

## 报告问题

请不要开公开 issue。请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告，并附上：

- 受影响的版本；
- 最小复现步骤；
- 问题是否需要本机进程、网页，或一个已经开启 Prompt Lab 的会话来触发。

## 支持的版本

安全修复只进入最新的 `1.0.x` 候选/正式版本；旧版本不维护。

## 已知边界

- 提示词内容由用户编写。一段让模型误用工具的提示词不是本插件的漏洞。
- API 没有独立用户认证。写请求的 loopback/Origin/Content-Type 检查是 CSRF 与网络暴露的纵深防御，不是身份认证。请不要通过反向代理、隧道或其他方式把 API 暴露到不可信网络。
- Prompt Lab 不替代 DSH 的审批、沙箱或工具策略。
