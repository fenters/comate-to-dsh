# comate-to-dsh

把 **WPS Comate** 接入 DeepSeek Harness，让 Comate 里可用的模型出现在 DSH 的模型选择器里，当作普通 provider 使用。

- 模型列表自动同步，不用手动配置
- 登录态自动获取：优先复用本机已登录的 Comate 客户端，没有就拉起浏览器登录一次
- 支持识图模型
- 设置页可查看连接状态与模型数量，并可手动刷新

## 安装

要求 Windows + 已安装 DeepSeek Harness（DSH）。

1. 把整个文件夹放到 `$DSH_HOME\plugins\comate-to-dsh`（默认 `%USERPROFILE%\.dsh\plugins\comate-to-dsh`）。
   之后不要再移动或删除它 —— DSH 用软链接指向该目录，挪走插件就失效。
2. 在 DSH 会话里说「把 `$DSH_HOME\plugins\comate-to-dsh` 这个插件装上」，Agent 会用 `plugin_manager` 的 `install_bundle` 完成安装。
   也可手动执行：

   ```powershell
   dsh plugin --profile <profile> add "file:$DSH_HOME\plugins\comate-to-dsh"
   ```

   注意路径必须是**绝对路径**，相对路径会被拒绝。
3. 重启 DSH。插件注册的是 provider 与设置页，需要重启才生效。
4. 打开 设置 → **WPS Comate**，点「自动连接」或「浏览器登录」。

卸载：

```powershell
dsh plugin --profile <profile> remove comate-to-dsh
```

## 已知限制

- 仅支持 Windows：依赖本机安装并登录过的 Comate 客户端，或一次 Edge 浏览器登录。
- 思考档位只开放 `off` / `low` / `high`。
- 模型是否可用取决于账号本身的权限，插件只如实透传上游错误。

## License

MIT
