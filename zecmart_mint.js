#!/usr/bin/env node
"use strict";

/*
 * ZecMart / ZecPuppets mint helper
 *
 * Important:
 * - This collection currently uses database-managed allocation, not a normal
 *   NFT smart-contract mint.
 * - No private key, seed phrase, RPC signing or ZEC payment is used here.
 * - The script is dry-run by default. Add --send to create the mint order.
 * - The public wallet address is read from --wallet or ZEC_WALLET_ADDRESS.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const API_BASE = (process.env.ZECMART_API || "https://zecmart.com").replace(/\/+$/, "");
const COLLECTION_SLUG = "zecpuppets";
const STATE_FILE = path.join(process.cwd(), ".zecmart-mint-state.json");
const POLL_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortAddress(address) {
  if (!address || address.length < 14) return address || "—";
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function printHelp() {
  console.log(`
ZecMart ZecPuppets mint helper

Usage:
  node zecmart_mint.js --wallet "<your public Zcash address>"
  node zecmart_mint.js --wallet "<your public Zcash address>" --quantity 1 --send

Options:
  --wallet <address>    Noir Wallet public address; or set ZEC_WALLET_ADDRESS
  --quantity <number>   Number to mint, default: 1
  --send                Actually submit the mint order; without it, preflight only
  --new-order           Ignore the local retry state and create a new order key
  --timeout <seconds>   Polling timeout after submission, default: 600
  --help                Show this help

Examples:
  # Safe check only
  node zecmart_mint.js --wallet "u1..."

  # Submit one free mint and wait for allocation
  node zecmart_mint.js --wallet "u1..." --quantity 1 --send

Notes:
  The script will stop automatically if the collection is paused, blocked,
  sold out, no longer free, or no longer uses database allocation.
`);
}

function parseArgs(argv) {
  const result = {
    wallet: process.env.ZEC_WALLET_ADDRESS || "",
    quantity: 1,
    send: false,
    newOrder: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--send") {
      result.send = true;
    } else if (arg === "--new-order") {
      result.newOrder = true;
    } else if (arg === "--wallet") {
      result.wallet = argv[++i] || "";
    } else if (arg === "--quantity") {
      result.quantity = Number(argv[++i]);
    } else if (arg === "--timeout") {
      result.timeoutMs = Number(argv[++i]) * 1000;
    } else {
      throw new Error(`未知参数：${arg}。使用 --help 查看用法。`);
    }
  }

  if (!Number.isInteger(result.quantity) || result.quantity < 1) {
    throw new Error("--quantity 必须是大于 0 的整数。");
  }
  if (!Number.isFinite(result.timeoutMs) || result.timeoutMs < 30_000) {
    throw new Error("--timeout 至少为 30 秒。");
  }
  return result;
}

async function apiRequest(apiPath, options = {}) {
  const headers = {
    accept: "application/json",
    ...(options.body ? { "content-type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(`${API_BASE}${apiPath}`, {
      ...options,
      headers,
    });
  } catch (error) {
    throw new Error(`无法连接 ZecMart：${error.message}`);
  }

  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    const detail = data && typeof data === "object"
      ? data.message || data.error || JSON.stringify(data)
      : String(data || "");
    throw new Error(`ZecMart API ${response.status}: ${detail || response.statusText}`);
  }
  return data;
}

function assertWalletAddress(wallet) {
  if (!wallet || /\s/.test(wallet) || wallet.length < 20 || wallet.length > 300) {
    throw new Error("请提供 Noir Wallet 的公开 Zcash 地址；不要填写私钥或助记词。");
  }
}

function assertMintConfig(config) {
  const collection = config?.collection || {};
  const problems = [];

  if (collection.slug !== COLLECTION_SLUG) {
    problems.push(`collection 不是 ${COLLECTION_SLUG}`);
  }
  if (config.network && config.network !== "mainnet") {
    problems.push(`网络为 ${config.network}，不是 mainnet`);
  }
  if (config.architecture?.databaseAllocationOnly !== true) {
    problems.push("当前脚本只支持 database allocation 模式");
  }
  if (String(collection.priceZatoshi ?? config.amountZatoshi ?? "0") !== "0") {
    problems.push("mint 已不是免费模式，脚本不会自动付款");
  }
  if (config.publicMintBlocked === true) {
    problems.push("publicMintBlocked=true");
  }
  if (config.effectiveMintStatus && config.effectiveMintStatus !== "LIVE") {
    problems.push(`mint 状态为 ${config.effectiveMintStatus}`);
  }
  if (collection.status && collection.status !== "LIVE") {
    problems.push(`collection 状态为 ${collection.status}`);
  }

  if (problems.length) {
    throw new Error(`当前不能 mint：${problems.join("；")}`);
  }
}

function assertLimits(limits, quantity) {
  const remaining = Number(limits?.effectiveMaxQuantity ?? limits?.walletRemainingAllowance);
  const inventory = Number(limits?.availableInventory);

  if (Number.isFinite(remaining) && quantity > remaining) {
    throw new Error(`钱包剩余可 mint 数量为 ${remaining}，请求数量为 ${quantity}。`);
  }
  if (Number.isFinite(inventory) && quantity > inventory) {
    throw new Error(`剩余库存为 ${inventory}，请求数量为 ${quantity}。`);
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function removeState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function makeOrderState(wallet, quantity, forceNew) {
  const old = readState();
  const sameRequest = old
    && old.walletAddress === wallet
    && old.quantity === quantity
    && old.idempotencyKey;

  if (sameRequest && !forceNew) {
    return old;
  }

  const state = {
    walletAddress: wallet,
    quantity,
    idempotencyKey: `mint-${Date.now()}-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  saveState(state);
  return state;
}

function isComplete(order) {
  return order?.status === "COMPLETED"
    || order?.deliveryStatus === "DELIVERED"
    || (order?.status === "PAYMENT_CONFIRMED" && order?.deliveryStatus === "NOT_REQUIRED");
}

function printOrder(order, prefix = "") {
  console.log(`${prefix}订单：${order?.id || "—"}`);
  console.log(`${prefix}状态：${order?.status || "—"} / ${order?.deliveryStatus || "—"}`);
  if (Array.isArray(order?.items)) {
    for (const item of order.items) {
      const label = item.serial != null ? `#${item.serial}` : item.id || "item";
      console.log(`${prefix}藏品：${label}${item.name ? ` ${item.name}` : ""}`);
    }
  }
}

async function pollOrder(order, timeoutMs, state) {
  const orderId = order?.id;
  if (!orderId) throw new Error("API 没有返回订单 ID，无法安全轮询。");

  state.orderId = orderId;
  saveState(state);
  let latest = order;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    printOrder(latest, "  ");
    if (isComplete(latest)) {
      removeState();
      console.log("\n✅ Mint 完成。该页面采用数据库分配，不会产生 ZEC 转账 txid。");
      return;
    }
    if (latest?.status === "FAILED") {
      throw new Error(`订单失败：${latest.failureReason || "未知原因"}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`已达到轮询超时。订单仍在处理中，请保留 ${STATE_FILE} 后稍后重试；不要重复付款。`);
    }

    await sleep(POLL_INTERVAL_MS);
    latest = await apiRequest(`/api/mint/orders/${encodeURIComponent(orderId)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  assertWalletAddress(args.wallet);
  console.log(`检查 ${API_BASE} 的 ZecPuppets mint 配置…`);
  const config = await apiRequest("/api/mint/config");
  assertMintConfig(config);

  const collection = config.collection || {};
  const maxPerOrder = Number(collection.maxPerOrder);
  if (Number.isFinite(maxPerOrder) && args.quantity > maxPerOrder) {
    throw new Error(`单笔最多 mint ${maxPerOrder} 个，当前请求 ${args.quantity} 个。`);
  }

  const limits = await apiRequest(
    `/api/mint/wallet-limits?walletAddress=${encodeURIComponent(args.wallet)}`,
  );
  assertLimits(limits, args.quantity);

  console.log("✅ 预检通过：mainnet / FREE / database allocation");
  console.log(`钱包：${shortAddress(args.wallet)}`);
  console.log(`数量：${args.quantity}`);
  console.log(`剩余钱包额度：${limits.walletRemainingAllowance ?? limits.effectiveMaxQuantity ?? "—"}`);

  if (!args.send) {
    console.log("\n这是安全预检，没有创建订单。确认要执行时添加 --send。\n");
    return;
  }

  const state = makeOrderState(args.wallet, args.quantity, args.newOrder);
  let order;

  if (state.orderId && !args.newOrder) {
    console.log(`\n发现未完成订单 ${state.orderId}，继续查询，不创建重复订单…`);
    order = await apiRequest(`/api/mint/orders/${encodeURIComponent(state.orderId)}`);
  } else {
    console.log("\n正在创建 mint 订单…");
    order = await apiRequest("/api/mint/orders", {
      method: "POST",
      headers: { "x-idempotency-key": state.idempotencyKey },
      body: JSON.stringify({
        walletAddress: args.wallet,
        quantity: args.quantity,
        idempotencyKey: state.idempotencyKey,
      }),
    });
  }

  await pollOrder(order, args.timeoutMs, state);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});

