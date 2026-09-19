"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

let ethers = null;
try {
  ethers = require("ethers");
} catch {
  // API mode still works when ethers has not been installed yet.
}

const HOST = process.env.MINT_HOST || "127.0.0.1";
const PORT = Number(process.env.MINT_PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, "public");
const STATE_FILE = path.join(__dirname, ".mint-console-state.json");
const MAX_LOGS = 300;

let stopRequested = false;
let job = freshJob();

function freshJob() {
  return {
    id: null,
    running: false,
    status: "IDLE",
    mode: null,
    attempt: 0,
    maxAttempts: 0,
    orderId: null,
    txHash: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    logs: [],
  };
}

function log(message, level = "info") {
  const entry = {
    at: new Date().toISOString(),
    level,
    message: String(message).slice(0, 1200),
  };
  job.logs.push(entry);
  if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
  console.log(`[${entry.at}] ${level.toUpperCase()} ${entry.message}`);
}

function sleep(ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (stopRequested) {
        clearInterval(timer);
        reject(new Error("用户已停止任务"));
        return;
      }
      if (Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(500, Math.max(50, ms)));
  });
}

function maskAddress(value) {
  const text = String(value || "");
  if (text.length < 16) return text ? "已填写" : "未填写";
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

function rejectPrivateKeyLike(value, fieldName = "钱包地址") {
  const text = String(value || "").trim();
  const hex = text.replace(/^0x/i, "");
  if (/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`${fieldName}不能填写私钥。私钥只允许通过本机环境变量 MINT_PRIVATE_KEY 使用。`);
  }
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 512 * 1024) {
        reject(new Error("请求内容过大"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("请求不是有效 JSON"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function publicState() {
  return {
    ...job,
    privateKeyConfigured: Boolean(process.env.MINT_PRIVATE_KEY),
    ethersAvailable: Boolean(ethers),
  };
}

function validateUrl(value, label, { allowHttpLocal = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label}不是有效 URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label}只允许 http 或 https`);
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol === "http:" && !(allowHttpLocal && local)) {
    throw new Error(`${label}必须使用 HTTPS；只有本机地址允许 HTTP`);
  }
  return parsed;
}

function originOrSelf(value) {
  const parsed = validateUrl(value, "Mint/API 地址");
  if (parsed.pathname.startsWith("/launchpad/")) return parsed.origin;
  return String(value).replace(/\/+$/, "");
}

function publicAddressRequired(address) {
  const text = String(address || "").trim();
  if (!text || /\s/.test(text) || text.length < 20 || text.length > 300) {
    throw new Error("请填写公开钱包地址；不能填写私钥或助记词");
  }
  rejectPrivateKeyLike(text);
  return text;
}

function integer(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function canonicalDecimal(value, label) {
  const text = String(value ?? "0").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) {
    throw new Error(`${label}必须是非负十进制数字，例如 0 或 5.25`);
  }
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function decimalToUnits(value, decimals, label = "价格") {
  const text = canonicalDecimal(value, label);
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`${label}的小数位不能超过 ${decimals} 位`);
  }
  const scale = 10n ** BigInt(decimals);
  return BigInt(whole) * scale + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function unitsToDecimal(units, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function increaseByPercent(value, percent) {
  const amount = BigInt(value);
  const multiplier = 100n + BigInt(percent);
  return (amount * multiplier + 99n) / 100n;
}

function buildBoostedFeeQuote(feeData, percent) {
  const boost = integer(percent ?? 0, "动态 Gas 加成", 0, 100);
  if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
    const baseMaxFeePerGas = BigInt(feeData.maxFeePerGas);
    const baseMaxPriorityFeePerGas = BigInt(feeData.maxPriorityFeePerGas);
    const maxPriorityFeePerGas = increaseByPercent(baseMaxPriorityFeePerGas, boost);
    const requestedMaxFeePerGas = increaseByPercent(baseMaxFeePerGas, boost);
    const maxFeePerGas = requestedMaxFeePerGas < maxPriorityFeePerGas ? maxPriorityFeePerGas : requestedMaxFeePerGas;
    return {
      type: "eip1559",
      fields: { maxFeePerGas, maxPriorityFeePerGas },
      baseMaxFeePerGas,
      baseMaxPriorityFeePerGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      boost,
    };
  }
  if (feeData.gasPrice != null) {
    const baseGasPrice = BigInt(feeData.gasPrice);
    return {
      type: "legacy",
      fields: { gasPrice: increaseByPercent(baseGasPrice, boost) },
      baseGasPrice,
      gasPrice: increaseByPercent(baseGasPrice, boost),
      boost,
    };
  }
  if (feeData.maxFeePerGas != null) {
    const baseMaxFeePerGas = BigInt(feeData.maxFeePerGas);
    return {
      type: "eip1559",
      fields: { maxFeePerGas: increaseByPercent(baseMaxFeePerGas, boost) },
      baseMaxFeePerGas,
      maxFeePerGas: increaseByPercent(baseMaxFeePerGas, boost),
      boost,
    };
  }
  throw new Error("RPC 没有返回可用的动态 Gas 费用");
}

function formatGwei(value) {
  const amount = BigInt(value);
  const scale = 1000000000n;
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} gwei` : `${whole} gwei`;
}

function feeQuoteSummary(quote) {
  if (quote.type === "eip1559") {
    const baseMax = quote.baseMaxFeePerGas == null ? "—" : formatGwei(quote.baseMaxFeePerGas);
    const finalMax = quote.maxFeePerGas == null ? "—" : formatGwei(quote.maxFeePerGas);
    const basePriority = quote.baseMaxPriorityFeePerGas == null ? "—" : formatGwei(quote.baseMaxPriorityFeePerGas);
    const finalPriority = quote.maxPriorityFeePerGas == null ? "—" : formatGwei(quote.maxPriorityFeePerGas);
    return `EIP-1559 maxFee ${baseMax} → ${finalMax}，priority ${basePriority} → ${finalPriority}`;
  }
  return `legacy gasPrice ${formatGwei(quote.baseGasPrice)} → ${formatGwei(quote.gasPrice)}`;
}

async function readDynamicFeeQuote(provider, percent) {
  const feeData = await provider.getFeeData();
  return buildBoostedFeeQuote(feeData, percent);
}

function normaliseConfig(input) {
  const config = { ...input };
  config.mode = ["zecmart", "http", "evm-env", "evm-browser"].includes(config.mode) ? config.mode : "zecmart";
  config.quantity = integer(config.quantity ?? 1, "数量", 1, 1000000);
  config.retries = integer(config.retries ?? 2, "最大重试次数", 0, 100);
  config.delayMs = integer(config.delayMs ?? 5000, "重试间隔", 500, 86400000);
  config.pollMs = integer(config.pollMs ?? 15000, "状态轮询间隔", 1000, 86400000);
  config.priceUnit = String(config.priceUnit || "ZEC").trim().slice(0, 20) || "ZEC";
  config.priceDecimals = integer(config.priceDecimals ?? 8, "价格小数位", 0, 36);
  config.mintPrice = canonicalDecimal(config.mintPrice ?? "0", "Mint 单价");
  config.gasBoostPercent = integer(config.gasBoostPercent ?? 0, "动态 Gas 加成", 0, 100);
  const mintPriceUnits = decimalToUnits(config.mintPrice, config.priceDecimals, "Mint 单价");
  config.totalPrice = unitsToDecimal(
    mintPriceUnits * BigInt(config.quantity),
    config.priceDecimals,
  );
  config.valueWei = String(config.valueWei || mintPriceUnits * BigInt(config.quantity));
  config.confirmBroadcast = config.confirmBroadcast === true;
  config.dryRun = config.dryRun !== false;

  if (config.mode === "zecmart") {
    config.baseUrl = originOrSelf(config.baseUrl || "https://zecmart.com/launchpad/Mint");
    config.walletAddress = publicAddressRequired(config.walletAddress);
    return config;
  }

  if (config.mode === "http") {
    validateUrl(config.endpoint, "Mint API 地址");
    config.walletAddress = publicAddressRequired(config.walletAddress);
    if (config.preflightUrl) validateUrl(config.preflightUrl, "预检地址");
    config.method = String(config.method || "POST").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(config.method)) {
      throw new Error("通用 API 只允许 POST、PUT 或 PATCH");
    }
    if (config.headersText) {
      try {
        const headers = JSON.parse(config.headersText);
        if (!headers || Array.isArray(headers) || typeof headers !== "object") throw new Error();
        config.headers = headers;
      } catch {
        throw new Error("通用 API Headers 必须是 JSON 对象");
      }
    } else {
      config.headers = {};
    }
    config.bodyTemplate = String(config.bodyTemplate || "{\"walletAddress\":\"{{walletAddress}}\",\"quantity\":{{quantity}},\"idempotencyKey\":\"{{idempotencyKey}}\"}");
    return config;
  }

  if (config.mode === "evm-browser") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(config.contractAddress || ""))) {
      throw new Error("合约地址必须是 0x 开头的 20 字节地址");
    }
    if (!/^0x[0-9a-fA-F]*$/.test(String(config.calldata || ""))) {
      throw new Error("Mint calldata 必须是 0x 开头的十六进制数据");
    }
    if (!/^\d+$/.test(String(config.valueWei || "0"))) {
      throw new Error("valueWei 必须是非负整数 wei");
    }
    if (config.chainId) integer(config.chainId, "Chain ID", 1, 0x7fffffff);
    if (config.gasLimit && !/^\d+$/.test(String(config.gasLimit))) {
      throw new Error("Gas limit 必须是整数");
    }
    config.walletAddress = publicAddressRequired(config.walletAddress);
    if (!config.dryRun && !config.confirmBroadcast) {
      throw new Error("广播交易前必须勾选风险确认");
    }
    return config;
  }

  if (!ethers) throw new Error("EVM 模式需要先安装 ethers 依赖");
  validateUrl(config.rpcUrl, "RPC URL", { allowHttpLocal: true });
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(config.contractAddress || ""))) {
    throw new Error("合约地址必须是 0x 开头的 20 字节地址");
  }
  if (!/^0x[0-9a-fA-F]*$/.test(String(config.calldata || ""))) {
    throw new Error("Mint calldata 必须是 0x 开头的十六进制数据");
  }
  if (!/^\d+$/.test(String(config.valueWei || "0"))) {
    throw new Error("valueWei 必须是非负整数 wei");
  }
  if (config.chainId) integer(config.chainId, "Chain ID", 1, 0x7fffffff);
  if (config.gasLimit && !/^\d+$/.test(String(config.gasLimit))) {
    throw new Error("Gas limit 必须是整数");
  }
  if (!config.dryRun && !config.confirmBroadcast) {
    throw new Error("广播交易前必须勾选风险确认");
  }
  if (config.walletAddress) rejectPrivateKeyLike(config.walletAddress);
  return config;
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      redirect: "error",
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
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
      throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
    }
    return { status: response.status, data };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function checkZecMartConfig(data) {
  const collection = data?.collection || {};
  const issues = [];
  if (data.network && data.network !== "mainnet") issues.push(`网络为 ${data.network}`);
  if (data.architecture?.databaseAllocationOnly !== true) issues.push("不是 database allocation 模式");
  if (String(collection.priceZatoshi ?? data.amountZatoshi ?? "0") !== "0") issues.push("不是免费 mint");
  if (data.publicMintBlocked === true) issues.push("public mint 已阻止");
  if (data.effectiveMintStatus && data.effectiveMintStatus !== "LIVE") issues.push(`状态为 ${data.effectiveMintStatus}`);
  if (collection.status && collection.status !== "LIVE") issues.push(`集合状态为 ${collection.status}`);
  if (data.soldOut === true) issues.push("已售罄");
  if (issues.length) throw new Error(`ZecMart 当前不可 mint：${issues.join("；")}`);
}

