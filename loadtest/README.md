# ESO Shop: Teste de rotação de segredos sem downtime (JMeter)

Gera carga contínua contra os endpoints do `/k8s-eso` que leem o banco usando o
**secret injetado pelo ESO**, para provar que **nenhuma requisição cai ou degrada**
enquanto o segredo é rotacionado (ESO ressincroniza o `eso-shop-db-creds` e o
operador faz um rolling restart do deployment).

## Por que asserções de conteúdo (e não só HTTP 200)

O Ingress do `/k8s-eso` tem `custom-http-errors: 502,503,504` → `default-backend: maint`.
Ou seja: se um pod cair durante o rollout, o nginx pode **devolver uma página de
manutenção com HTTP 200**. E quase todas as rotas degradam para 200 com um estado de
erro (em vez de 5xx). Por isso cada sampler valida um **marcador no corpo** da resposta:

| Endpoint | Prova | Asserção (contém) |
|---|---|---|
| `GET /k8s-eso/health` | pod/ingress servindo (sem DB) | `"status":"ok"` |
| `GET /k8s-eso/api/dashboard` | DB alcançável via secret (`SELECT 1`) | `"dbConnected":true` |
| `GET /k8s-eso/secrets-info` | query real com a credencial (`SELECT NOW()`) | `data-health="db-ok"` |
| `GET /k8s-eso/products` | página de produtos (query no DB) | contém `data-health="products-rendered"` **e não** contém `data-health="error"` |

Falha de conexão, timeout, página de manutenção ou estado de erro do DB → o sampler
falha. **0,00% de erro durante a janela de rotação = zero downtime comprovado.**

## Instalar o JMeter

```bash
brew install jmeter          # macOS
# ou baixe o binário em https://jmeter.apache.org/download_jmeter.cgi
```

## Rodar (headless, recomendado)

```bash
cd loadtest

jmeter -n -t eso-rotation-test.jmx \
  -Jthreads=20 -Jrampup=10 -Jduration=300 \
  -l eso-rotation-results.jtl \
  -e -o report

# Abra o dashboard HTML gerado:
open report/index.html
```

Parâmetros (todos com default, sobrescreva com `-J`):

| Prop | Default | O quê |
|---|---|---|
| `threads` | `20` | usuários virtuais concorrentes |
| `rampup` | `10` | segundos para subir todas as threads |
| `duration` | `300` | duração total em segundos: **cubra toda a janela de rotação** |
| `thinkms` | `200` | think time base por thread (+0-300ms aleatório) |
| `host` | `demo.minha.cloud` | host alvo |
| `protocol` / `port` | `https` / `443` | |
| `results` | `eso-rotation-results.jtl` | arquivo de resultados |

> Dica: rode com `duration` **maior** que o tempo do rollout. Um rolling restart do
> `eso-shop` (3 réplicas) leva ~30-60s; use `-Jduration=300` e dispare a rotação no meio.

## Disparar a rotação durante o teste

Em **outro terminal**, enquanto o JMeter roda, provoque o cenário:

**A) Simular o rolling restart (pior caso de downtime: ciclagem de pods):**
```bash
kubectl rollout restart deployment/eso-shop -n eso-shop
kubectl rollout status  deployment/eso-shop -n eso-shop
```

**B) Rotação real ponta a ponta (muda o segredo no Conjur → ESO ressincroniza → operador reinicia):**
```bash
# force o ESO a re-sincronizar imediatamente em vez de esperar o refreshInterval (1m)
kubectl annotate externalsecret eso-shop-db-creds -n eso-shop \
  force-sync=$(date +%s) --overwrite
# observe o operador detectar a mudança e reiniciar o deployment
kubectl get pods -n eso-shop -w
```

## Ler o resultado

