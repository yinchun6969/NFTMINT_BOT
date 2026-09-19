#!/usr/bin/env bash
set -Eeuo pipefail

# Mint Forge guided installer for Ubuntu/Debian VPS.
# The installer keeps Node on 127.0.0.1 and optionally installs a
# Cloudflare Tunnel connector. It never asks for a seed phrase.

APP_NAME="mint-forge"
REPO_URL="${MINT_FORGE_REPO_URL:-https://github.com/yinchun6969/NFTMINT_BOT.git}"
REPO_BRANCH="${MINT_FORGE_BRANCH:-main}"
DEFAULT_INSTALL_DIR="/opt/nftmint-bot"
SERVICE_USER="mintforge"
SERVICE_HOME="/var/lib/mintforge"
APP_PORT="8787"
ENV_DIR="/etc/mint-forge"
ENV_FILE="${ENV_DIR}/mint-forge.env"
APP_UNIT="/etc/systemd/system/mint-forge.service"
TUNNEL_ENV_FILE="${ENV_DIR}/cloudflared.env"
TUNNEL_UNIT="/etc/systemd/system/mint-forge-tunnel.service"
TUNNEL_CONFIGURED='N'

if [[ "${EUID}" -eq 0 ]]; then
  SUDO=()
else
  SUDO=(sudo)
fi

if [[ "${EUID}" -eq 0 ]]; then
  run_root() { "$@"; }
  run_service() { runuser -u "${SERVICE_USER}" -- "$@"; }
else
  run_root() { "${SUDO[@]}" "$@"; }
  run_service() { "${SUDO[@]}" -u "${SERVICE_USER}" -H "$@"; }
fi

red="\033[31m"
green="\033[32m"
yellow="\033[33m"
cyan="\033[36m"
reset="\033[0m"

info() { printf "%b\n" "${cyan}[Mint Forge]${reset} $*"; }
success() { printf "%b\n" "${green}[完成]${reset} $*"; }
warn() { printf "%b\n" "${yellow}[提示]${reset} $*"; }
die() { printf "%b\n" "${red}[停止]${reset} $*" >&2; exit 1; }

usage() {
  cat <<'HELP'
Mint Forge VPS guided installer

Usage:
  ./install_mint_forge.sh

Optional environment variables:
  MINT_FORGE_REPO_URL     Git repository URL override
  MINT_FORGE_BRANCH       Git branch override (default: main)

The installer is intentionally interactive because it creates an application
password and may receive a Cloudflare Tunnel connector token.
HELP
}

trap 'die "安装过程中出现错误，建议查看上方最后一条命令。"' ERR

require_interactive_terminal() {
  [[ -t 0 && -t 1 ]] || die "请通过 SSH/终端交互运行此向导，不要在后台任务中运行。"
}

ask() {
  local prompt="$1"
  local default_value="${2:-}"
  local answer
  if [[ -n "${default_value}" ]]; then
    read -r -p "${prompt} [${default_value}]: " answer
    printf '%s' "${answer:-${default_value}}"
  else
    read -r -p "${prompt}: " answer
    printf '%s' "${answer}"
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default_value="${2:-N}"
  local answer
  read -r -p "${prompt} [${default_value}/$( [[ "${default_value}" == "Y" ]] && printf 'n' || printf 'y' )]: " answer
  answer="${answer:-${default_value}}"
  [[ "${answer}" =~ ^[Yy]$ ]]
}

check_os() {
  [[ -r /etc/os-release ]] || die "找不到 /etc/os-release，当前系统不是标准 Ubuntu/Debian。"
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) die "当前向导支持 Ubuntu/Debian，检测到：${ID:-unknown}。" ;;
  esac
  info "检测到系统：${PRETTY_NAME:-${ID}}"
}

