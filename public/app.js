"use strict";

const $ = (id) => document.getElementById(id);
const modeNames = { zecmart: "网站 / API", http: "通用 API", "evm-env": "合约 · 环境私钥", "evm-browser": "合约 · 浏览器钱包" };
let selectedMode = "zecmart";
let lastState = null;
let authenticated = false;
let csrfToken = "";

function addLocalLog(message, level = "info") {
  const container = $("logs");
  const empty = container.querySelector(".empty-log");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `log-row ${level}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString();
  const text = document.createElement("span");
  text.textContent = message;
  row.append(time, text);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function setAuthMessage(message) {
  $("auth-message").textContent = message;
}

function setAuthError(message = "") {
  $("auth-error").textContent = message;
}

function setAuthenticated(value, token = "") {
  authenticated = Boolean(value);
  csrfToken = token || "";
  $("auth-gate").classList.toggle("visible", !authenticated);
  $("app-shell").classList.toggle("locked", !authenticated);
  $("app-shell").setAttribute("aria-hidden", String(!authenticated));
  $("logout").hidden = !authenticated;
  if (!authenticated) {
    $("auth-password").value = "";
    $("auth-password").focus();
  }
}

async function checkAuth() {
  try {
    const result = await callApi("/api/auth/status", { headers: {} });
    if (!result.configured) {
      setAuthenticated(false);
      $("auth-password").disabled = true;
      $("login-button").disabled = true;
      setAuthMessage("尚未设置应用密码。请先在 VPS 终端运行 npm run set-password，然后重启服务。");
      return;
    }
    $("auth-password").disabled = false;
    $("login-button").disabled = false;
    if (result.authenticated) {
      setAuthenticated(true, result.csrfToken);
      await refreshState();
      return;
    }
    setAuthenticated(false);
    setAuthMessage("请输入应用密码。密码只在服务端校验，不会保存到网页。");
  } catch (error) {
    setAuthenticated(false);
    $("auth-password").disabled = true;
    $("login-button").disabled = true;
    setAuthMessage("无法连接 Mint Forge，请确认 VPS 服务正在运行。");
    setAuthError(error.message);
  }
}

function showMode(mode) {
  selectedMode = mode;
  $("mode").value = mode;
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  document.querySelectorAll(".zecmart-field").forEach((el) => el.classList.toggle("visible", mode === "zecmart"));
  document.querySelectorAll(".http-only").forEach((el) => el.classList.toggle("visible", mode === "http"));
  document.querySelectorAll(".evm-only").forEach((el) => el.classList.toggle("visible", mode === "evm-env" || mode === "evm-browser"));
  document.querySelectorAll(".env-only").forEach((el) => el.classList.toggle("visible", mode === "evm-env"));
  document.querySelectorAll(".evm-browser-only").forEach((el) => el.classList.toggle("visible", mode === "evm-browser"));
  $("mode-label").textContent = modeNames[mode] || mode;
  $("walletAddress").required = mode !== "evm-env";
}

function value(id) {
  return $(id).value.trim();
}

function decimalToUnits(valueText, decimals) {
  const text = String(valueText || "0").trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error("Mint 单价格式不正确");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw new Error(`价格小数位不能超过 ${decimals} 位`);
  return BigInt(whole) * (10n ** BigInt(decimals))
    + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

function unitsToDecimal(units, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function increaseByPercent(valueText, percent) {
  const amount = BigInt(valueText);
  return (amount * (100n + BigInt(percent)) + 99n) / 100n;
}

function formatGwei(valueText) {
  const amount = BigInt(valueText);
  const scale = 1000000000n;
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction} gwei` : `${whole} gwei`;
}

