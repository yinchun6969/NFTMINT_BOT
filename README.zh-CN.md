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
