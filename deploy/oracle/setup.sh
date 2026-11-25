#!/usr/bin/env bash
# Instala ou atualiza o cast-jira-qlik numa VM Ubuntu (Oracle Cloud Always Free).
# - Node.js 24, usuário de sistema próprio, código em /opt/cast-jira-qlik, serviço systemd "cast-jira".
# - O app escuta só em 127.0.0.1:3100. Com PUBLIC_HOST no .env, o Caddy publica em HTTPS (80/443); sem ele, acesse por túnel SSH.
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
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates openssl

current_node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
# O app usa node:sqlite (sem flag a partir do Node 22.13); exigimos o Node ${NODE_MAJOR}.
node_has_sqlite() { node -e "require('node:sqlite')" >/dev/null 2>&1; }
if [ "$(current_node_major)" -lt "$NODE_MAJOR" ] || ! node_has_sqlite; then
  say "Node.js ${NODE_MAJOR} (repositório oficial NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
  sudo -E bash /tmp/nodesource_setup.sh
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
if [ "$(current_node_major)" -lt "$NODE_MAJOR" ] || ! node_has_sqlite; then
  echo "Node.js $(node --version 2>/dev/null || echo ausente) não serve: é preciso o Node.js >= ${NODE_MAJOR} com node:sqlite."
  exit 1
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

# Lê o valor de uma variável do .env (vazio se não existir).
env_get() { sudo cat "$APP_DIR/.env" | awk -v k="$1" 'index($0, k "=") == 1 { v = substr($0, length(k) + 2) } END { print v }' | tr -d '\r'; }
# Grava (ou acrescenta) CHAVE=valor no .env sem passar o valor na linha de comando.
env_set() {
  ENV_TMP="$(mktemp)"; trap 'rm -f "${ENV_TMP:-}"' EXIT INT TERM
  sudo cat "$APP_DIR/.env" | K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; d = 0 }
    index($0, k "=") == 1 { if (!d) print k "=" v; d = 1; next }
    { print }
    END { if (!d) print k "=" v }' > "$ENV_TMP"
  sudo install -m 600 -o "$APP_USER" -g "$APP_USER" "$ENV_TMP" "$APP_DIR/.env"
  rm -f "$ENV_TMP"
}

if [ -z "$(env_get APP_SECRET_KEY)" ]; then
  say "Gerando APP_SECRET_KEY no .env (guarde uma cópia do .env: sem a chave os tokens do banco ficam ilegíveis)"
  NEW_KEY="$(openssl rand -base64 32)"
  [ -n "$NEW_KEY" ] || { echo "Falha ao gerar a APP_SECRET_KEY (openssl)."; exit 1; }
  env_set APP_SECRET_KEY "$NEW_KEY"
  unset NEW_KEY
fi
if [ -z "$(env_get APP_SECRET_KEY)" ]; then
  echo "APP_SECRET_KEY continua vazia no .env; não reinicio o serviço (ele não subiria)."
  exit 1
