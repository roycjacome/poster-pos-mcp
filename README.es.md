# poster-rush · MCP remoto para Póster POS (red RUSH)

Servidor MCP (TypeScript + Hono, transporte **Streamable HTTP** sin estado) para que Roy lea y configure
las 10 cuentas Póster de la red RUSH desde claude.ai (también en el celular), sin la Mac encendida.

- Local: `dev start poster-mcp` → `http://localhost:3210` (bloque de puertos **3210–3219**; el 3200 ya lo usa academy)
- Producción: Cloud Run, tokens en Google Secret Manager → ver [DEPLOY_CLOUD_RUN.md](DEPLOY_CLOUD_RUN.md)

## Reglas que el servidor hace cumplir

| Regla | Cómo |
|---|---|
| Solo las 10 cuentas de la lista blanca | `CUENTAS` en `src/config.ts`; cualquier otra se rechaza, también en lectura |
| Escritura solo en cafe-04 por defecto | `WRITE_DEFAULT_ACCOUNTS=cafe-04`. Otra cuenta exige `permitir_otra_cuenta: true` **en esa llamada** (y la autorización de Roy) |
| Dry-run por defecto | toda escritura con `confirm: false` devuelve `cambios` (diff), `avisos` y el `payload` exacto, sin tocar Póster |
| Aplicar = `confirm: true` | escribe una sola vez (sin reintentos, para no duplicar) y **lee de vuelta** para verificar |
| Auditoría | cada dry-run/aplicación/rechazo: quién, cuándo, cuenta, método, payload sin token, resultado (stdout → Cloud Logging + JSONL en `AUDIT_DIR`) |
| Tokens nunca visibles | se leen de GSM (prod) o `poster_accounts` (dev); se redactan de errores y auditoría; no hay herramienta que los devuelva |
| Fuera de carta = ocultar | `actualizar_platillo` con `visible: false`; no existe herramienta de borrado |

## Herramientas

**Lectura** (cualquier cuenta de la lista): `listar_cuentas`, `menu_snapshot`, `producto_detalle`, `insumos`,
`precocinados`, `grupos_clientes`, `promociones` (vigentes = `date_end ≥ hoy` o `0000-00-00`), `empleados`
(con puestos y secciones de acceso), `metodos_pago`, `ajustes` (`settings.getAllSettings`), `compras`,
`compra_detalle`, `saldos`, `catalogos_base` (IDs de almacenes/proveedores/categorías para escribir),
`poster_get` (cualquier `<modulo>.get*` crudo), `auditoria_reciente`.

**Escritura** (dry-run por defecto): `crear_grupo_cliente`, `actualizar_grupo_cliente`, `crear_insumo`,
`crear_compra`, `actualizar_platillo` (updateDish), `actualizar_categoria` (updateCategory),
`actualizar_precocinado` (updatePrepack), `crear_categoria` (createCategory), `crear_precocinado` (createPrepack),
`crear_platillo` (createDish con receta y grupos; relee y verifica), `ocultar_platillo` (getProduct + updateDish COMPLETO con receta, visible 0 y sufijo " (old)"),
`crear_transaccion` (finance.createTransactions: `type` 0 gasto / 1 ingreso / 2 transferencia es OBLIGATORIO; la categoría va como `category` (id, no `category_id`); **el monto se envía en PESOS** —finance.createTransactions NO usa centavos, al revés que el resto de la API—; valida `account_id` y `category` contra `finance.getAccounts`/`getCategories` y tras aplicar relee `finance.getTransactions` avisando si el monto quedó 100× desviado),
`crear_compra` ahora acepta `account_id` opcional (paga al momento; sin él la compra queda a crédito),
`asignar_pago_compra` (storage.updateSupply: el botón "pagar" por API — asigna/reasigna la cuenta de Finanzas de una compra a crédito; relee y verifica que el total y los renglones no cambiaron).

**Solo panel web**: editar la receta de un platillo existente (actualizar_platillo rechaza platillos con receta) y permisos de puestos.

## Contratos de Póster (aprendidos en la migración de la 47)

API: `https://<cuenta>.joinposter.com/api/<metodo>?token=…`. Escrituras con cuerpo JSON salvo `createSupply` (multipart).

**Menú / platillos**
- `menu.updateDish` es update **COMPLETO**: hay que reenviar nombre, categoría, workshop, color, `price`, `visible`,
  `modificationgroup` y `"ingredient[]": []`. Omitir `price`/`"ingredient[]"` da `Bad price value` / `Bad ingredient value`.
- **updateDish BORRA la receta** del platillo (la API descarta recetas de platillos en silencio). Guarda:
  *si el platillo tiene `ingredients` → no se toca* (`actualizar_platillo` lo rechaza y manda al panel).
- `price` y `visible` son mapas por spot: `{"1": 2500}`, `{"1": 1}`. El precio del **platillo** se lee y escribe en **centavos**.
- Precio de **opción** de modificador: se **escribe en centavos** (2000) y se **lee en pesos** (20).
- Visibilidad en terminal = `spots[].visible`. El `hidden` de `getProducts` es otro flag: no derivar `visible` de `hidden`.
- Opciones: `{name, ingredientId, ingredient_id, type, brutto, price, sort_order}`; `type` 2 = platillo, 1/10 = insumo.
- **Póster no anida**: un platillo con grupos propios no puede ser opción tipo 2 de otro (`Bad <id> value`).
- `menu.getProduct {product_id}` sí responde (probado 23 oct 2026) con receta y grupos; las altas lo usan y caen a `menu.getProducts` si falla.
- `createDish`/`updateDish` aceptan `ingredient:[{id,type,brutto,netto,lock}]`: con eso la receta se conserva al ocultar.
- `menu.updateCategory {category_id, category_name, parent_category}` funciona.

