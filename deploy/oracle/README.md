# Rodar no Oracle Cloud (Always Free)

Com o app numa VM, o agendador de apontamentos automáticos roda 24 horas, sem depender do seu PC ligado.

**Como fica:**
- A VM é Ubuntu 24.04 e o app roda como serviço `systemd` (`cast-jira`), reiniciando sozinho em caso de queda ou reboot.
- O app escuta só em `127.0.0.1:3100`. Quem fica exposto na internet é o **Caddy** (portas 80/443, HTTPS automático), que repassa para o app.
- Cada colega entra com o próprio login e cadastra o próprio token do Jira. O Claude (claude.ai) acessa as ferramentas pelo conector MCP em `https://<host>/mcp`.
- Sem `PUBLIC_HOST` no `.env`, nada é publicado: o acesso é só por túnel SSH (seção 5).

Os comandos de PC abaixo são para o **PowerShell do Windows**. Os comandos de VM rodam na sessão SSH.

## 1. Criar a VM (uma vez)

1. No console da Oracle Cloud, vá em **Compute → Instances → Create instance**.
2. **Name:** `cast-jira`.
3. **Image and shape:**
   - **Image:** clique em *Change image* e escolha **Canonical Ubuntu 24.04**.
   - **Shape:** clique em *Change shape* e escolha um dos dois:
     - **VM.Standard.E2.1.Micro** (AMD, 1 GB), marcado "Always Free-eligible". Basta para este app, e o `setup.sh` cria swap.
     - **VM.Standard.A1.Flex** (Ampere, por exemplo 1 OCPU e 6 GB). Também é Always Free, mas às vezes não há capacidade na região. Se der erro de capacidade, use a E2.1.Micro.
4. **Networking:** deixe criar a VCN padrão, com **Assign a public IPv4 address** marcado. As portas 80 e 443 são liberadas depois (seção 7); a 22 (SSH) já vem liberada.
5. **SSH keys:** escolha *Paste public keys*. Gere a chave no seu PC:
   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_cast -C cast-jira
   Get-Content $HOME\.ssh\oracle_cast.pub
   ```
   Cole o conteúdo do `.pub` no campo. A chave privada (`oracle_cast`, sem `.pub`) não sai do seu PC.

   O SSH do Windows recusa chaves que outros usuários conseguem ler (aviso "UNPROTECTED PRIVATE KEY FILE"). Se aparecer esse aviso, deixe a chave só com o seu usuário:
   ```powershell
   icacls $HOME\.ssh\oracle_cast /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(R,W)"
   ```
   Use um PowerShell aberto normalmente, não "como administrador".
6. Clique em **Create**. Quando a instância ficar *Running*, anote o **Public IP address**. Nos comandos abaixo, ele aparece como `IP_DA_VM`.

## 2. Instalar o app na VM

No PC:
```powershell
ssh -i $HOME\.ssh\oracle_cast ubuntu@IP_DA_VM
```

Já na VM:
```bash
curl -fsSL https://raw.githubusercontent.com/wesleysouzapmp/cast-jira-qlik/main/deploy/oracle/setup.sh -o setup.sh
bash setup.sh
```

O script faz o seguinte:
- instala o Node.js 24;
- cria o usuário `castjira`;
- baixa o código em `/opt/cast-jira-qlik` e instala as dependências;
- gera a `APP_SECRET_KEY` no `.env` e cria a pasta de dados `/opt/cast-jira-qlik/data` (permissão 700);
- instala o `sqlite3` e o Caddy, e cria o serviço `cast-jira`;
- liga o backup diário e, se `DUCKDNS_DOMAIN` e `DUCKDNS_TOKEN` estiverem no `.env`, a atualização do DuckDNS a cada 5 minutos;
- se `PUBLIC_HOST` estiver no `.env`: grava o `/etc/caddy/Caddyfile`, abre as portas 80/443 no `iptables` da VM e recarrega o Caddy.

Rodar de novo é seguro: atualiza o código e preserva `.env` e dados.

## 3. Primeiro acesso: criar o admin

Com o app instalado, crie o primeiro administrador (o comando roda como `castjira`, dono dos dados):
```bash
cd /opt/cast-jira-qlik
sudo -u castjira node src/admin.js bootstrap --email voce@exemplo.com --nome "Seu Nome"
```
Ele imprime um link de convite de uso único: abra-o no navegador para definir a senha. Depois, em **Minha conta**, cadastre o seu token do Jira (gere em <https://id.atlassian.com/manage-profile/security/api-tokens>).

Outros campos do `.env`, como a chave Anthropic: `sudo nano /opt/cast-jira-qlik/.env` (Ctrl+O e Enter para salvar, Ctrl+X para sair). Depois, `sudo systemctl restart cast-jira`.

### Migrar da versão de um usuário (VM que já existia)

1. Atualize **baixando o script de novo** (o `setup.sh` que ficou na VM é da versão antiga e não gera a `APP_SECRET_KEY`; rodá-lo puxaria o código novo e o serviço não subiria): `curl -fsSL https://raw.githubusercontent.com/wesleysouzapmp/cast-jira-qlik/main/deploy/oracle/setup.sh -o setup.sh && bash setup.sh` (para testar outra branch: `BRANCH=nome bash setup.sh`). Ele gera a `APP_SECRET_KEY` e cria a pasta `data/`. Os `agendamentos*.json` e `favoritos.json` continuam onde estão.
2. **Logo em seguida**, rode o `bootstrap` (comando acima). Ele lê `JIRA_EMAIL` e `JIRA_API_TOKEN` do `.env`, cria o admin com esse token e importa `agendamentos.json`, `agendamentos-log.json` e `favoritos.json`. Faça isso logo após atualizar: assim o agendador diário continua rodando para você, com os mesmos dados. Rodar de novo não duplica nada.
3. Confirme que está tudo certo e **apague** `JIRA_EMAIL` e `JIRA_API_TOKEN` do `.env` (`sudo nano /opt/cast-jira-qlik/.env`): o servidor não usa mais essas variáveis.