async function preflightZecMart(config) {
  const base = config.baseUrl;
  const configResult = await requestJson(`${base}/api/mint/config`);
  checkZecMartConfig(configResult.data);
  if (config.priceUnit !== "ZEC") throw new Error("ZecMart 模式的价格单位必须是 ZEC");
  const actualPrice = String(configResult.data?.amountZec ?? configResult.data?.collection?.priceZec ?? "0");
  if (canonicalDecimal(config.mintPrice, "Mint 单价") !== canonicalDecimal(actualPrice, "平台价格")) {
    throw new Error(`配置价格 ${config.mintPrice} ${config.priceUnit} 与平台实际价格 ${actualPrice} ZEC 不一致`);
  }
  const limitResult = await requestJson(`${base}/api/mint/wallet-limits?walletAddress=${encodeURIComponent(config.walletAddress)}`);
  const limits = limitResult.data || {};
  const remaining = Number(limits.effectiveMaxQuantity ?? limits.walletRemainingAllowance);
  const available = Number(limits.availableInventory);
  if (Number.isFinite(remaining) && config.quantity > remaining) {
    throw new Error(`钱包剩余额度 ${remaining}，请求 ${config.quantity}`);
  }
  if (Number.isFinite(available) && config.quantity > available) {
    throw new Error(`剩余库存 ${available}，请求 ${config.quantity}`);
  }
  return { config: configResult.data, limits };
}