fi
DATA_DIR_PATH="$APP_DIR/data"
if [ -z "$(env_get DATA_DIR)" ]; then env_set DATA_DIR "$DATA_DIR_PATH"; fi
DATA_DIR_PATH="$(env_get DATA_DIR)"
case "$DATA_DIR_PATH" in /*) ;; *) echo "DATA_DIR no .env precisa ser um caminho absoluto (está: ${DATA_DIR_PATH})."; exit 1 ;; esac
sudo install -d -m 700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR_PATH"

say "sqlite3 (backup) e Caddy (HTTPS)"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y sqlite3 debian-keyring debian-archive-keyring apt-transport-https gpg
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi

say "Serviço systemd ${SERVICE}"
render_unit() { # modelo destino
  sed -e "s#__USER__#${APP_USER}#g" -e "s#__DATA_DIR__#${DATA_DIR_PATH}#g" -e "s#__DIR__#${APP_DIR}#g" -e "s#__NODE__#$(command -v node)#g" "$1" | sudo tee "$2" >/dev/null
}
render_unit "$APP_DIR/deploy/oracle/cast-jira.service" "/etc/systemd/system/${SERVICE}.service"

say "Backup diário do banco (7 cópias em /var/backups/cast-jira)"
sudo install -d -m 700 -o "$APP_USER" -g "$APP_USER" /var/backups/cast-jira
render_unit "$APP_DIR/deploy/oracle/cast-jira-backup.service" /etc/systemd/system/cast-jira-backup.service
sudo install -m 644 "$APP_DIR/deploy/oracle/cast-jira-backup.timer" /etc/systemd/system/cast-jira-backup.timer

DUCK_ON=0
if [ -n "$(env_get DUCKDNS_DOMAIN)" ] && [ -n "$(env_get DUCKDNS_TOKEN)" ]; then
  DUCK_ON=1
  say "DuckDNS: atualização do IP a cada 5 minutos"
  render_unit "$APP_DIR/deploy/oracle/duckdns.service" /etc/systemd/system/duckdns.service
  sudo install -m 644 "$APP_DIR/deploy/oracle/duckdns.timer" /etc/systemd/system/duckdns.timer
fi

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl enable --now cast-jira-backup.timer >/dev/null
if [ "$DUCK_ON" -eq 1 ]; then sudo systemctl enable --now duckdns.timer >/dev/null; fi

PUBLIC_HOST_VALUE="$(env_get PUBLIC_HOST)"
case "$PUBLIC_HOST_VALUE" in
  *[!A-Za-z0-9.-]*|.*|*.)
    echo "ERRO: PUBLIC_HOST inválido no .env (use só letras, números, ponto e hífen); o Caddy e o Caddyfile não foram alterados."
    CADDY_OK=0 ;;
esac
CADDY_OK="${CADDY_OK:-1}"
if [ -n "$PUBLIC_HOST_VALUE" ] && [ "$CADDY_OK" -eq 1 ]; then
  say "Caddy para https://${PUBLIC_HOST_VALUE}"
  PORT_VALUE="$(env_get PORT)"
  CADDY_TMP="$(mktemp)"; trap 'rm -f "${ENV_TMP:-}" "${CADDY_TMP:-}"' EXIT INT TERM
  sed -e "s#__PUBLIC_HOST__#${PUBLIC_HOST_VALUE}#g" -e "s#__PORT__#${PORT_VALUE:-3100}#g"     "$APP_DIR/deploy/oracle/Caddyfile.tmpl" > "$CADDY_TMP"
  if sudo caddy validate --config "$CADDY_TMP" --adapter caddyfile >/dev/null; then
    sudo install -m 644 "$CADDY_TMP" /etc/caddy/Caddyfile
  else
    CADDY_OK=0
    echo "ERRO: o Caddyfile gerado é inválido; mantive o /etc/caddy/Caddyfile anterior e não mexi no Caddy nem no firewall."
  fi
  rm -f "$CADDY_TMP"
fi

if [ -n "$PUBLIC_HOST_VALUE" ] && [ "$CADDY_OK" -eq 1 ]; then
  say "Liberando as portas 80 e 443 no iptables (antes da regra REJECT da imagem Oracle)"
  echo iptables-persistent iptables-persistent/autosave_v4 boolean false | sudo debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean false | sudo debconf-set-selections
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      pos="$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
      if [ -n "$pos" ]; then sudo iptables -I INPUT "$pos" -p tcp --dport "$port" -j ACCEPT
      else sudo iptables -A INPUT -p tcp --dport "$port" -j ACCEPT; fi
    fi
  done
  sudo netfilter-persistent save
  echo "Lembre de liberar 80 e 443 também na Security List da VCN (veja deploy/oracle/README.md)."

  if sudo systemctl is-active --quiet caddy; then sudo systemctl reload caddy; else sudo systemctl enable --now caddy; fi
elif [ -z "$PUBLIC_HOST_VALUE" ]; then
  if command -v caddy >/dev/null 2>&1; then sudo systemctl disable --now caddy >/dev/null 2>&1 || true; fi
  say "PUBLIC_HOST não definido: Caddy e portas 80/443 ficam sem configurar (acesso só por túnel SSH)."
  echo "Para publicar com HTTPS: sudo bash ${APP_DIR}/deploy/oracle/set-env.sh --publico  e rode bash setup.sh de novo."
fi

sudo systemctl restart "$SERVICE"
sleep 2
sudo systemctl --no-pager --lines=5 status "$SERVICE" || true
if [ -n "$PUBLIC_HOST_VALUE" ]; then
  [ "$CADDY_OK" -eq 1 ] || { echo "O cast-jira foi reiniciado, mas o Caddy não foi configurado (PUBLIC_HOST ou Caddyfile inválido; veja o erro acima)."; exit 1; }
  say "Pronto. Crie o primeiro admin: cd ${APP_DIR} && sudo -u ${APP_USER} node src/admin.js bootstrap  (https://${PUBLIC_HOST_VALUE})"
else
  say "Pronto. Crie o primeiro admin: cd ${APP_DIR} && sudo -u ${APP_USER} node src/admin.js bootstrap  (acesso: http://localhost:3100 por túnel)"
fi
