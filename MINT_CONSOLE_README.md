# Mint Forge 本地通用 Mint 控制台

这是一个只绑定 `127.0.0.1` 的本地网页版 NFT Mint 控制台。

## 启动

```bash
npm install
npm run set-password
npm start
```

然后打开：

```text
http://127.0.0.1:8787
```

Linux 也可以直接运行 `start_mint_console.sh`；Windows PowerShell 可以运行 `start_mint_console.ps1`。

首次启动时，请在 VPS 本机终端或 SSH 终端运行 `npm run set-password` 设置应用密码。密码只保存为 `.mint-console-auth.json` 中的哈希，文件会被 `.gitignore` 忽略，且不会进入网页或日志。

## 推荐的 VPS 访问方式

服务默认只监听 `127.0.0.1`。推荐使用 SSH 本地端口转发：

```bash
ssh -N -L 8787:127.0.0.1:8787 user@你的VPS_IP
```

然后在本机浏览器打开 `http://127.0.0.1:8787`。如使用 Tailscale 直连，必须显式设置 `MINT_ALLOW_NON_LOOPBACK=true`，只绑定 Tailscale 地址并配置防火墙，同时仍然需要应用密码；不要把服务绑定到 `0.0.0.0` 后直接暴露公网。

登录保护包括 HttpOnly 会话 Cookie、CSRF 校验、失败登录限速和 12 小时会话过期。未登录时不能调用状态、预检、启动、停止和客户端事件 API。应用密码只能在 VPS 终端设置，网页访客不能创建密码。

## 支持模式

1. **网站 / API**：适合 ZecMart 这种由网站 API 完成登记或分配的 mint。
2. **通用 API**：填写提交地址、Body 模板、数量、重试次数和间隔。
3. **合约 · 环境私钥**：私钥只从本机 `MINT_PRIVATE_KEY` 环境变量读取，不经过网页输入框。
4. **合约 · 浏览器钱包**：使用浏览器钱包连接和手动确认交易。

## 价格设置

- 网页中的 **Mint 单价** 可以填 `0`、`5` 或带小数的非负数字；**数量**变化后会自动显示本次总价。
- **价格单位** 和 **价格小数位** 用于把金额换算成 API 字段或 EVM 的最小单位；例如 ZEC 常用 8 位，EVM 原生币常用 18 位。
- 通用 API 的 Body 模板可使用 `{{mintPrice}}`、`{{totalPrice}}` 和 `{{priceUnit}}`。
- 当前 ZecMart 适配器仍会核验平台实际配置，并且只接受其免费的 database allocation 流程；付费项目请使用通用 API 或 EVM 合约模式。
- EVM 模式会读取当前 RPC 的 Gas 费用；可选择 `0%` 到 `100%` 的动态 Gas 费用加成，程序会在预检和广播时使用加成后的 gasPrice 或 EIP-1559 fee。加成只提高竞争优先级，不保证一定 mint 成功，也会提高手续费。

## 安全规则

- 默认是只预检模式，不会创建订单或广播交易。
- 不要把私钥、助记词填入公开钱包地址输入框。
- 私钥模式只建议使用专用小额热钱包，并且只绑定本机地址。
- EVM 合约模式需要准确的合约地址、Chain ID、calldata、value 和 Gas；程序不会猜测 mint 函数。
- API 模式重试会复用同一个幂等 key，避免网络超时造成重复订单。
- EVM 交易一旦拿到 tx hash，不会自动重复广播，避免重复 mint。
- 不要把 `8787` 端口暴露到公网，也不要把 `.env`、私钥或状态文件提交到 GitHub。

## 环境私钥模式示例

Linux/macOS：

```bash
MINT_PRIVATE_KEY='只在本机终端设置' npm start
```

PowerShell：

```powershell
$env:MINT_PRIVATE_KEY = "只在本机终端设置"
npm start
```

当前 ZecMart 适配器保留了 mainnet、免费、database allocation、钱包额度和售罄检查；项目暂停或售罄时会自动停止，不会提交订单。