function templateBody(template, values) {
  const rendered = String(template)
    .replaceAll("{{walletAddress}}", values.walletAddress)
    .replaceAll("{{quantity}}", String(values.quantity))
    .replaceAll("{{mintPrice}}", values.mintPrice)
    .replaceAll("{{totalPrice}}", values.totalPrice)
    .replaceAll("{{priceUnit}}", values.priceUnit)
    .replaceAll("{{idempotencyKey}}", values.idempotencyKey);
  try {
    return JSON.parse(rendered);
  } catch {
    throw new Error("通用 API Body 模板不是有效 JSON");
  }
}

function completeOrder(order) {
  return order?.status === "COMPLETED"
    || order?.deliveryStatus === "DELIVERED"
    || (order?.status === "PAYMENT_CONFIRMED" && order?.deliveryStatus === "NOT_REQUIRED");
}

function saveState(data) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function runZecMart(config) {
  job.status = "PREFLIGHT";
  log(`检查 ZecMart 配置，钱包 ${maskAddress(config.walletAddress)}，数量 ${config.quantity}`);
  const preflight = await preflightZecMart(config);
  const state = {
    mode: config.mode,
    walletAddress: config.walletAddress,
    quantity: config.quantity,
    idempotencyKey: `mint-${Date.now()}-${crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
  };
  log(`预检通过：${preflight.config.network || "mainnet"} / 单价 ${config.mintPrice} ${config.priceUnit} / 总价 ${config.totalPrice} ${config.priceUnit} / database allocation`);
  if (config.dryRun) {
    job.status = "DRY_RUN_OK";
    log("只预检模式完成，没有创建订单", "success");
    return;
  }
  saveState(state);
  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    job.attempt = attempt;
    job.maxAttempts = config.retries + 1;
    job.status = "SUBMITTING";
    log(`提交 mint 订单（第 ${attempt}/${job.maxAttempts} 次），不会发送 ZEC`);
    try {
      const result = await requestJson(`${config.baseUrl}/api/mint/orders`, {
        method: "POST",
        headers: { "x-idempotency-key": state.idempotencyKey },
        body: JSON.stringify({
          walletAddress: config.walletAddress,
          quantity: config.quantity,
          idempotencyKey: state.idempotencyKey,
        }),
      });
      const order = result.data;
      if (!order?.id) throw new Error("API 没有返回订单 ID");
      job.orderId = order.id;
      saveState({ ...state, orderId: order.id });
      await pollZecMart(config, order.id, state);
      return;
    } catch (error) {
      if (stopRequested) throw error;
      log(`本次失败：${error.message}`, "error");
      if (attempt > config.retries) throw error;
      const wait = config.delayMs * 2 ** (attempt - 1);
      log(`${wait} ms 后使用相同幂等 key 重试，避免重复订单`);
      await sleep(wait);
    }
  }
}

async function pollZecMart(config, orderId, state) {
  const deadline = Date.now() + Math.max(config.pollMs * 2, 10 * 60 * 1000);
  while (Date.now() < deadline) {
    const result = await requestJson(`${config.baseUrl}/api/mint/orders/${encodeURIComponent(orderId)}`);
    const order = result.data;
    log(`订单 ${orderId}：${order?.status || "—"} / ${order?.deliveryStatus || "—"}`);
    if (completeOrder(order)) {
      clearState();
      job.status = "COMPLETED";
      log("Mint 完成：这是数据库分配，不会产生 ZEC 转账 txid", "success");
      return;
    }
    if (order?.status === "FAILED") throw new Error(order.failureReason || "订单失败");
    await sleep(config.pollMs);
  }
  throw new Error(`订单 ${orderId} 轮询超时；已保留本地状态，不会自动重复付款`);
}

async function runGenericHttp(config) {
  job.status = "PREFLIGHT";
  if (config.preflightUrl) {
    log(`执行只读预检：${config.preflightUrl}`);
    const result = await requestJson(config.preflightUrl);
    log(`预检响应：HTTP ${result.status}`);
  }
  const idempotencyKey = `mint-${Date.now()}-${crypto.randomUUID()}`;
  const body = templateBody(config.bodyTemplate, {
    walletAddress: config.walletAddress,
    quantity: config.quantity,
    mintPrice: config.mintPrice,
    totalPrice: config.totalPrice,
    priceUnit: config.priceUnit,
    idempotencyKey,
  });
  if (config.dryRun) {
    job.status = "DRY_RUN_OK";
    log(`模板预检完成：${config.method} ${config.endpoint}，总价 ${config.totalPrice} ${config.priceUnit}`, "success");
    return;
  }
  for (let attempt = 1; attempt <= config.retries + 1; attempt += 1) {
    job.attempt = attempt;
    job.maxAttempts = config.retries + 1;
    job.status = "SUBMITTING";
    try {
      const result = await requestJson(config.endpoint, {
        method: config.method,
        headers: config.headers,
        body: JSON.stringify(body),
      });
      job.status = "COMPLETED";
      log(`API mint 已接受：HTTP ${result.status}`, "success");
      return;
    } catch (error) {
      log(`第 ${attempt} 次失败：${error.message}`, "error");
      if (attempt > config.retries) throw error;
      const wait = config.delayMs * 2 ** (attempt - 1);
      log(`${wait} ms 后重试`);
      await sleep(wait);
    }
  }
}

async function runEvmEnv(config) {
  if (!process.env.MINT_PRIVATE_KEY) {
    throw new Error("未检测到 MINT_PRIVATE_KEY。私钥只从本机环境变量读取，不在网页输入。");
  }
  if (!ethers) throw new Error("ethers 依赖不可用");
  job.status = "PREFLIGHT";
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);
  if (config.chainId && actualChainId !== Number(config.chainId)) {
    throw new Error(`Chain ID 不匹配：RPC 为 ${actualChainId}，配置为 ${config.chainId}`);
  }
  const signer = new ethers.Wallet(process.env.MINT_PRIVATE_KEY, provider);
  const signerAddress = await signer.getAddress();
  if (config.walletAddress && signerAddress.toLowerCase() !== config.walletAddress.toLowerCase()) {
    throw new Error(`环境私钥对应地址 ${maskAddress(signerAddress)} 与配置地址不一致`);
  }
  const feeQuote = await readDynamicFeeQuote(provider, config.gasBoostPercent);
  const tx = {
    to: config.contractAddress,
    data: config.calldata,
    value: BigInt(config.valueWei || "0"),
    ...feeQuote.fields,
  };
  if (config.gasLimit) tx.gasLimit = BigInt(config.gasLimit);
  log(`动态 Gas：加成 ${config.gasBoostPercent}% / ${feeQuoteSummary(feeQuote)}`);
  log(`EVM 预检通过：chain ${actualChainId}，from ${maskAddress(signerAddress)}，总价 ${config.totalPrice} ${config.priceUnit}`);
  const estimated = await provider.estimateGas(tx);
  log(`Gas 估算：${estimated.toString()}`);
  if (config.dryRun) {
    job.status = "DRY_RUN_OK";
    log("只预检模式完成，没有广播交易", "success");
    return;
  }
  log("开始广播交易；收到 tx hash 后不会自动重复发送", "warn");
  const sent = await signer.sendTransaction(tx);
  job.txHash = sent.hash;
  log(`交易已广播：${sent.hash}`);
  const receipt = await sent.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error("交易未成功确认");
  job.status = "COMPLETED";
  log(`交易确认完成：区块 ${receipt.blockNumber}`, "success");
}

async function run(config) {
  try {
    if (config.mode === "zecmart") await runZecMart(config);
    else if (config.mode === "http") await runGenericHttp(config);
    else await runEvmEnv(config);
  } catch (error) {
    if (stopRequested) {
      job.status = "STOPPED";
      log("任务已停止", "warn");
    } else {
      job.status = "FAILED";
      job.error = error.message;
      log(error.message, "error");
    }
  } finally {
    job.running = false;
    job.finishedAt = new Date().toISOString();
    stopRequested = false;
  }
}

function startJob(input) {
  if (job.running) throw new Error("已有任务在运行，请先停止当前任务");
  const config = normaliseConfig(input);
  if (!config.dryRun && config.mode !== "evm-env" && config.confirmBroadcast !== true) {
    throw new Error("执行模式必须勾选风险确认");
  }
  job = freshJob();
  job.id = crypto.randomUUID();
  job.running = true;
  job.status = "STARTING";
  job.mode = config.mode;
  job.startedAt = new Date().toISOString();
  job.maxAttempts = config.retries + 1;
  log(`任务启动：${job.id}`);
  void run(config);
  return publicState();
}

function serveStatic(request, response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safe = path.normalize(relative);
  if (safe.startsWith("..") || path.isAbsolute(safe)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      sendText(response, 404, "Not found");
      return;
    }
    const ext = path.extname(file);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream";
    sendText(response, 200, data, type);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { ok: true, host: HOST, port: PORT, ...publicState() });
      return;
    }
    if (url.pathname === "/api/state" && request.method === "GET") {
      sendJson(response, 200, publicState());
      return;
    }
    if (url.pathname === "/api/preflight" && request.method === "POST") {
      const input = await parseJsonBody(request);
      const config = normaliseConfig({ ...input, dryRun: true });
      let message = "预检通过，没有执行写入";
      if (config.mode === "zecmart") await preflightZecMart(config);
      else if (config.mode === "http") {
        if (config.preflightUrl) await requestJson(config.preflightUrl);
        templateBody(config.bodyTemplate, {
          walletAddress: config.walletAddress,
          quantity: config.quantity,
          mintPrice: config.mintPrice,
          totalPrice: config.totalPrice,
          priceUnit: config.priceUnit,
          idempotencyKey: "preflight-only",
        });
      } else if (config.mode === "evm-env") {
        if (!ethers) throw new Error("EVM 模式需要 ethers 依赖");
        const provider = new ethers.JsonRpcProvider(config.rpcUrl);
        const network = await provider.getNetwork();
        const feeQuote = await readDynamicFeeQuote(provider, config.gasBoostPercent);
        message = `预检通过：chain ${network.chainId.toString()} / 动态 Gas 加成 ${config.gasBoostPercent}% / ${feeQuoteSummary(feeQuote)}`;
      } else {
        sendJson(response, 200, { ok: true, message: "浏览器钱包模式配置通过；实际签名将在浏览器钱包弹窗中完成" });
        return;
      }
      sendJson(response, 200, { ok: true, message });
      return;
    }
    if (url.pathname === "/api/job/start" && request.method === "POST") {
      const input = await parseJsonBody(request);
      sendJson(response, 200, startJob(input));
      return;
    }
    if (url.pathname === "/api/job/stop" && request.method === "POST") {
      if (!job.running) {
        sendJson(response, 200, publicState());
        return;
      }
      stopRequested = true;
      job.status = "STOPPING";
      log("收到停止请求", "warn");
      sendJson(response, 200, publicState());
      return;
    }
    if (url.pathname === "/api/client-event" && request.method === "POST") {
      const input = await parseJsonBody(request);
      if (!job.running) {
        job = freshJob();
        job.id = crypto.randomUUID();
        job.mode = "evm-browser";
        job.startedAt = new Date().toISOString();
      }
      if (input.status) job.status = String(input.status).slice(0, 40);
      if (input.txHash) job.txHash = String(input.txHash).slice(0, 200);
      log(input.message || "浏览器钱包事件", input.level || "info");
      if (["COMPLETED", "FAILED", "STOPPED"].includes(job.status)) {
        job.running = false;
        job.finishedAt = new Date().toISOString();
      }
      sendJson(response, 200, publicState());
      return;
    }
    if (request.method === "GET") {
      serveStatic(request, response, url.pathname);
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, 400, { error: error.message || "请求失败" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mint Console listening at http://${HOST}:${PORT}`);
  console.log(`EVM signing: ${ethers ? "available" : "missing ethers dependency"}`);
  console.log(`Private key configured: ${process.env.MINT_PRIVATE_KEY ? "yes" : "no"}`);
});

function shutdown() {
  stopRequested = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
