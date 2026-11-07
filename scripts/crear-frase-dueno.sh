#!/bin/bash
# Pide la frase del dueño sin mostrarla y la guarda en Secret Manager (poster-mcp-owner-pass).
set -euo pipefail
P=${1:-<your-gcp-project>}
SA=poster-rush-sa@$P.iam.gserviceaccount.com
read -r -s -p "Frase del dueño (mín. 12 caracteres): " F; echo
read -r -s -p "Repítela: " F2; echo
[ "$F" = "$F2" ] || { echo "✗ No coinciden"; exit 1; }
[ ${#F} -ge 12 ] || { echo "✗ Muy corta"; exit 1; }
if gcloud secrets describe poster-mcp-owner-pass --project="$P" >/dev/null 2>&1; then
  printf %s "$F" | gcloud secrets versions add poster-mcp-owner-pass --data-file=- --project="$P" >/dev/null
else
  printf %s "$F" | gcloud secrets create poster-mcp-owner-pass --data-file=- --labels=app=poster-rush --project="$P" >/dev/null
fi
unset F F2
gcloud secrets add-iam-policy-binding poster-mcp-owner-pass --member=serviceAccount:"$SA" --role=roles/secretmanager.secretAccessor --project="$P" >/dev/null
echo "✓ Frase guardada en poster-mcp-owner-pass"
