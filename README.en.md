# NFTMINT_BOT · Mint Forge English Guide

Mint Forge is a reusable NFT mint console that runs on the local machine. It provides a Chinese web UI with preflight checks, start/stop controls, logs, status, retries, delays, price configuration, and dynamic EVM gas-fee boosts.

## Features

- **Website / API mode** for the current ZecMart database-allocation flow.
- **Generic API mode** with configurable endpoint, JSON body, public wallet address, quantity, price, idempotent retries, and backoff delays.
- **EVM · environment-key mode**. The private key is read only from the local `MINT_PRIVATE_KEY` environment variable and never from the web form.
- **EVM · browser-wallet mode**. The browser wallet signs only after the user confirms the transaction.
- **Price configuration** for `0`, `5`, or decimal mint prices, with automatic total-price calculation.
- **Dynamic gas fees**. EVM modes read the current RPC fee and support `0%`, `10%`, `20%` … `100%` boosts. EIP-1559 networks use `maxFeePerGas/maxPriorityFeePerGas`; legacy networks use `gasPrice`.
- **Safety gates**. Dry-run is enabled by default and live execution requires an explicit confirmation.

The gas boost applies to gas fees, not the gas limit. A higher boost increases the fee but does not guarantee a successful mint.

## Install and run

```bash
npm install
npm run set-password
npm start
```

Then open:

```text
http://127.0.0.1:8787
```

On Linux/macOS you can run `./start_mint_console.sh`. On Windows PowerShell run `./start_mint_console.ps1`.

Set the application password once from the VPS terminal or an SSH terminal:

```bash
npm run set-password
```

The password is stored only as a local hash in `.mint-console-auth.json`; it is not placed in the web page, GitHub, or logs. The minimum length is 12 bytes.

## Secure VPS access

Keep Node bound to `127.0.0.1` and use an SSH tunnel:

```bash
ssh -N -L 8787:127.0.0.1:8787 user@VPS_IP
```

Keep the SSH session open and browse to `http://127.0.0.1:8787` on your own computer. This is the local browser address, not the VPS public address.

For direct Tailscale access, explicitly set `MINT_ALLOW_NON_LOOPBACK=true`, bind only to the Tailscale interface address, restrict the port to your Tailscale nodes with a firewall, and still configure the application password. Do not run an unprotected `0.0.0.0` listener.

## Application authentication

- Unauthenticated clients cannot access state, preflight, start, stop, or client-event APIs.
- Login uses an HttpOnly session cookie, CSRF protection, failed-login rate limiting, and a 12-hour session expiry.
- The application password can only be created from the VPS terminal with `npm run set-password`; anonymous web visitors cannot create one.
- If `MINT_PRIVATE_KEY` is configured, use SSH or a firewall-protected Tailscale path only; do not expose the service to the public internet.

## Workflow

1. Select a mode.
2. Enter the project mint/API URL, public wallet address, quantity, and mint price.
3. For EVM projects, enter the RPC URL, Chain ID, contract address, and exact calldata.
4. Select a dynamic gas-fee boost when appropriate.
5. Run preflight and verify the chain, contract, amount, gas, and wallet.
6. Disable dry-run and confirm the risk checkbox only after everything has been verified.

## ZecMart note

The current ZecMart adapter only accepts the mainnet, free, LIVE, database-allocation flow when it is not sold out. It does not read private keys, sign RPC transactions, or automatically pay ZEC. Use Generic API or EVM mode for paid projects and verify the project’s actual payment flow yourself.

## Key handling

Example for the environment-key mode:

```bash
MINT_PRIVATE_KEY='set only in the local terminal' npm start
```

Use a dedicated small-balance wallet. Never commit private keys, seed phrases, `.env` files, or local state files. Read [DISCLAIMER.md](DISCLAIMER.md) before using the software.