install_prerequisites() {
  info "更新软件索引并安装 Git、Node.js、npm、curl 和证书工具…"
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git gnupg
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 18 ]]; then
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs npm
  fi
  command -v node >/dev/null 2>&1 || die "Node.js 安装失败。"
  command -v npm >/dev/null 2>&1 || die "npm 安装失败。"
  command -v git >/dev/null 2>&1 || die "Git 安装失败。"
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  [[ "${node_major}" -ge 18 ]] || die "Node.js 版本必须 >= 18，当前为 $(node --version)。"
  success "Node.js $(node --version)，npm $(npm --version)"
}

create_service_user() {
  if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    run_root useradd --system --home-dir "${SERVICE_HOME}" --create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi
  run_root install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${SERVICE_HOME}"
}

prepare_repository() {
  local install_dir="$1"
  run_root install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0750 "${install_dir}"

  if [[ -d "${install_dir}/.git" ]]; then
    info "发现已有 Mint Forge 安装，尝试安全快进更新…"
    run_service git -C "${install_dir}" fetch --depth=1 origin "${REPO_BRANCH}"
    run_service git -C "${install_dir}" merge --ff-only "origin/${REPO_BRANCH}"
  else
    if find "${install_dir}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
      die "安装目录 ${install_dir} 已存在且不是 Mint Forge Git 仓库，请换一个目录。"
    fi
    run_service git clone --depth=1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${install_dir}"
  fi

  run_root chown -R "${SERVICE_USER}:${SERVICE_USER}" "${install_dir}"
  info "安装 Node 依赖…"
  if [[ -f "${install_dir}/package-lock.json" ]]; then
    run_service env HOME="${SERVICE_HOME}" bash -lc "cd '${install_dir}' && npm ci --omit=dev"
  else
    run_service env HOME="${SERVICE_HOME}" bash -lc "cd '${install_dir}' && npm install --omit=dev"
  fi
  success "代码和依赖已准备：${install_dir}"
}

write_app_env() {
  local private_key="${1:-}"
  run_root install -d -m 0750 "${ENV_DIR}"
  {
    printf 'MINT_HOST=127.0.0.1\n'
    printf 'MINT_PORT=%s\n' "${APP_PORT}"
    printf 'MINT_COOKIE_SECURE=false\n'
    if [[ -n "${private_key}" ]]; then
      printf 'MINT_PRIVATE_KEY=%s\n' "${private_key}"
    fi
  } | run_root tee "${ENV_FILE}" >/dev/null
  run_root chmod 0600 "${ENV_FILE}"
}

write_app_unit() {
  local install_dir="$1"
  local npm_path
  npm_path="$(command -v npm)"
  run_root tee "${APP_UNIT}" >/dev/null <<EOF
[Unit]
Description=Mint Forge NFT Mint Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${install_dir}
EnvironmentFile=${ENV_FILE}
ExecStart=${npm_path} start
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
ReadWritePaths=${install_dir}
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  run_root chmod 0644 "${APP_UNIT}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  run_root sed -i "s|^${key}=.*$|${key}=${value}|" "${ENV_FILE}"
}

start_app() {
  run_root systemctl daemon-reload
  run_root systemctl enable --now "${APP_NAME}.service"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1; then
      success "Mint Forge 已启动，Node 仍只监听 127.0.0.1:${APP_PORT}"
      return
    fi
    sleep 1
  done
  run_root systemctl --no-pager --full status "${APP_NAME}.service" || true
  die "Mint Forge 没有在预期时间内启动。可执行：journalctl -u ${APP_NAME} -n 100 --no-pager"
}

install_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    success "已检测到 cloudflared：$(cloudflared --version | head -n 1)"
    return
  fi
  info "安装 Cloudflare Tunnel 连接器…"
  run_root install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | run_root tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    | run_root tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y cloudflared
  command -v cloudflared >/dev/null 2>&1 || die "cloudflared 安装失败。"
  success "cloudflared 已安装。"
}

