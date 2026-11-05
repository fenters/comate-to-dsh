# comate-to-dsh

把 **WPS Comate** 接入 DeepSeek Harness，让 Comate 里可用的模型出现在 DSH 的模型选择器里，当作普通 provider 使用。

- 模型列表自动同步，不用手动配置
- 登录态自动获取：优先复用本机已登录的 Comate 客户端，没有就拉起浏览器登录一次
- 支持识图模型
- 设置页可勾选要用的模型，取消勾选的不会出现在模型下拉里
- 设置页可查看连接状态与模型数量，并可手动刷新

## 安装

要求 Windows + 已安装 DeepSeek Harness（DSH）。

> **给 Agent 的说明**：用户会让你把解压目录下的这个插件装上。请按下面的步骤做，不要让用户手动搬运文件夹。

1. **确定目标目录**：`$DSH_HOME\plugins\comate-to-dsh`，其中 `$DSH_HOME` 默认是 `%USERPROFILE%\.dsh`。目录不存在就先创建。
2. **复制**：把整个插件文件夹（含 `package.json`、`lib/`、`dsh-plugin/`、`cordis.patch.yml`）复制到上面的目标目录。若目标已存在，先确认是否是同一插件，避免覆盖用户已有版本。
3. **安装**：调用 `plugin_manager` 工具的 `install_bundle`，`target` 传目标目录的**绝对路径**，例如：

   ```
   C:\Users\<user>\.dsh\plugins\comate-to-dsh
   ```

   也可以让用户在终端手动执行：

   ```powershell
   dsh plugin --profile <profile> add "link:$DSH_HOME\plugins\comate-to-dsh"
   ```

   ⚠️ 用 `link:` 而不是 `file:`。`file:` 会让 pnpm 把它记成 injected 依赖，每次安装其他插件都要重新同步这个目录；`link:` 只建一个软链接，装别的插件时完全不碰它。路径必须是**绝对路径**，相对路径会被 `parseInstallSpec` 以 `a local path must be absolute` 拒绝。
4. **重启 DSH**。插件注册的是 provider 与设置页，需要重启才生效。
5. 打开 设置 → **WPS Comate**，点「自动连接」或「浏览器登录」。

**为什么必须先复制**：`link:` 是软链接，指向安装时的那个路径。如果直接从下载目录安装，用户一旦移动或清理下载目录，插件就会失效，且报错很难懂。复制到 `plugins/` 下可以避免这个问题。

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