async function readBrowserFeeQuote(provider, percent) {
  const gasPrice = await provider.request({ method: "eth_gasPrice" });
  const latest = await provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  let priority = null;
  try {
    priority = await provider.request({ method: "eth_maxPriorityFeePerGas" });
  } catch {
    // Some RPCs do not expose eth_maxPriorityFeePerGas; legacy gasPrice remains usable.
  }
  if (latest?.baseFeePerGas && priority) {
    const maxFeePerGas = increaseByPercent(gasPrice, percent);
    const maxPriorityFeePerGas = increaseByPercent(priority, percent);
    const finalMaxFee = BigInt(maxFeePerGas) < BigInt(maxPriorityFeePerGas) ? maxPriorityFeePerGas : maxFeePerGas;
    return {
      type: "eip1559",
      fields: { maxFeePerGas: `0x${BigInt(finalMaxFee).toString(16)}`, maxPriorityFeePerGas: `0x${BigInt(maxPriorityFeePerGas).toString(16)}` },
      summary: `EIP-1559 maxFee ${formatGwei(gasPrice)} → ${formatGwei(finalMaxFee)}，priority ${formatGwei(priority)} → ${formatGwei(maxPriorityFeePerGas)}`,
    };
  }
  const finalGasPrice = increaseByPercent(gasPrice, percent);
  return {
    type: "legacy",
    fields: { gasPrice: `0x${BigInt(finalGasPrice).toString(16)}` },
    summary: `legacy gasPrice ${formatGwei(gasPrice)} → ${formatGwei(finalGasPrice)}`,
  };
}

function updatePricePreview() {
  try {
    const decimals = Number($("priceDecimals").value || 8);
    const unitPrice = decimalToUnits($("mintPrice").value || "0", decimals);
    const total = unitPrice * BigInt($("quantity").value || 1);
    $("totalPrice").value = `${unitsToDecimal(total, decimals)} ${$("priceUnit").value}`;
    if (!value("valueWei") && selectedMode.startsWith("evm-")) {
      $("valueWei").placeholder = `${total.toString()}（总价最小单位）`;
    }
  } catch {
    $("totalPrice").value = "格式错误";
  }
}

function configFromForm(forceDryRun = null) {
  const dryRun = forceDryRun === null ? $("dryRun").checked : forceDryRun;
  const priceDecimals = Number($("priceDecimals").value || 8);
  const mintPriceUnits = decimalToUnits(value("mintPrice") || "0", priceDecimals);
  const totalPriceUnits = mintPriceUnits * BigInt($("quantity").value || 1);
  return {
    mode: selectedMode,
    baseUrl: value("baseUrl"),
    endpoint: value("endpoint"),
    preflightUrl: value("preflightUrl"),
    method: "POST",
    headersText: value("headersText"),
    bodyTemplate: $("bodyTemplate").value,
    rpcUrl: value("rpcUrl"),
    chainId: value("chainId") || null,
    contractAddress: value("contractAddress"),
    calldata: value("calldata") || "0x",
    valueWei: value("valueWei") || totalPriceUnits.toString(),
    gasLimit: value("gasLimit"),
    gasBoostPercent: Number($("gasBoostPercent").value || 0),
    walletAddress: value("walletAddress"),
    quantity: Number($("quantity").value),
    mintPrice: value("mintPrice") || "0",
    priceUnit: value("priceUnit") || "ZEC",
    priceDecimals,
    retries: Number($("retries").value),
    delayMs: Number($("delaySec").value) * 1000,
    pollMs: Number($("pollSec").value) * 1000,
    dryRun,
    confirmBroadcast: $("confirmBroadcast").checked,
  };
}

