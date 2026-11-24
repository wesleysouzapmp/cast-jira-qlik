#!/usr/bin/env bash
# Instala ou atualiza o cast-jira-qlik numa VM Ubuntu (Oracle Cloud Always Free).
# - Node.js 24, usuário de sistema próprio, código em /opt/cast-jira-qlik, serviço systemd "cast-jira".
# - O app escuta só em 127.0.0.1:3100. Nenhuma porta é aberta: acesse por túnel SSH.
# - Rodar de novo atualiza o código (git pull) e reinicia o serviço; .env e dados são preservados.
# Uso (na VM, como o usuário ubuntu):  bash setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/wesleysouzapmp/cast-jira-qlik.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/cast-jira-qlik}"
APP_USER="${APP_USER:-castjira}"
SERVICE="cast-jira"
NODE_MAJOR=24

say() { printf '\n==> %s\n' "$*"; }
as_app() { sudo -u "$APP_USER" -H "$@"; }

say "Pacotes básicos"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates

current_node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(current_node_major)" -lt 22 ]; then
  say "Node.js ${NODE_MAJOR} (repositório oficial NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  sudo -E bash /tmp/nodesource_setup.sh
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
echo "node $(node --version), npm $(npm --version)"

# VM de 1 GB (VM.Standard.E2.1.Micro): 1 GB de swap evita falta de memória no npm.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 2000000 ] && [ "$(swapon --show | wc -l)" -eq 0 ]; then
  say "Criando 1 GB de swap"
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

say "Fuso horário America/Sao_Paulo (só para os logs; o app já usa -03:00)"
sudo timedatectl set-timezone America/Sao_Paulo || true

if ! id "$APP_USER" >/dev/null 2>&1; then
  say "Usuário de sistema ${APP_USER}"
  sudo useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

if [ -d "$APP_DIR/.git" ]; then
  say "Atualizando o código em ${APP_DIR}"
  as_app git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  as_app git -C "$APP_DIR" merge --ff-only --quiet "origin/$BRANCH"
else
  say "Baixando o código em ${APP_DIR}"
  sudo mkdir -p "$APP_DIR"
  sudo chown "$APP_USER:$APP_USER" "$APP_DIR"
  as_app git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

say "Dependências (npm ci, sem as de desenvolvimento)"
(cd "$APP_DIR" && as_app npm ci --omit=dev --no-audit --no-fund)

if [ ! -f "$APP_DIR/.env" ]; then
  say "Criando ${APP_DIR}/.env a partir do exemplo (preencha antes de iniciar)"
  sudo install -m 600 -o "$APP_USER" -g "$APP_USER" "$APP_DIR/.env.example" "$APP_DIR/.env"
fi
sudo chmod 600 "$APP_DIR/.env"
sudo chown "$APP_USER:$APP_USER" "$APP_DIR/.env"

say "Serviço systemd ${SERVICE}"
sed -e "s#__USER__#${APP_USER}#g" -e "s#__DIR__#${APP_DIR}#g" -e "s#__NODE__#$(command -v node)#g" \
  "$APP_DIR/deploy/oracle/cast-jira.service" | sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null

if sudo grep -Eq '^JIRA_API_TOKEN=.+' "$APP_DIR/.env" && sudo grep -Eq '^JIRA_EMAIL=.+@' "$APP_DIR/.env"; then
  sudo systemctl restart "$SERVICE"
  sleep 2
  sudo systemctl --no-pager --lines=5 status "$SERVICE" || true
  say "Pronto. No seu PC, abra o túnel e acesse http://localhost:3100 (veja deploy/oracle/README.md)."
else
  say "Falta configurar o .env: sudo nano ${APP_DIR}/.env  (JIRA_EMAIL e JIRA_API_TOKEN)"
  echo "Depois: sudo systemctl restart ${SERVICE}"
fi
