# dsh-account-usage-widget

> DeepSeek Harness 账号实时用量悬浮窗 · Floating real-time balance & session-token widget for dsh

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**账号实时用量悬浮窗**插件。

在 Web 界面右下角显示一枚简洁的悬浮胶囊，实时呈报当前账号的余额与用量；点击展开为一张卡片。
纯 JavaScript 客户端插件，**零构建步骤、零运行时依赖**，样式全部走宿主主题 token，自动跟随浅色／深色。

> Target runtime: **dsh 0.2.0-rc.2** (profile bundle, Web composition).

```
┌──────────────────────────────┐
│  账户用量             ⟳   ⌄  │
│  young · 138****8888         │
│  充值余额              ¥12.34│
│  赠送额度                ¥5  │
│  本次打开已用        −¥0.30  │
│  ──────────────────────────  │
│  本会话用量                  │
│  输入                  12.3k │
│  输出                   6.8k │
│  缓存读                45.7k │
│  ──────────────────────────  │
│  更新于 23:42:42  用量明细 → │
└──────────────────────────────┘
        （折叠态：钱包图标 + 余额 + 状态圆点）
```

## 功能

- **实时余额**：充值余额与赠送额度分币种展示（`CNY` → `¥`，`USD` → `$`）。
- **实时用量**：主会话的输入 / 输出 / 缓存读 token，随对话更新（读取 `tokenUsage` 投影）。
- **本次打开已用**：悬浮窗打开期间观测到的余额下降。
- **状态圆点**：绿=已读取、灰=读取中、红=失败；失败时保留上一次数据并提供重试。
- **登录态自适应**：未登录显示提示；`value === null`（凭据不存在）绝不会被渲染成 0 余额。
- **中英双语**，跟随界面语言；插件管理页显示标题、描述与图标。
- 只读：不写账号状态、不产生会话事件、不向模型暴露任何内容。

## 安装

```powershell
# 从 GitHub 安装（推荐）
dsh plugin --profile desktop add github:Yang-shift123/DeepSeek-Harness-Floating-real-time-balance-session-token-widget-for-dsh

# 或从本机目录安装
dsh plugin --profile desktop add "C:\path\to\dsh-account-usage-widget"
```

安装会把它写入 profile 的 `dependencies`，并把 `dsh-account-usage-widget` 追加到 `dsh.profile.bundles`；
刷新页面后右下角即可看到。卸载：

```powershell
dsh plugin --profile desktop remove dsh-account-usage-widget
```

> 说明：dsh 会在安装前用 `git ls-remote` 做一次 5 秒的 GitHub 连通性检查。网络不通时请改用本机目录或 tarball 安装。

## 数据来源

全部使用运行时已挂载的接口，不新增 Host 服务：

| 数据 | 来源 |
|---|---|
| 登录状态、用量/充值链接 | `ctx.remote.account.getState()` / `.watch(signal)` |
| 充值余额、赠送额度 | `ctx.remote.account.getBalance(client)` → `{ status: 'ready', value: AccountWallet[], bonusWallets: AccountWallet[] }` |
| 账号名与脱敏联系方式 | `ctx.remote.account.getProfile(client)` |
| 本会话 token 用量 | 根作用域 `useSessions` 标准属性 → 主会话（`retainedBy.mainView > 0`）的 `tokenUsage` 投影 |

`AccountWallet = { currency: 'CNY' | 'USD', balance: string }`（余额是十进制字符串，原样保留精度，展示时裁剪尾部零）。

刷新节奏：账号状态由 `watch` 流实时驱动；余额每 30 秒重读，页面重新可见时立即重读，也可手动刷新。
页面隐藏时不发请求，登出状态下也不发请求。

## 文件结构

| 文件 | 作用 |
|---|---|
| `package.json` | Bundle 清单：`dsh.bundle.patch`、`dsh.client`（`platform: web`、`immediately`、`inject`）、`icon`、locale 导出 |
| `cordis.patch.yml` | 插入一行 Loader 条目 `account-usage-widget` |
| `index.js` | Host 半侧：空实现（组件完全在浏览器侧） |
| `client.js` | 浏览器半侧：悬浮窗组件、账号读取 store、主题样式、双语文案 |
| `locale/en.json`, `locale/zh.json` | 插件管理页显示的标题与描述 |
| `icon.svg` | 插件管理页图标 |

## 自定义

| 想改什么 | 改哪里 |
|---|---|
| 悬浮位置 | `client.js` 中 `.dsh-auw-root` 的 `right` / `bottom`（默认 16px） |
| 刷新间隔 | `client.js` 顶部 `POLL_INTERVAL_MS`（默认 `30000`） |
| 文案 | `client.js` 中的 `en` / `zh` 字典 |
| 卡片宽窄 | `.dsh-auw-card` 的 `width`（默认 288px） |
| 隐藏某个区块 | 删除卡片里对应的 `StatRow`（余额／赠送／会话用量彼此独立） |

## 兼容性

- 目标运行时 `0.2.0-rc.2`；`peerDependencies` 声明为 `^0.2.0-rc.2`，与本机 dsh 一致，因此不会被插件管理器
  的版本预检拒绝。**升级 dsh 后请同步放宽该范围**（例如 `^0.2.0`），否则安装会被判为不兼容。
- 客户端 API 变化时：先刷新页面看控制台是否出现 `slot entry crashed in 'shell.overlay'`，
  再对照新版 `dsh-client-ui-settings-account` 的实现校正数据形状。

## 限制

- 余额来自 Platform 的账户接口，**不是**计费级精确账单；`contextBreakdown` 类的启发式估算同理不在此展示。
- 「本次打开已用」是余额下降的观测值，仅代表悬浮窗打开期间的变化，充值会使其暂停累计。
- 尚未在浏览器自动化下做过视觉回归；配色与间距以宿主 token 为准。

## License

MIT
