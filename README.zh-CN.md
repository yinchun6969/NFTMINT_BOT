# NFTMINT_BOT · Mint Forge 中文说明

这是一个运行在本机的通用 NFT Mint 控制台。它提供中文网页面板、预检、启动/停止、日志、状态、重试和延迟配置，适合把不同 NFT 项目的 Mint 参数集中配置后执行。

## 主要功能

- **网站 / API 模式**：适配 ZecMart 当前的 database allocation 流程。
- **通用 API 模式**：自定义 API 地址、请求 Body、公开钱包地址、数量、价格和幂等重试。
- **EVM · 环境私钥模式**：私钥只从本机环境变量 `MINT_PRIVATE_KEY` 读取，不经过网页输入框。
- **EVM · 浏览器钱包模式**：连接浏览器钱包，由用户在钱包弹窗中确认交易。
- **价格配置**：支持 `0`、`5` 或带小数的 Mint 单价，自动计算单次总价。
- **动态 Gas**：EVM 模式读取当前 RPC 费用，可选择 `0%`、`10%`、`20%` …… `100%` 加成。EIP-1559 网络使用 `maxFeePerGas/maxPriorityFeePerGas`，旧网络使用 `gasPrice`。
- **安全控制**：默认只预检；真正执行需要主动关闭 dry-run 并勾选风险确认。

动态 Gas 加成针对的是 Gas 费用，不是 Gas limit。加成越高，手续费越高，但不保证一定 Mint 成功。

## 安装和启动

Linux/macOS：

```bash
./start_mint_console.sh
```

或手动运行：

```bash
npm install
npm run set-password
npm start
```

Windows PowerShell：

```powershell
.\start_mint_console.ps1
```

然后打开：

```text
http://127.0.0.1:8787
```

首次启动前，请在 VPS 本机终端或 SSH 终端设置应用密码：

```bash
npm run set-password
```

密码只保存为本机哈希文件 `.mint-console-auth.json`，不会写入网页、GitHub 或日志。密码长度要求为至少 12 个字节。

## VPS 安全访问

推荐让 Node 服务继续只监听 `127.0.0.1`，通过 SSH 隧道访问：

```bash
ssh -N -L 8787:127.0.0.1:8787 user@你的VPS_IP
```

保持这个 SSH 窗口运行，然后在自己电脑的浏览器打开 `http://127.0.0.1:8787`。这个地址是本机浏览器，不是 VPS 的公网地址。

如果使用 Tailscale 直连，必须显式配置 `MINT_ALLOW_NON_LOOPBACK=true`，并只绑定 Tailscale 网卡地址、在防火墙中只允许自己的 Tailscale 节点访问，同时仍然设置应用密码。不要使用 `0.0.0.0` 无保护运行。

## 应用认证

- 未登录时，状态、预检、启动、停止和客户端事件 API 都会被拒绝。
- 登录使用 HttpOnly 会话 Cookie、CSRF 校验、失败次数限制和 12 小时会话过期。
- 应用密码只能由 VPS 终端的 `npm run set-password` 设置，不能由匿名网页访客创建。
- 如果配置了 `MINT_PRIVATE_KEY`，请只使用 SSH 隧道或受防火墙保护的 Tailscale 访问，不要将服务公开到互联网。

## VPS 小白一键向导

在 Ubuntu/Debian VPS 中通过 SSH 登录后运行：

```bash
curl -fsSL https://raw.githubusercontent.com/yinchun6969/NFTMINT_BOT/main/install_mint_forge.sh -o install_mint_forge.sh
chmod +x install_mint_forge.sh
./install_mint_forge.sh
```

向导会依次引导你选择安装目录、SSH/Tailscale 或 Cloudflare Tunnel、是否配置 EVM 环境私钥，然后自动完成：

1. 安装或检查 Node.js、npm 和 Git。
2. 从 GitHub 拉取 Mint Forge 并安装依赖。
3. 创建独立的 `mintforge` 系统用户。
4. 设置应用密码并创建 systemd 开机启动服务。
5. 可选安装 Cloudflare Tunnel 连接器。

选择 Cloudflare Tunnel 时，向导会提示你在 Cloudflare Zero Trust 创建 Tunnel、设置 Public Hostname（默认 `mint.91nft.cyou`）、将 Service 指向 `http://127.0.0.1:8787`，再粘贴 connector token。Cloudflare Access 的邮箱/MFA 策略仍需在 Cloudflare 控制台中设置。

向导不会把 Node 绑定到 `0.0.0.0`，不会自动开放 `8787`，也不会要求助记词。服务日志：

```bash
sudo journalctl -u mint-forge -f
sudo journalctl -u mint-forge-tunnel -f
```

## 使用流程

1. 选择模式。
2. 填写项目 Mint/API 地址、公开钱包地址、数量和 Mint 单价。
3. EVM 项目填写 RPC、Chain ID、合约地址和准确的 calldata。
4. 如需竞争 Gas，在“动态 Gas 费用加成”中选择百分比。
5. 先点击“执行预检”，确认网络、合约、金额、Gas 和钱包地址。
6. 确认无误后，再关闭“只预检”并勾选风险确认。

## ZecMart 特别说明

当前 ZecMart 适配器只接受 mainnet、免费、LIVE、database allocation 且未售罄的流程；它不会读取私钥、不会签名 RPC 交易，也不会自动支付 ZEC。付费项目应使用通用 API 或 EVM 合约模式，并自行核对项目的真实支付逻辑。

## 私钥和文件安全

环境私钥模式示例：

```bash
MINT_PRIVATE_KEY='只在本机终端设置' npm start
```

```powershell
$env:MINT_PRIVATE_KEY = "只在本机终端设置"
npm start
```

请使用专用小额钱包，不要把私钥、助记词、`.env` 或状态文件提交到 GitHub。完整免责声明见 [DISCLAIMER.md](DISCLAIMER.md)。
