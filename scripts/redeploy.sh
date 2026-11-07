#!/usr/bin/env bash
# Redespliega poster-rush en Cloud Run conservando env vars, secretos y cuenta de servicio de la revisión actual.
# Uso: bash scripts/redeploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
REGION=us-central1
echo "▶ Tests"; npx tsc -p tsconfig.json --noEmit && npx vitest run test/unit.test.ts test/altas.test.ts test/transacciones.test.ts test/compras-pago.test.ts test/http.test.ts
echo "▶ Deploy"; gcloud run deploy poster-rush --source . --region $REGION --project $PROJECT --quiet
URL=$(gcloud run services describe poster-rush --region $REGION --project $PROJECT --format='value(status.url)')
echo "▶ Health"; curl -s "$URL/health"; echo
B=$(gcloud secrets versions access latest --secret=poster-mcp-bearer --project=$PROJECT)
echo "▶ Herramientas nuevas en tools/list:"
curl -s "$URL/mcp" -H "authorization: Bearer $B" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"\(crear_categoria\|crear_precocinado\|crear_platillo\|ocultar_platillo\|borrar_platillo_old\|actualizar_receta_platillo\|crear_transaccion\|asignar_pago_compra\)"' | sort -u
echo "✓ LISTO"