- **`report/index.html`** → APDEX, % de erro, percentis de latência (p90/p95/p99), throughput.
- O critério de sucesso é **Error % = 0,00** durante toda a duração.
- Qualquer falha aparece com a mensagem da asserção (ex.: *"dbConnected != true: DB
  unreachable with the injected secret (rotation gap)"*) no `.jtl` e no dashboard,
  já dizendo **qual camada** caiu.

Análise rápida do `.jtl` sem abrir o dashboard:
```bash
# total e falhas
awk -F, 'NR>1{t++; if($8=="false")f++} END{printf "amostras=%d  falhas=%d  erro=%.2f%%\n",t,f,(f/t)*100}' eso-rotation-results.jtl
# lista só as falhas (label, código, mensagem)
awk -F, 'NR>1 && $8=="false"{print $1" | "$3" | "$4" | "$5}' eso-rotation-results.jtl | sort | uniq -c
```
(colunas: `timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,...`)

## Rodando no jumpserver (setup já provisionado)

O teste já está instalado e configurado no **jumpserver** (`ssh jumpserver`, user `ubuntu`),
em `~/loadtest/`. Métricas ao vivo vão para um **InfluxDB no cluster EKS** e aparecem no
**Grafana** existente.

### Arquitetura (sem mexer em Security Group / allowlist)

O bastion não alcança o `demo.minha.cloud` (ingress interno/allowlistado) nem o InfluxDB
diretamente: mas tem `kubectl` com acesso ao cluster. Então tudo passa por `kubectl port-forward`:

```
JMeter (bastion)
  ├─ carga  → https://127.0.0.1:8443  --(port-forward)-->  svc/nginx-internal-ingress-controller  → /k8s-eso (ingress real → pods eso-shop)
  └─ métricas → http://127.0.0.1:8086 --(port-forward)-->  svc/influxdb (ns monitoring)
                                                                      ↓
                                              Grafana (in-cluster)  →  dashboard "JMeter: ESO Shop Secret Rotation"
```

O header `Host: demo.minha.cloud` é injetado para o ingress rotear certo; o TLS self-signed
é aceito (`-k` / JMeter não valida host). Isso preserva o caminho completo do nginx,
inclusive a página de manutenção (`custom-http-errors`), então a detecção de queda continua válida.

### Passo a passo

```bash
ssh jumpserver
cd ~/loadtest

# Terminal 1: carga por 5 min com 20 usuários (sobe os port-forwards sozinho):
./run.sh 300 20
#          │    └ threads
#          └ duração (s)

# Terminal 2 (outra sessão SSH): dispare a rotação no meio da janela:
./rotate.sh          # rolling restart do deployment eso-shop
# ou rotação real via Conjur/ESO:
kubectl annotate externalsecret eso-shop-db-creds -n eso-shop force-sync=$(date +%s) --overwrite
```

Ao final, `run.sh` imprime **`RESULTADO: amostras=… falhas=… erro=…%`** e gera o report
HTML em `~/loadtest/report-<timestamp>/index.html`.

### Ver ao vivo no Grafana

**https://demo.minha.cloud/grafana/d/jmeter-eso-rotation**: dashboard "JMeter: ESO Shop
Secret Rotation" (p90/p95/p99, throughput, % de erro, threads ativas), atualizando a cada 5s
durante o teste. Datasource `InfluxDB-JMeter` já provisionado.

### Scripts no bastion (`~/loadtest/`)

| Arquivo | O quê |
|---|---|
| `run.sh [dur] [threads]` | garante os port-forwards, roda o teste, gera report + imprime erro% |
| `rotate.sh` | dispara o rolling restart do `eso-shop` |
| `portforwards.sh` | keeper resiliente dos 2 port-forwards (InfluxDB + ingress) |
| `eso-rotation-test.jmx` | o plano (com Backend Listener InfluxDB) |

> Os port-forwards ficam ativos via `nohup` após o primeiro `run.sh`. Para reiniciá-los:
> `pkill -f port-forward; nohup ~/loadtest/portforwards.sh >/dev/null 2>&1 &`

### Infra provisionada no cluster (namespace `monitoring`)

- `Deployment/influxdb-jmeter` + `Service/influxdb` (InfluxDB 1.8, `emptyDir`, DB `jmeter`)
- `ConfigMap/grafana-datasource-influxdb-jmeter` (label `grafana_datasource: "1"`)
- `ConfigMap/grafana-dashboard-jmeter` (label `grafana_dashboard: "1"`, dashboard uid `jmeter-eso-rotation`)

Para remover tudo: `kubectl delete deploy/influxdb-jmeter svc/influxdb cm/grafana-datasource-influxdb-jmeter cm/grafana-dashboard-jmeter -n monitoring`

## Abrir no modo GUI (para editar/depurar)

```bash
jmeter -t eso-rotation-test.jmx
```
O plano já inclui **Summary Report**, **View Results Tree (só erros)** e o gravador
`.jtl`. Em modo headless (`-n`) os listeners de GUI são ignorados: use `-l` + `-e -o`.

> Os marcadores `data-health` são ganchos estáveis no HTML (não classes de CSS), para o teste não quebrar quando o visual mudar.
