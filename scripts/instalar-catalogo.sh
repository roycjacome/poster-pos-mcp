#!/usr/bin/env bash
# Instala las herramientas de catálogo (actualizar_producto, crear_producto, renombrar_platillo,
# renombrar_insumo) ENCIMA de la copia local del MCP y redespliega.
# No sobrescribe escritura.ts ni mcp.ts: agrega src/tools/catalogo.ts y dos líneas de registro en mcp.ts.
# Uso: bash instalar-catalogo.sh ["/ruta/a/codigo/poster-mcp"]
set -euo pipefail
DIR="${1:-$HOME/Documents/Claude/Projects/dashboard ceroyuno proyectos/codigo/poster-mcp}"
RAW="https://raw.githubusercontent.com/roycjacome/poster-pos-mcp/feat/catalogo-productos-reventa"
export GCP_PROJECT_ID="${GCP_PROJECT_ID:-finanzas-pro-local-rush-app}"
cd "$DIR"
echo "▶ Carpeta: $PWD"
[ -f src/mcp.ts ] && [ -d src/tools ] || { echo "✗ Aquí no está el MCP (falta src/mcp.ts)"; exit 1; }

echo "▶ Descargando módulo de catálogo"
curl -fsSL "$RAW/src/tools/catalogo.ts" -o src/tools/catalogo.ts
curl -fsSL "$RAW/test/catalogo.test.ts" -o test/catalogo.test.ts

if ! grep -q 'registrarCatalogo' src/mcp.ts; then
  echo "▶ Registrando herramientas en src/mcp.ts (respaldo en src/mcp.ts.bak)"
  cp src/mcp.ts src/mcp.ts.bak
  perl -0pi -e 's/(import \* as W from "\.\/tools\/escritura\.js";)/$1\nimport { registrarCatalogo } from ".\/tools\/catalogo.js";/' src/mcp.ts
  perl -0pi -e 's/\n  return s;\n\}\s*\z/\n  registrarCatalogo(s, api);\n  return s;\n}\n/' src/mcp.ts
fi
grep -q 'import { registrarCatalogo }' src/mcp.ts && grep -q 'registrarCatalogo(s, api)' src/mcp.ts \
  || { echo "✗ No pude enganchar el registro en src/mcp.ts; restaura con: mv src/mcp.ts.bak src/mcp.ts"; exit 1; }

echo "▶ Typecheck y tests del módulo"
npx tsc -p tsconfig.json --noEmit
npx vitest run test/catalogo.test.ts

echo "▶ Redespliegue"
bash scripts/redeploy.sh

URL=$(gcloud run services describe poster-rush --region us-central1 --project "$GCP_PROJECT_ID" --format='value(status.url)')
B=$(gcloud secrets versions access latest --secret=poster-mcp-bearer --project="$GCP_PROJECT_ID")
echo "▶ Herramientas de catálogo en producción:"
curl -s "$URL/mcp" -H "authorization: Bearer $B" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | grep -o '"name":"\(actualizar_producto\|crear_producto\|renombrar_platillo\|renombrar_insumo\)"' | sort -u
echo "✓ LISTO. Ahora desconecta y reconecta el conector poster-rush en claude.ai."