configure_cloudflare_tunnel() {
  local hostname="$1"
  install_cloudflared

  printf '\n%b\n' "${yellow}现在请在 Cloudflare Zero Trust 中完成：${reset}"
  printf '%s\n' "1. Networks → Tunnels → Create tunnel → Cloudflared。"
  printf '%s\n' "2. 创建 Tunnel 后，复制页面给出的 connector token。"
  printf '%s\n' "3. Public Hostname 填：${hostname}。"
  printf '%s\n' "4. Service 填：http://127.0.0.1:${APP_PORT}。"
  printf '%s\n\n' "5. Access → Applications → Self-hosted，为该域名添加你的邮箱/MFA Allow 策略。"
  read -r -p "完成 Cloudflare Tunnel 创建后按 Enter 继续，或输入 s 跳过：" tunnel_continue
  [[ "${tunnel_continue}" =~ ^[Ss]$ ]] && { warn "已跳过 Tunnel；之后可重新运行本脚本或手动配置。"; return; }

  local token
  read -r -s -p "粘贴 Cloudflare connector token（输入不会显示）：" token
  printf '\n'
  [[ -n "${token}" ]] || { warn "没有输入 token，已跳过 Tunnel。"; return; }
  [[ "${token}" != *[[:space:]]* ]] || die "Tunnel token 不能包含空格或换行。"

  run_root install -d -m 0750 "${ENV_DIR}"
  printf 'CLOUDFLARED_TUNNEL_TOKEN=%s\n' "${token}" | run_root tee "${TUNNEL_ENV_FILE}" >/dev/null
  run_root chmod 0600 "${TUNNEL_ENV_FILE}"

  local cloudflared_path
  cloudflared_path="$(command -v cloudflared)"
  run_root tee "${TUNNEL_UNIT}" >/dev/null <<EOF
[Unit]
Description=Cloudflare Tunnel for Mint Forge
After=network-online.target mint-forge.service
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${TUNNEL_ENV_FILE}
ExecStart=${cloudflared_path} tunnel run --token \${CLOUDFLARED_TUNNEL_TOKEN}
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  run_root chmod 0644 "${TUNNEL_UNIT}"
  run_root systemctl daemon-reload
  if run_root systemctl enable --now mint-forge-tunnel.service; then
    sleep 2
  fi
  if run_root systemctl is-active --quiet mint-forge-tunnel.service; then
    set_env_value MINT_COOKIE_SECURE true
    run_root systemctl restart "${APP_NAME}.service"
    TUNNEL_CONFIGURED='Y'
    success "Cloudflare Tunnel 服务已启动。"
  else
    set_env_value MINT_COOKIE_SECURE false
    run_root systemctl restart "${APP_NAME}.service" || true
    run_root systemctl --no-pager --full status mint-forge-tunnel.service || true
    warn "Tunnel 服务未保持运行，请查看：journalctl -u mint-forge-tunnel -n 100 --no-pager"
  fi
}

print_summary() {
  local install_dir="$1"
  local hostname="$2"
  local tunnel_requested="$3"
  printf '\n%b\n' "${green}================ Mint Forge 部署完成 ================${reset}"
  printf '%s\n' "安装目录：${install_dir}"
  printf '%s\n' "服务名称：${APP_NAME}.service"
  printf '%s\n' "本机地址：http://127.0.0.1:${APP_PORT}"
  printf '%s\n' "查看日志：sudo journalctl -u ${APP_NAME} -f"
  printf '%s\n' "查看状态：sudo systemctl status ${APP_NAME}"
  printf '%s\n' "修改应用密码：sudo -u ${SERVICE_USER} -H bash -lc 'cd ${install_dir} && npm run set-password'"
  if [[ "${TUNNEL_CONFIGURED}" == "Y" ]]; then
    printf '%s\n' "Cloudflare 地址：https://${hostname}"
    printf '%s\n' "Tunnel 日志：sudo journalctl -u mint-forge-tunnel -f"
  elif [[ "${tunnel_requested}" == "Y" ]]; then
    printf '%s\n' "Cloudflare Tunnel 尚未完成；当前请先使用 SSH：ssh -N -L ${APP_PORT}:127.0.0.1:${APP_PORT} user@VPS_IP"
  else
    printf '%s\n' "SSH 访问：ssh -N -L ${APP_PORT}:127.0.0.1:${APP_PORT} user@VPS_IP"
  fi
  printf '%b\n' "${yellow}安全提醒：Node 没有开放公网端口；不要把 MINT_PRIVATE_KEY、密码或 Tunnel token 提交到 GitHub。${reset}"
}