async function callApi(path, options = {}) {
  const { skipCsrf = false, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const requestHeaders = { "content-type": "application/json", ...(fetchOptions.headers || {}) };
  if (!skipCsrf && csrfToken && method !== "GET") requestHeaders["x-csrf-token"] = csrfToken;
  const response = await fetch(path, {
    ...fetchOptions,
    headers: requestHeaders,
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/auth/status" && path !== "/api/auth/login") {
      setAuthenticated(false);
      setAuthMessage("登录已过期，请重新输入应用密码。");
    }
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderLogs(state) {
  const container = $("logs");
  if (!state.logs?.length) {
    container.innerHTML = '<div class="empty-log">日志会显示在这里…</div>';
    return;
  }
  container.innerHTML = "";
  for (const item of state.logs) {
    const row = document.createElement("div");
    row.className = `log-row ${item.level}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date(item.at).toLocaleTimeString();
    const text = document.createElement("span");
    text.textContent = item.message;
    row.append(time, text);
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}

function renderState(state) {
  lastState = state;
  const running = Boolean(state.running);
  const status = state.status || "IDLE";
  $("status-pill").textContent = status;
  $("status-pill").className = `status-pill ${status.toLowerCase()}`;
  $("live-dot").className = `dot ${running ? "busy" : status === "COMPLETED" ? "done" : ""}`;
  $("state-title").textContent = running ? "任务运行中" : ({ COMPLETED: "执行完成", FAILED: "执行失败", STOPPED: "已停止", DRY_RUN_OK: "预检完成", IDLE: "准备就绪" }[status] || status);
  $("state-caption").textContent = state.error || (running ? "请不要重复打开或重复提交" : "等待下一次操作");
  $("attempt").textContent = `${state.attempt || 0} / ${state.maxAttempts || 0}`;
  $("order-id").textContent = state.orderId ? String(state.orderId).slice(0, 12) : state.txHash ? `${state.txHash.slice(0, 8)}…` : "—";
  $("key-status").textContent = state.privateKeyConfigured ? "已配置（环境）" : "未加载";
  $("runtime-detail").textContent = state.ethersAvailable ? "EVM 模块可用" : "API 模块可用";
  $("start").disabled = running;
  $("preflight").disabled = running;
  $("stop").disabled = !running;
  renderLogs(state);
}

async function refreshState() {
  try {
    const state = await callApi("/api/state", { headers: {} });
    renderState(state);
  } catch (error) {
    $("runtime-label").textContent = "OFFLINE";
    $("live-dot").className = "dot error";
  }
}

async function preflight() {
  try {
    const config = configFromForm(true);
    if (selectedMode === "evm-browser") {
      await preflightBrowserEvm(config);
      addLocalLog("浏览器钱包预检通过：没有广播交易", "success");
      return;
    }
    addLocalLog("开始预检…");
    await callApi("/api/preflight", { method: "POST", body: JSON.stringify(config) });
    addLocalLog("预检通过：没有提交订单或广播交易", "success");
  } catch (error) {
    addLocalLog(`预检失败：${error.message}`, "error");
  }
}

async function start() {
  const config = configFromForm();
  if (!config.dryRun && !config.confirmBroadcast) {
    addLocalLog("请先勾选风险确认，再执行写入操作", "error");
    return;
  }
  if (selectedMode === "evm-browser") {
    await startBrowserEvm(config);
    return;
  }
  try {
    await callApi("/api/job/start", { method: "POST", body: JSON.stringify(config) });
    addLocalLog(config.dryRun ? "已启动只预检任务" : "已启动执行任务", "success");
    await refreshState();
  } catch (error) {
    addLocalLog(`启动失败：${error.message}`, "error");
  }
}

function hexQuantity(value) {
  return `0x${BigInt(value || "0").toString(16)}`;
}

async function browserProvider() {
  if (!window.ethereum) throw new Error("当前浏览器没有检测到 EVM 钱包扩展");
  return window.ethereum;
}

async function preflightBrowserEvm(config) {
  const provider = await browserProvider();
  const chainHex = await provider.request({ method: "eth_chainId" });
  const chainId = Number.parseInt(chainHex, 16);
  if (config.chainId && chainId !== Number(config.chainId)) {
    throw new Error(`钱包 Chain ID 为 ${chainId}，配置要求 ${config.chainId}`);
  }
  const feeQuote = await readBrowserFeeQuote(provider, config.gasBoostPercent);
  const tx = {
    from: config.walletAddress,
    to: config.contractAddress,
    data: config.calldata,
    value: hexQuantity(config.valueWei),
    ...feeQuote.fields,
  };
  if (config.gasLimit) tx.gas = hexQuantity(config.gasLimit);
  await provider.request({ method: "eth_call", params: [tx, "latest"] });
  const gas = await provider.request({ method: "eth_estimateGas", params: [tx] });
  addLocalLog(`动态 Gas：加成 ${config.gasBoostPercent}% / ${feeQuote.summary}`);
  addLocalLog(`浏览器钱包预检通过：chain ${chainId}，Gas 估算 ${BigInt(gas).toString()}`);
  return feeQuote.fields;
}

async function startBrowserEvm(config) {
  try {
    const provider = await browserProvider();
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const from = accounts?.[0];
    if (!from) throw new Error("钱包没有返回账户");
    $("walletAddress").value = from;
    config.walletAddress = from;
    const feeFields = await preflightBrowserEvm(config);
    if (config.dryRun) {
      await callApi("/api/client-event", { method: "POST", body: JSON.stringify({ status: "DRY_RUN_OK", message: "浏览器钱包预检完成，没有广播交易", level: "success" }) });
      return;
    }
    addLocalLog("即将打开浏览器钱包确认；不会自动重复签名", "warn");
    const tx = { from, to: config.contractAddress, data: config.calldata, value: hexQuantity(config.valueWei), ...feeFields };
    if (config.gasLimit) tx.gas = hexQuantity(config.gasLimit);
    const txHash = await provider.request({ method: "eth_sendTransaction", params: [tx] });
    await callApi("/api/client-event", { method: "POST", body: JSON.stringify({ status: "COMPLETED", txHash, message: `交易已由浏览器钱包广播：${txHash}`, level: "success" }) });
  } catch (error) {
    addLocalLog(`浏览器钱包执行失败：${error.message}`, "error");
    await callApi("/api/client-event", { method: "POST", body: JSON.stringify({ status: "FAILED", message: error.message, level: "error" }) }).catch(() => {});
  }
}

async function stop() {
  try {
    await callApi("/api/job/stop", { method: "POST", body: "{}" });
    addLocalLog("已发送停止请求", "warn");
    await refreshState();
  } catch (error) {
    addLocalLog(`停止失败：${error.message}`, "error");
  }
}

async function login(event) {
  event.preventDefault();
  setAuthError("");
  const password = $("auth-password").value;
  if (!password) {
    setAuthError("请输入应用密码");
    return;
  }
  $("login-button").disabled = true;
  try {
    const result = await callApi("/api/auth/login", {
      method: "POST",
      skipCsrf: true,
      body: JSON.stringify({ password }),
    });
    setAuthenticated(true, result.csrfToken);
    await refreshState();
  } catch (error) {
    setAuthError(error.message);
    $("login-button").disabled = false;
    $("auth-password").select();
  }
}

async function logout() {
  try {
    await callApi("/api/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // Clear the local gate even if the session already expired.
  }
  setAuthenticated(false);
  setAuthMessage("请输入应用密码重新进入控制台。");
  $("auth-password").disabled = false;
  $("login-button").disabled = false;
  setAuthError("");
}

document.querySelectorAll(".mode-tab").forEach((button) => {
  button.addEventListener("click", () => showMode(button.dataset.mode));
});
$("preflight").addEventListener("click", preflight);
$("start").addEventListener("click", start);
$("stop").addEventListener("click", stop);
$("login-form").addEventListener("submit", login);
$("logout").addEventListener("click", logout);
$("clear-log").addEventListener("click", () => { $("logs").innerHTML = '<div class="empty-log">日志会显示在这里…</div>'; });
$("connect-wallet").addEventListener("click", async () => {
  try {
    const provider = await browserProvider();
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    if (!accounts?.[0]) throw new Error("钱包没有返回账户");
    $("walletAddress").value = accounts[0];
    addLocalLog(`已连接浏览器钱包：${accounts[0].slice(0, 8)}…${accounts[0].slice(-6)}`, "success");
  } catch (error) {
    addLocalLog(`连接钱包失败：${error.message}`, "error");
  }
});
$("dryRun").addEventListener("change", () => {
  $("confirmBroadcast").disabled = $("dryRun").checked;
  if ($("dryRun").checked) $("confirmBroadcast").checked = false;
});
["mintPrice", "priceDecimals", "quantity"].forEach((id) => $(id).addEventListener("input", updatePricePreview));
$("priceUnit").addEventListener("change", updatePricePreview);

showMode("zecmart");
$("confirmBroadcast").disabled = true;
updatePricePreview();
checkAuth();
setInterval(() => {
  if (authenticated) refreshState();
}, 1000);
