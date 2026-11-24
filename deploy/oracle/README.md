# Rodar no Oracle Cloud (Always Free)

Com o app numa VM, o agendador de apontamentos automáticos roda 24 horas, sem depender do seu PC ligado.

**Como fica:**
- A VM é Ubuntu 24.04 e o app roda como serviço `systemd` (`cast-jira`), reiniciando sozinho em caso de queda ou reboot.
- O app escuta só em `127.0.0.1:3100` dentro da VM. **Nenhuma porta é aberta na internet.**
- Você acessa a tela por um **túnel SSH**: o navegador do seu PC abre `http://localhost:3100`, e o túnel leva até a VM.

Os comandos de PC abaixo são para o **PowerShell do Windows**. Os comandos de VM rodam na sessão SSH.

## 1. Criar a VM (uma vez)

1. No console da Oracle Cloud, vá em **Compute → Instances → Create instance**.
2. **Name:** `cast-jira`.
3. **Image and shape:**
   - **Image:** clique em *Change image* e escolha **Canonical Ubuntu 24.04**.
   - **Shape:** clique em *Change shape* e escolha um dos dois:
     - **VM.Standard.E2.1.Micro** (AMD, 1 GB), marcado "Always Free-eligible". Basta para este app, e o `setup.sh` cria swap.
     - **VM.Standard.A1.Flex** (Ampere, por exemplo 1 OCPU e 6 GB). Também é Always Free, mas às vezes não há capacidade na região. Se der erro de capacidade, use a E2.1.Micro.
4. **Networking:** deixe criar a VCN padrão, com **Assign a public IPv4 address** marcado. Não adicione regras de entrada: a porta 22 (SSH) já vem liberada e é a única necessária.
5. **SSH keys:** escolha *Paste public keys*. Gere a chave no seu PC:
   ```powershell
   ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_cast -C cast-jira
   Get-Content $HOME\.ssh\oracle_cast.pub
   ```
   Cole o conteúdo do `.pub` no campo. A chave privada (`oracle_cast`, sem `.pub`) não sai do seu PC.
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
- cria o serviço `cast-jira`.

Na primeira vez, ele termina pedindo o `.env`.

## 3. Configurar o `.env` e levar os seus dados

**Use um token do Jira novo.** O token antigo apareceu em conversa e deve ser revogado. Gere outro em <https://id.atlassian.com/manage-profile/security/api-tokens>.

Na VM, edite o arquivo e preencha `JIRA_EMAIL` e `JIRA_API_TOKEN` (e `ANTHROPIC_API_KEY`, se usar a IA):
```bash
sudo nano /opt/cast-jira-qlik/.env
```

Para levar as regras, o histórico e os favoritos que você já tem, envie os arquivos a partir do PC, na pasta do projeto:
```powershell
cd C:\_app\cast-jira-qlik
scp -i $HOME\.ssh\oracle_cast agendamentos.json agendamentos-log.json favoritos.json ubuntu@IP_DA_VM:/tmp/
```

Na VM, mova os arquivos para a pasta do app e reinicie:
```bash
for f in agendamentos.json agendamentos-log.json favoritos.json; do
  [ -f /tmp/$f ] && sudo install -m 600 -o castjira -g castjira /tmp/$f /opt/cast-jira-qlik/$f && rm /tmp/$f
done
sudo systemctl restart cast-jira
sudo journalctl -u cast-jira -n 20 --no-pager
```

O log deve mostrar `Jira API Tester em http://localhost:3100`. Logo depois, aparecem as linhas `[agendamentos]` se houver algo pendente.

## 4. Desligar o agendador do seu PC

O app da VM e o do PC não podem gravar ao mesmo tempo. O app evita duplicar, mas os dois correndo juntos podem esbarrar. Escolha uma das opções no PC:
- **Não rodar mais o app local.** É o recomendado.
- **Rodar o app local só para consultas.** Coloque `AUTO_WORKLOG=off` no `.env` do PC.

## 5. Abrir a tela pelo túnel

No PC, deixe esta janela aberta enquanto usa o app:
```powershell
ssh -i $HOME\.ssh\oracle_cast -N -L 3100:localhost:3100 ubuntu@IP_DA_VM
```

Depois abra <http://localhost:3100/apontar.html> no navegador. Se o app local também estiver rodando na 3100, troque o primeiro número do túnel: `-L 3200:localhost:3100` e abra `http://localhost:3200`.

Para não repetir os parâmetros, crie um atalho no arquivo `$HOME\.ssh\config`:
```
Host cast-jira
  HostName IP_DA_VM
  User ubuntu
  IdentityFile ~/.ssh/oracle_cast
  LocalForward 3100 localhost:3100
```
Com ele, `ssh cast-jira` entra na VM e abre o túnel, e `ssh -N cast-jira` só abre o túnel.

## Dia a dia

| Para | Comando na VM |
| --- | --- |
| Ver se está rodando | `systemctl status cast-jira` |
| Acompanhar o log | `sudo journalctl -u cast-jira -f` |
| Reiniciar | `sudo systemctl restart cast-jira` |
| Atualizar para a última versão do GitHub | `bash setup.sh` (o mesmo script: faz `git pull`, `npm ci` e reinicia; o `.env` e os dados são preservados) |
| Editar feriados | `sudo -u castjira nano /opt/cast-jira-qlik/feriados.json` (relido a cada consulta) |

## Cuidados

- **Instância ociosa.** A Oracle pode recuperar instâncias Always Free ociosas: uso de CPU, rede e memória muito baixo por 7 dias seguidos. Este app usa muito pouco. Para não correr esse risco, converta a conta para *Pay As You Go*. Os recursos Always Free continuam gratuitos, mas confira os limites antes, para não gerar cobrança.
- **Acesso ao Jira a partir da nuvem.** Se o Jira do TJMG restringir o acesso por IP, as chamadas da VM falham com 401 ou 403, mesmo com o token certo. O log mostra o erro. Nesse caso, é preciso pedir a liberação do IP público da VM.
- **Segurança.**
  - O `.env` fica com permissão `600`, legível só pelo usuário `castjira`.
  - O serviço só consegue gravar na pasta do app.
  - Não abra a porta 3100 na *Security List* da VCN. O app não tem login.
- **Backup.** Os seus dados são `agendamentos.json`, `agendamentos-log.json` e `favoritos.json`, na pasta do app. Para copiá-los para o PC:
  ```powershell
  scp -i $HOME\.ssh\oracle_cast ubuntu@IP_DA_VM:/opt/cast-jira-qlik/agendamentos*.json .
  ```
