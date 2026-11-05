# comate-to-dsh

把 **WPS Comate** 接入 DeepSeek Harness，把 Comate 里可用的模型作为 DSH 的一个 provider 使用。

登录态全自动获取，**不需要手填 SID**：优先复用本机已登录的 Comate 客户端，
没有就拉起浏览器让你登录一次，之后自动记住。

## 安装

插件目录放在 `$DSH_HOME/plugins/comate-to-dsh`，然后在 profile 里作为本地依赖引入：

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
"dependencies": { "comate-to-dsh": "file:../../plugins/comate-to-dsh" }
```

```powershell
cd "$env:DSH_HOME\profiles\<profile>"
pnpm add "file:../../plugins/comate-to-dsh"
```

再把 `comate-to-dsh` 加进该 `package.json` 的 `dsh.profile.bundles`，重启 DSH 即可。

也可以直接从 npm 或 GitHub 安装：

```powershell
dsh plugin add comate-to-dsh
dsh plugin add github:fenters/comate-to-dsh
```

## 使用

设置 → **WPS Comate**：

- 查看连接状态、登录态来源（脱敏）、模型数量与更新时间。
- 「自动连接」：从本机 Comate 客户端取登录态。
- 「浏览器登录」：没装 Comate 或没登录时用，登录完成后自动抓取。
- 「刷新模型」：手动拉一次最新模型列表。

## 已知限制

- 思考档位只开放 `off` / `low` / `high`（部分模型对其它档位会返回错误）。
- 模型是否可用取决于账号本身的权限，插件只如实透传上游错误。
- 插件依赖本机安装并登录过的 Comate 客户端，或一次浏览器登录。

## 开发

```powershell
npm run check    # 语法检查
npm test         # 离线测试套件（不需要登录态）
npm run verify   # 全量测试（需要 Comate 登录态）
```

目录结构：

```
lib/               纯 JS 实现（协议翻译、鉴权、目录、登录）
dsh-plugin/lib/    DSH 宿主集成（入口、HTTP 路由、设置面板）
_verify/           测试脚本
cordis.patch.yml   bundle 注册
```

## License

MIT
