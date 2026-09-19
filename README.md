# NFTMINT_BOT · Mint Forge

一个只绑定本机回环地址的通用 NFT Mint 控制台，适合在本机配置项目地址、公开钱包地址、数量、价格、重试、延迟和 EVM 动态 Gas 加成。

## 文档 / Documentation

- [中文说明](README.zh-CN.md)
- [English guide](README.en.md)
- [免责声明 / Disclaimer](DISCLAIMER.md)

## 快速开始 / Quick start

```bash
npm install
npm run set-password
npm start
```

在 VPS 终端设置一次应用密码后，通过 SSH 隧道打开 `http://127.0.0.1:8787`。Windows PowerShell 可运行 `start_mint_console.ps1`，Linux/macOS 可运行 `start_mint_console.sh`。

Set the application password once in the VPS terminal, then open `http://127.0.0.1:8787` through an SSH tunnel. On Windows PowerShell run `start_mint_console.ps1`; on Linux/macOS run `start_mint_console.sh`.

SSH tunnel example:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@VPS_IP
```

然后在本机浏览器访问 `http://127.0.0.1:8787`。应用密码只能通过 VPS 终端的 `npm run set-password` 设置，不能由匿名网页访客创建。

## VPS 一键向导 / VPS one-click installer

在 Ubuntu/Debian VPS 的 SSH 终端运行：

```bash
curl -fsSL https://raw.githubusercontent.com/yinchun6969/NFTMINT_BOT/main/install_mint_forge.sh -o install_mint_forge.sh
chmod +x install_mint_forge.sh
./install_mint_forge.sh
```

向导会创建独立服务用户、systemd 开机启动、应用密码，并可选配置 Cloudflare Tunnel。Node 仍只监听 `127.0.0.1`，不会公开 `8787` 端口。执行前建议先阅读脚本内容，并确认 VPS 允许使用 `sudo`。

## 安全边界 / Safety boundary

- 默认只预检，不提交订单、不广播交易。
- 服务只监听 `127.0.0.1`，不要把端口暴露到公网。
- 网页 API 需要应用密码；会话使用 HttpOnly Cookie、CSRF 校验、登录失败限速和过期时间保护。
- 私钥不会进入网页；环境私钥模式只读取本机环境变量 `MINT_PRIVATE_KEY`。
- 不要提交私钥、助记词、`.env`、`node_modules` 或本地状态文件。
- 使用前请阅读 [免责声明 / Disclaimer](DISCLAIMER.md)。

By using this software, you accept the risks described in the bilingual disclaimer.