**Precocinados**
- `menu.updatePrepack` acepta receta por API y la **reemplaza completa**:
  `{prepack_id, product_id, product_name, prepack_unit, out, ingredient:[{id:number, type, brutto, netto, lock, unit}]}`.
  `prepack_unit` (no `unit`), `out` = rendimiento. Las líneas se leen en kg/l pero se escriben en g/ml.
  (También se vio aceptado `id: "1_97"` = `<tipo>_<id>`; aquí se usa `id` numérico + `type`.)

**Compras e inventario**
- `storage.getSupplies` (lista): `supply_sum` en **centavos**.
- `storage.getSupply` (detalle): `supply_sum` y `supply_ingredient_sum` en **pesos**; el importe del renglón es el **total** del renglón.
- `storage.createSupply`: multipart con `date, storage_id, supplier_id, supply_comment` e `ingredients` = JSON string
  `[{id, type, num, sum}]` (`type` 4 insumo · 1 producto · 5 modificador).
  ⚠ **Sin verificar con compra real**: si `sum` va en centavos o pesos. El servidor envía **centavos por unidad** (lo que
  asumían los probes) y tras aplicar compara el total leído con el esperado; si no cuadra, lo marca con `alerta`.
- `storage.getStorageLeftovers.prime_cost` en centavos; **`menu.getIngredients.prime_cost` viene ×10 000** (1040000 = $104),
  por eso `insumos` toma el costo de los saldos.

**Finanzas** (`crear_transaccion`)
- `finance.createTransactions`: `type` 0 gasto · 1 ingreso · 2 transferencia. Gasto usa `account_from`/`amount_from`;
  ingreso `account_to`/`amount_to`; transferencia ambos pares (`account_from`→`account_to`). `category_id` solo en gasto/ingreso.
- ⚠ **Unidad sin confirmar al escribir**: al LEER (`finance.getTransactions`) los montos vienen en **centavos**; no está
  verificado si al escribir Póster espera pesos o centavos. El servidor **envía centavos** (como el resto de la API) y tras
  aplicar relee la transacción del día; si el monto quedó **100× desviado**, lo marca con `alerta_100x` y pide no reintentar.
- `account_id`/`account_destino_id` = cuentas de `finance.getAccounts`; `category_id` = `finance.getCategories`. `date` = `YYYY-MM-DD HH:MM:SS` (hora de Carmen).

**Compras y su pago**
- El **número de compra = `supply_id`** del almacén. `storage.getSupply`/`getSupplies` traen `account_id` = la cuenta que pagó; **`account_id` vacío `""` = a crédito (sin pagar)**. El detalle (`getSupply`) viene en **pesos**; la lista (`getSupplies`) en **centavos**.
- Al fijar `account_id` a una compra, Póster **autogenera** la transacción de Finanzas (type 0, categoría Compras) **ligada por `binding_type 12` + `binding_id = supply_id`**, con `recipient_type 12`/`recipient_id = supplier_id`.
- `asignar_pago_compra` = `storage.updateSupply` (update COMPLETO: relee y reenvía la compra cambiando solo `account_id`). ⚠ **Contrato de updateSupply sin verificar en vivo**: tras aplicar se relee y se compara total y # de renglones; si algo cambió, se marca para corregir en el panel.

**Otros**: grupos de clientes `loyalty_type` 1 = puntos, 2 = descuento; métodos de pago = `settings.getPaymentMethods`
(no `finance.*`); promociones = `clients.getPromotions`.

## Desarrollo local

```bash
cp .env.example .env      # ya existe en la Mac con llaves locales generadas
npm install
dev start poster-mcp      # pm2, PORT=3210; arranca erp-core-db si hace falta (tokens desde poster_accounts)
curl localhost:3210/health
```

Para Claude Code local: `claude mcp add --transport http poster-rush http://localhost:3210/mcp --header "Authorization: Bearer $MCP_BEARER_TOKEN"`.

## Tests

```bash
npm test             # unitarios (contratos, guardas, dry-run con API falsa) + flujo HTTP/OAuth completo
npm run test:live    # EN VIVO contra cafe-04: todas las lecturas + dry-run de cada escritura.
                     # El cliente de prueba revienta si algo intenta escribir.
```

## Autenticación

- **OAuth 2.1** (para el conector de claude.ai): descubrimiento `/.well-known/oauth-protected-resource` y
  `/.well-known/oauth-authorization-server`, registro dinámico `/register`, `/authorize` (pide `OWNER_PASSPHRASE`,
  5 intentos/15 min), `/token` (authorization_code + PKCE S256, refresh). Tokens JWT HS256 firmados con
  `OAUTH_SIGNING_KEY`: access 1 h, refresh 30 días. **Rotar la llave revoca todo.** Redirects permitidos:
  `claude.ai`/`claude.com` callback + loopback para pruebas.
- **Bearer estático** `MCP_BEARER_TOKEN` para Claude Code / curl.

## Estructura

```
src/config.ts       lista blanca, reglas de escritura, env
src/tokens.ts       GSM / MySQL, caché 10 min, redacción
src/poster.ts       cliente HTTP (reintenta lecturas, 1 intento en escrituras)
src/audit.ts        auditoría
src/tools/lectura.ts, src/tools/escritura.ts
src/mcp.ts          registro de herramientas (zod)
src/auth.ts         OAuth + bearer
src/server.ts       Hono: /health, OAuth, /mcp
scripts/subir-tokens-gsm.mts   DB local → Secret Manager (sin imprimir tokens)
```
