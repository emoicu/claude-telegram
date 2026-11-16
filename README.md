# claude-telegram

基于 Claude Code 官方 Telegram channel 插件的个人维护版本。

- 上游：[anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) 的 `external_plugins/telegram`
- 起点：上游插件 v0.0.7（commit `b5b01ac`）
- 许可：Apache-2.0，见 [LICENSE](LICENSE)

## 安装

```
/plugin marketplace add emoicu/claude-telegram
/plugin install telegram@emoicu-plugins
/plugin disable telegram@claude-plugins-official
```

启动：`claude --channels plugin:telegram@emoicu-plugins`

## 与上游的差异

见 git 历史；第一个 commit 为上游原样代码。
