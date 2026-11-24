#!/usr/bin/env bash
# Grava JIRA_EMAIL e JIRA_API_TOKEN no .env do app, sem editor. O token não aparece na tela.
# Uso na VM:  sudo bash /opt/cast-jira-qlik/deploy/oracle/set-env.sh
set -euo pipefail
F="${APP_DIR:-/opt/cast-jira-qlik}/.env"
OWNER="${APP_USER:-castjira}"
[ "$(id -u)" -eq 0 ] || { echo "Rode com sudo."; exit 1; }
[ -f "$F" ] || { echo "Não achei $F (rode o setup.sh antes)."; exit 1; }

read -rp "E-mail do Jira: " E
read -rsp "Token do Jira (cole com o botão direito; não aparece na tela): " T; echo
E="$(printf '%s' "$E" | tr -d '[:space:]')"
T="$(printf '%s' "$T" | tr -d '[:space:]')"
case "$E" in *@*) ;; *) echo "E-mail inválido; nada mudou."; exit 1 ;; esac
[ -n "$T" ] || { echo "Token vazio; nada mudou."; exit 1; }

tmp="$(mktemp)"
E="$E" T="$T" awk 'BEGIN { e = ENVIRON["E"]; t = ENVIRON["T"]; se = 0; st = 0 }
  /^JIRA_EMAIL=/ { print "JIRA_EMAIL=" e; se = 1; next }
  /^JIRA_API_TOKEN=/ { print "JIRA_API_TOKEN=" t; st = 1; next }
  { print }
  END { if (!se) print "JIRA_EMAIL=" e; if (!st) print "JIRA_API_TOKEN=" t }' "$F" > "$tmp"
install -m 600 -o "$OWNER" -g "$OWNER" "$tmp" "$F"
rm -f "$tmp"
echo "Salvo: e-mail $E, token com ${#T} caracteres."
