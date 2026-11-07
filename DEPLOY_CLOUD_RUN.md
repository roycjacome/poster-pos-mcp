# Plan de despliegue · poster-rush en Cloud Run

> **Estado: DESPLEGADO 2026-10-16** en `<your-gcp-project>` / `us-central1`.
> URL: `https://<your-service>.run.app` · endpoint MCP: `…/mcp`.
> Secretos creados: 10 `poster-token-*`, `poster-mcp-bearer`, `poster-mcp-oauth-key`, `poster-mcp-owner-pass` (frase: `scripts/crear-frase-dueno.sh`).

## 0. Decisiones de Roy (antes de empezar)

| Decisión | Propuesta |
|---|---|
| Proyecto GCP | `gcloud` en la Mac apunta hoy a `<your-gcp-project>`. ¿Usar ese o uno nuevo (p. ej. `rush-poster-mcp`)? |
| Región | `us-central1` (la misma de los demás servicios) |
| Frase del dueño (`OWNER_PASSPHRASE`) | La elige Roy, ≥ 12 caracteres. Es lo que se teclea al conectar en claude.ai |
| Escritura por defecto | `cafe-04` solamente |

```bash
export PROJECT="${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"   # ← confirmar
export REGION=us-central1
export SA=poster-rush-sa@$PROJECT.iam.gserviceaccount.com
cd "codigo/poster-mcp"
```

## 1. APIs y cuenta de servicio

```bash
gcloud services enable run.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com --project=$PROJECT
gcloud iam service-accounts create poster-rush-sa --display-name="poster-rush MCP" --project=$PROJECT
```

## 2. Tokens Póster → Secret Manager (10 secretos `poster-token-<cuenta>`)

El script lee `poster_accounts` de la DB local y pasa cada token por stdin a `gcloud` (no se imprimen).

```bash
dev db-start erp-core-db
npx tsx scripts/subir-tokens-gsm.mts --project $PROJECT            # simulación: lista qué crearía
npx tsx scripts/subir-tokens-gsm.mts --project $PROJECT --confirm  # crea/actualiza
```

Permiso **solo sobre esos secretos** (no a nivel proyecto):

```bash
for s in $(gcloud secrets list --filter="labels.app=poster-rush" --format="value(name)" --project=$PROJECT); do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor --project=$PROJECT >/dev/null && echo "✓ $s"
done
```

## 3. Secretos de autenticación del MCP

```bash
openssl rand -hex 32 | gcloud secrets create poster-mcp-bearer      --data-file=- --labels=app=poster-rush --project=$PROJECT
openssl rand -hex 32 | gcloud secrets create poster-mcp-oauth-key   --data-file=- --labels=app=poster-rush --project=$PROJECT
read -s -p "Frase del dueño: " F; printf %s "$F" | gcloud secrets create poster-mcp-owner-pass --data-file=- --labels=app=poster-rush --project=$PROJECT; unset F
# repetir el loop de IAM del paso 2 para que la SA lea estos tres
```

## 4. Despliegue (dos pasadas: la segunda fija la URL pública como issuer OAuth)

```bash
gcloud run deploy poster-rush --source . --region $REGION --project $PROJECT \
  --service-account $SA --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --memory 512Mi --cpu 1 --timeout 120 \
  --set-env-vars TOKEN_SOURCE=gsm,GCP_PROJECT_ID=$PROJECT,WRITE_DEFAULT_ACCOUNTS=cafe-04 \
  --set-secrets MCP_BEARER_TOKEN=poster-mcp-bearer:latest,OAUTH_SIGNING_KEY=poster-mcp-oauth-key:latest,OWNER_PASSPHRASE=poster-mcp-owner-pass:latest

URL=$(gcloud run services describe poster-rush --region $REGION --project $PROJECT --format='value(status.url)')
gcloud run services update poster-rush --region $REGION --project $PROJECT --update-env-vars PUBLIC_BASE_URL=$URL
```

`--allow-unauthenticated` es necesario porque claude.ai llega desde internet; la autenticación la hace la app
(OAuth o bearer). Sin token, `/mcp` responde 401.

## 5. Prueba de humo

```bash
curl -s $URL/health                                   # {"ok":true,"tokens":"gsm","oauth":true}
curl -s -o /dev/null -w "%{http_code}\n" -X POST $URL/mcp   # 401
B=$(gcloud secrets versions access latest --secret=poster-mcp-bearer --project=$PROJECT)
curl -s $URL/mcp -H "authorization: Bearer $B" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"menu_snapshot","arguments":{"cuenta":"cafe-04","buscar":"americano"}}}' | head -c 400
```

## 6. Agregar el conector en claude.ai

1. En **claude.ai (web)** → Ajustes → **Conectores** → **Agregar conector personalizado**.
2. Nombre: `poster-rush` · URL: `<URL>/mcp` (sin Client ID/Secret: el servidor hace registro dinámico).
3. **Conectar** → se abre la pantalla "Conectar poster-rush" → teclear la frase del dueño → Autorizar.
4. En el celular (app Claude, misma cuenta) el conector ya aparece; actívalo en el menú de herramientas del chat.
5. Prueba: *"Con poster-rush, dame el menú de cafe-04 que contenga 'latte'"*. Para escribir: Claude debe mostrar el
   dry-run y pedir OK antes de mandar `confirm: true`.

La sesión dura 30 días (refresh); luego claude.ai pide reconectar.

## 7. Operación

- **Auditoría**: Cloud Logging → `resource.type="cloud_run_revision" resource.labels.service_name="poster-rush" jsonPayload.audit=true`.
  (`auditoria_reciente` solo ve la instancia viva: `/tmp` en Cloud Run es efímero.)
- **Revocar todo acceso**: `openssl rand -hex 32 | gcloud secrets versions add poster-mcp-oauth-key --data-file=-` y redeploy.
- **Rotar un token Póster**: actualizar `poster_accounts` y correr el script del paso 2 con `--confirm` (agrega versión; caché 10 min).
- **Habilitar escritura por defecto en otra cuenta**: solo con decisión de Roy → `--update-env-vars WRITE_DEFAULT_ACCOUNTS=cafe-04,<cuenta>`.
- Costo esperado: ~$0 con `min-instances 0` (pocas peticiones al día) + centavos de Secret Manager.