Numa VM nova, para levar os arquivos antigos do PC, envie-os antes do `bootstrap`:
```powershell
cd C:\_app\cast-jira-qlik
scp -i $HOME\.ssh\oracle_cast agendamentos.json agendamentos-log.json favoritos.json ubuntu@IP_DA_VM:/tmp/
```
```bash
for f in agendamentos.json agendamentos-log.json favoritos.json; do
  [ -f /tmp/$f ] && sudo install -m 600 -o castjira -g castjira /tmp/$f /opt/cast-jira-qlik/$f && rm /tmp/$f
done
```
Para o `bootstrap` usar o seu token do `.env`, grave-o sem editor: `sudo bash /opt/cast-jira-qlik/deploy/oracle/set-env.sh` (pergunta e-mail e token; o token não aparece na tela).

## 4. Desligar o agendador do seu PC

O app da VM e o do PC não podem gravar ao mesmo tempo. O app evita duplicar, mas os dois correndo juntos podem esbarrar. Escolha uma das opções no PC:
- **Não rodar mais o app local.** É o recomendado.
- **Rodar o app local só para consultas.** Coloque `AUTO_WORKLOG=off` no `.env` do PC.

## 5. Abrir a tela pelo túnel (alternativa sem HTTPS público)

No PC, deixe esta janela aberta enquanto usa o app:
```powershell
ssh -i $HOME\.ssh\oracle_cast -N -L 3100:localhost:3100 ubuntu@IP_DA_VM
```

Depois abra <http://localhost:3100> no navegador. Se o app local também estiver rodando na 3100, troque o primeiro número do túnel: `-L 3200:localhost:3100` e abra `http://localhost:3200`.

Para não repetir os parâmetros, crie um atalho no arquivo `$HOME\.ssh\config`:
```
Host cast-jira
  HostName IP_DA_VM
  User ubuntu
  IdentityFile ~/.ssh/oracle_cast
  LocalForward 3100 localhost:3100
```
Com ele, `ssh cast-jira` entra na VM e abre o túnel, e `ssh -N cast-jira` só abre o túnel.

## 6. Domínio grátis no DuckDNS

1. Entre em <https://www.duckdns.org> (login com Google, GitHub etc.).
2. Em **domains**, escolha um nome (por exemplo `cast-tjmg`) e clique em **add domain**. O endereço fica `cast-tjmg.duckdns.org`.
3. No campo **current ip** do domínio, coloque o IP público da VM e clique em **update ip** (o timer da VM mantém isso atualizado depois).
4. Copie o **token** que aparece no topo da página. Ele não deve ir para o Git nem para conversas.

Na VM, grave os valores sem editor (o token não aparece na tela):
```bash
sudo bash /opt/cast-jira-qlik/deploy/oracle/set-env.sh --publico
```
Informe o host (`cast-tjmg.duckdns.org`), o subdomínio (`cast-tjmg`) e o token. Se preferir domínio próprio, deixe o subdomínio em branco e aponte um registro `A` para o IP da VM.

## 7. Abrir as portas 80 e 443

O `setup.sh` já abre as duas no firewall da própria VM. Falta a **Security List** da VCN (firewall da Oracle). Pelo console: **Networking → Virtual cloud networks → sua VCN → Security Lists → Default → Add Ingress Rules**, origem `0.0.0.0/0`, protocolo TCP, portas `80` e `443`.

Pela linha de comando (OCI CLI), o `--ingress-security-rules` **substitui a lista inteira**. Por isso a regra do SSH (porta 22) precisa ir junto. Substitua o OCID da security list:
```bash
oci network security-list update --security-list-id ocid1.securitylist.oc1..XXXX --force --ingress-security-rules '[
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
  {"protocol":"6","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
  {"protocol":"1","source":"0.0.0.0/0","icmpOptions":{"type":3,"code":4}},
  {"protocol":"1","source":"10.0.0.0/16","icmpOptions":{"type":3}}
]'
```
Antes, veja as regras atuais (`oci network security-list get --security-list-id ...`) e inclua qualquer outra que exista (as duas regras ICMP acima são as padrão da VCN; ajuste `10.0.0.0/16` se a sua rede for outra). Rode esse comando no **OCI Cloud Shell** ou no **Git Bash**: o PowerShell 5.1 estraga as aspas do JSON.