main() {
  require_interactive_terminal
  check_os
  [[ -x "$(command -v bash)" ]] || die "bash 不可用。"
  if [[ "${EUID}" -ne 0 ]]; then
    run_root -v
  fi

  printf '%b\n' "${cyan}Mint Forge VPS 一键安装向导${reset}"
  printf '%s\n' "本向导会安装独立服务用户、systemd 开机启动和应用密码。Node 默认只绑定 127.0.0.1。"
  printf '%s\n\n' "不会要求助记词；私钥仅可选地写入 VPS 本地权限 600 的环境文件。"

  local install_dir
  install_dir="$(ask '安装目录' "${DEFAULT_INSTALL_DIR}")"
  [[ "${install_dir}" == /* ]] || die "安装目录必须是绝对路径。"
  [[ "${install_dir}" != *[[:space:]]* ]] || die "安装目录不能包含空格。"

  printf '\n%s\n' "访问方式："
  printf '%s\n' "  1) SSH/Tailscale（不配置公网域名）"
  printf '%s\n' "  2) Cloudflare Tunnel + 域名（推荐，Node 仍保持 loopback）"
  local access_choice
  access_choice="$(ask '请选择 1 或 2' '2')"
  [[ "${access_choice}" == '1' || "${access_choice}" == '2' ]] || die "请选择 1 或 2。"

  local tunnel_requested='N'
  local hostname='mint.91nft.cyou'
  if [[ "${access_choice}" == '2' ]]; then
    tunnel_requested='Y'
    hostname="$(ask 'Cloudflare 公共域名' "${hostname}")"
    hostname="${hostname,,}"
    [[ "${hostname}" =~ ^[a-z0-9][a-z0-9.-]*[a-z0-9]$ ]] || die "域名格式不正确。"
  fi

  local private_key=''
  if ask_yes_no '是否现在配置 EVM 环境私钥（可稍后手动配置）' 'N'; then
    read -r -s -p '输入 0x 开头的 64 位十六进制私钥：' private_key
    printf '\n'
    [[ "${private_key}" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "私钥格式不正确，已停止，不会保存输入内容。"
  fi

  printf '\n%s\n' "即将执行："
  printf '%s\n' "- 安装/检查 Node.js >= 18、npm、Git"
  printf '%s\n' "- 从 ${REPO_URL} 拉取 ${REPO_BRANCH}"
  printf '%s\n' "- 创建系统用户 ${SERVICE_USER}"
  printf '%s\n' "- 设置应用密码并注册 systemd 服务"
  [[ "${tunnel_requested}" == 'Y' ]] && printf '%s\n' "- 引导配置 Cloudflare Tunnel：${hostname}"
  ask_yes_no '确认开始安装' 'Y' || { warn '用户取消安装。'; exit 0; }

  install_prerequisites
  create_service_user
  prepare_repository "${install_dir}"
  write_app_env "${private_key}"
  write_app_unit "${install_dir}"

  printf '\n%b\n' "${yellow}现在设置 Mint Forge 应用密码（至少 12 字节，输入不会显示）：${reset}"
  run_service env HOME="${SERVICE_HOME}" bash -lc "cd '${install_dir}' && npm run set-password"
  start_app

  if [[ "${tunnel_requested}" == 'Y' ]]; then
    configure_cloudflare_tunnel "${hostname}"
  fi
  print_summary "${install_dir}" "${hostname}" "${tunnel_requested}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

main "$@"
