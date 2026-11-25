#!/usr/bin/env bash
# Grava valores no .env do app, sem editor. Tokens não aparecem na tela.
# Uso na VM:
#   sudo bash /opt/cast-jira-qlik/deploy/oracle/set-env.sh            # JIRA_EMAIL e JIRA_API_TOKEN (só para o bootstrap da migração)
#   sudo bash /opt/cast-jira-qlik/deploy/oracle/set-env.sh --publico  # PUBLIC_HOST, DUCKDNS_DOMAIN e DUCKDNS_TOKEN
set -euo pipefail
F="${APP_DIR:-/opt/cast-jira-qlik}/.env"
OWNER="${APP_USER:-castjira}"
[ "$(id -u)" -eq 0 ] || { echo "Rode com sudo."; exit 1; }
[ -f "$F" ] || { echo "Não achei $F (rode o setup.sh antes)."; exit 1; }

# upsert CHAVE=valor no .env (valor via ambiente, nunca na linha de comando)
upsert() {
  ENV_TMP="$(mktemp)"; trap 'rm -f "${ENV_TMP:-}"' EXIT INT TERM
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; d = 0 }
    index($0, k "=") == 1 { if (!d) print k "=" v; d = 1; next }
    { print }
    END { if (!d) print k "=" v }' "$F" > "$ENV_TMP"
  install -m 600 -o "$OWNER" -g "$OWNER" "$ENV_TMP" "$F"
  rm -f "$ENV_TMP"
}

if [ "${1:-}" = "--publico" ]; then
  read -rp "Host público (ex.: meu-app.duckdns.org; vazio = não mudar): " H
  read -rp "Subdomínio do DuckDNS (só o nome, ex.: meu-app; vazio = não usar DuckDNS): " D
  T=""
  [ -z "$D" ] || read -rsp "Token do DuckDNS (não aparece na tela): " T; echo
  H="$(printf '%s' "$H" | tr -d '[:space:]')"
  D="$(printf '%s' "$D" | tr -d '[:space:]')"
  T="$(printf '%s' "$T" | tr -d '[:space:]')"
  if [ -n "$H" ]; then
    case "$H" in *[!A-Za-z0-9.-]*|.*|*.) echo "Host inválido; nada mudou."; exit 1 ;; esac
    upsert PUBLIC_HOST "$H"; echo "PUBLIC_HOST=$H"
  fi
  if [ -n "$D" ]; then
    [ -n "$T" ] || { echo "Token vazio; DuckDNS não alterado."; exit 1; }
    case "$D" in *[!A-Za-z0-9-]*) echo "Subdomínio inválido (use só o nome, sem .duckdns.org); DuckDNS não alterado."; exit 1 ;; esac
    upsert DUCKDNS_DOMAIN "$D"; upsert DUCKDNS_TOKEN "$T"
    echo "DuckDNS: domínio $D, token com ${#T} caracteres."
  fi
  echo "Rode 'bash setup.sh' para aplicar (Caddy, portas e timer do DuckDNS)."
  exit 0
fi

read -rp "E-mail do Jira: " E
read -rsp "Token do Jira (cole com o botão direito; não aparece na tela): " T; echo
E="$(printf '%s' "$E" | tr -d '[:space:]')"
T="$(printf '%s' "$T" | tr -d '[:space:]')"
case "$E" in *@*) ;; *) echo "E-mail inválido; nada mudou."; exit 1 ;; esac
[ -n "$T" ] || { echo "Token vazio; nada mudou."; exit 1; }

upsert JIRA_EMAIL "$E"
upsert JIRA_API_TOKEN "$T"
echo "Salvo: e-mail $E, token com ${#T} caracteres."