Com tudo pronto, rode `bash setup.sh` de novo na VM (aplica `PUBLIC_HOST`: Caddy, portas e timer do DuckDNS) e teste:
```bash
curl -I https://SEU_HOST/                   # deve responder por HTTPS, com o cabeçalho strict-transport-security
sudo journalctl -u caddy -n 30 --no-pager   # certificado emitido pelo Let's Encrypt
```
O Let's Encrypt precisa alcançar a porta 80 da VM para emitir o certificado.

## 8. Convidar colegas

Na VM:
```bash
cd /opt/cast-jira-qlik
sudo -u castjira node src/admin.js invite          # colega comum
sudo -u castjira node src/admin.js invite --admin  # administrador
```
Envie o link impresso (uso único) para a pessoa. Ela define a senha e cadastra o próprio token do Jira em **Minha conta**.

## 9. Conector no claude.ai

Cada pessoa, no claude.ai: **Configurações → Conectores → Adicionar conector personalizado** e informe a URL `https://SEU_HOST/mcp`. Na primeira vez, o claude.ai abre a tela de login do app para autorizar o acesso.

## Dia a dia

| Para | Comando na VM |
| --- | --- |
| Ver se está rodando | `systemctl status cast-jira` |
| Acompanhar o log | `sudo journalctl -u cast-jira -f` |
| Reiniciar | `sudo systemctl restart cast-jira` |
| Criar convite | `cd /opt/cast-jira-qlik && sudo -u castjira node src/admin.js invite` |
| Atualizar para a última versão do GitHub | `curl -fsSL https://raw.githubusercontent.com/wesleysouzapmp/cast-jira-qlik/main/deploy/oracle/setup.sh -o setup.sh && bash setup.sh` (baixa o script atual, faz `git pull`, `npm ci` e reinicia; o `.env` e os dados são preservados; `BRANCH=nome bash setup.sh` para testar uma branch) |
| Editar feriados | `sudo -u castjira nano /opt/cast-jira-qlik/feriados.json` (relido a cada consulta) |

## Cuidados

- **Instância ociosa.** A Oracle pode recuperar instâncias Always Free ociosas: uso de CPU, rede e memória muito baixo por 7 dias seguidos. Este app usa muito pouco. Para não correr esse risco, converta a conta para *Pay As You Go*. Os recursos Always Free continuam gratuitos, mas confira os limites antes, para não gerar cobrança.
- **Acesso ao Jira a partir da nuvem.** Se o Jira do TJMG restringir o acesso por IP, as chamadas da VM falham com 401 ou 403, mesmo com o token certo. O log mostra o erro. Nesse caso, é preciso pedir a liberação do IP público da VM.
- **Segurança.**
  - O `.env` fica com permissão `600` e a pasta `data/` com `700`, legíveis só pelo usuário `castjira`.
  - O serviço só consegue gravar na pasta do app (inclui `data/`).
  - Não abra a porta 3100 na *Security List*: só 80 e 443, que passam pelo Caddy. O app tem login por usuário e senha.
  - Tokens do Jira e chaves Anthropic ficam cifrados no banco com a `APP_SECRET_KEY`.
- **`AUTO_WORKLOG`.** O agendador de apontamentos automáticos vem ligado. Para desligá-lo (por exemplo, enquanto o app do PC ainda roda), coloque `AUTO_WORKLOG=off` no `.env` e reinicie o serviço.
- **Backup e restauração.**
  - Todo dia o timer `cast-jira-backup` grava `/var/backups/cast-jira/app-AAAA-MM-DD.db` e mantém as 7 mais recentes. Veja com `systemctl list-timers cast-jira-backup.timer`.
  - **Guarde também uma cópia do `.env`**: a `APP_SECRET_KEY` fica nele, e sem a chave os tokens cifrados do backup não podem ser lidos. Guarde os dois juntos, num lugar seguro (`sudo cat /opt/cast-jira-qlik/.env`, num cofre de senhas).
  - A pasta de backup é do `castjira`. Para levar os arquivos ao PC, copie antes: `sudo cp /var/backups/cast-jira/app-*.db /tmp/ && sudo chown ubuntu /tmp/app-*.db`, e no PC `scp -i $HOME\.ssh\oracle_cast ubuntu@IP_DA_VM:/tmp/app-*.db .`. Depois apague as cópias da VM: `sudo rm /tmp/app-*.db`.
  - Restaurar: `sudo systemctl stop cast-jira`; `sudo -u castjira cp /var/backups/cast-jira/app-AAAA-MM-DD.db /opt/cast-jira-qlik/data/app.db`; apague `app.db-wal` e `app.db-shm` da pasta `data/` se existirem; `sudo systemctl start cast-jira`. O `.env` precisa ter a mesma `APP_SECRET_KEY` de quando o backup foi feito.
