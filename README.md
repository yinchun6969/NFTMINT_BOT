# NFTMINT_BOT · Mint Forge

一个只绑定本机回环地址的通用 NFT Mint 控制台，适合在本机配置项目地址、公开钱包地址、数量、价格、重试、延迟和 EVM 动态 Gas 加成。

## 文档 / Documentation

- [中文说明](README.zh-CN.md)
- [English guide](README.en.md)
- [免责声明 / Disclaimer](DISCLAIMER.md)

## 快速开始 / Quick start

```bash
npm install
npm start
```

打开 `http://127.0.0.1:8787`。Windows PowerShell 可运行 `start_mint_console.ps1`，Linux/macOS 可运行 `start_mint_console.sh`。

Open `http://127.0.0.1:8787`. On Windows PowerShell run `start_mint_console.ps1`; on Linux/macOS run `start_mint_console.sh`.

## 安全边界 / Safety boundary

- 默认只预检，不提交订单、不广播交易。
- 服务只监听 `127.0.0.1`，不要把端口暴露到公网。
- 私钥不会进入网页；环境私钥模式只读取本机环境变量 `MINT_PRIVATE_KEY`。
- 不要提交私钥、助记词、`.env`、`node_modules` 或本地状态文件。
- 使用前请阅读 [免责声明 / Disclaimer](DISCLAIMER.md)。

By using this software, you accept the risks described in the bilingual disclaimer.
