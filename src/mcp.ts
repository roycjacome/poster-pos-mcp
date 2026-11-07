// Registro de herramientas en el servidor MCP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CUENTAS } from "./config.js";
import { posterHttp, type PosterApi } from "./poster.js";
import { auditoriaReciente } from "./audit.js";
import { redactar } from "./tokens.js";
import * as L from "./tools/lectura.js";
import * as W from "./tools/escritura.js";

const cuenta = z.enum(CUENTAS).describe("Cuenta Póster de la red RUSH");
const cuentaEscritura = z.enum(CUENTAS).default("cafe-04").describe("Cuenta destino (por defecto cafe-04)");
const escritura = {
  confirm: z.boolean().default(false).describe("false = dry-run (solo muestra el diff). true = aplica el cambio."),
  permitir_otra_cuenta: z
    .boolean()
    .default(false)
    .describe("Requerido en true para escribir en una cuenta distinta de cafe-04. Solo con autorización explícita de Roy."),
};
const LECTURA = { readOnlyHint: true, openWorldHint: true } as const;
const ESCRITURA = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] });
const fallo = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: redactar(String((e as Error)?.message ?? e)) }] });
const envolver = <A>(fn: (a: A, extra: any) => Promise<unknown>) => async (a: A, extra: any) => {
  try {
    return ok(await fn(a, extra));
  } catch (e) {
    return fallo(e);
  }
};

export function crearServidorMcp(api: PosterApi = posterHttp) {
  const s = new McpServer({ name: "poster-rush", version: "0.2.0" }, {
    instructions:
      "Herramientas para leer y configurar las cuentas Póster POS de la red RUSH Café. " +
      "Lecturas en cualquier cuenta de la lista blanca. Escrituras: siempre primero en dry-run (confirm:false), mostrar el diff a Roy, " +
      "y solo aplicar con confirm:true tras su OK. Por defecto solo cafe-04; otra cuenta requiere permitir_otra_cuenta:true y autorización explícita. " +
      "Productos fuera de carta se OCULTAN (ocultar_platillo); solo se borran con borrar_platillo_old si Roy lo pide para liberar lugar del plan. Platillos nuevos con receta: crear_platillo. actualizar_platillo no toca platillos con receta; permisos de puestos solo en panel web.",
  });
  const ctx = (extra: any): W.Contexto => ({
    api,
    actor: (extra?.authInfo?.extra?.sub as string) ?? extra?.authInfo?.clientId ?? "desconocido",
    cliente: extra?.authInfo?.clientId,
  });

  // ── Lectura ──
  s.registerTool("listar_cuentas", { title: "Cuentas Póster", description: "Lista blanca de cuentas y cuáles permiten escritura por defecto.", annotations: LECTURA }, async () => ok(L.listarCuentas()));

  s.registerTool("menu_snapshot", {
    title: "Menú (resumen)",
    description: "Categorías y productos compactos (precio en pesos por spot, visible, #grupos, #líneas de receta). Filtra por texto/categoría.",
    inputSchema: { cuenta, buscar: z.string().optional(), categoria_id: z.number().int().optional(), solo_visibles: z.boolean().optional(), limite: z.number().int().min(1).max(500).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.menuSnapshot(api, a)));

  s.registerTool("producto_detalle", {
    title: "Detalle de producto",
    description: "Un producto completo: spots, grupos de modificadores con opciones (precio en pesos) y receta.",
    inputSchema: { cuenta, product_id: z.number().int() },
    annotations: LECTURA,
  }, envolver((a) => L.productoDetalle(api, a)));

  s.registerTool("insumos", {
    title: "Insumos",
    description: "Insumos con categoría, unidad, existencia total y costo en pesos.",
    inputSchema: { cuenta, buscar: z.string().optional(), categoria_id: z.number().int().optional(), limite: z.number().int().min(1).max(1000).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.insumos(api, a)));

  s.registerTool("precocinados", {
    title: "Precocinados",
    description: "Precocinados (prepacks) con rendimiento y receta línea por línea.",
    inputSchema: { cuenta, buscar: z.string().optional() },
    annotations: LECTURA,
  }, envolver((a) => L.precocinados(api, a)));

  s.registerTool("grupos_clientes", {
    title: "Grupos de clientes",
    description: "Grupos de clientes (puntos/descuento, porcentaje, # clientes).",
    inputSchema: { cuenta, incluir_borrados: z.boolean().optional() },
    annotations: LECTURA,
  }, envolver((a) => L.gruposClientes(api, a)));

  s.registerTool("promociones", {
    title: "Promociones",
    description: "Promociones. Por defecto solo vigentes (date_end ≥ hoy o 0000-00-00).",
    inputSchema: { cuenta, solo_vigentes: z.boolean().default(true) },
    annotations: LECTURA,
  }, envolver((a) => L.promociones(api, a)));

  s.registerTool("empleados", {
    title: "Empleados y puestos",
    description: "Empleados con puesto, rol y secciones a las que tienen acceso; resumen de puestos.",
    inputSchema: { cuenta },
    annotations: LECTURA,
  }, envolver((a) => L.empleados(api, a)));

  s.registerTool("metodos_pago", { title: "Métodos de pago", description: "Métodos de pago configurados (settings.getPaymentMethods).", inputSchema: { cuenta }, annotations: LECTURA }, envolver((a) => L.metodosPago(api, a)));

  s.registerTool("ajustes", { title: "Ajustes de la cuenta", description: "settings.getAllSettings completo.", inputSchema: { cuenta }, annotations: LECTURA }, envolver((a) => L.ajustes(api, a)));

  s.registerTool("compras", {
    title: "Compras",
    description: "Compras (storage.getSupplies) más recientes primero; total en pesos. Fechas YYYY-MM-DD.",
    inputSchema: { cuenta, desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), limite: z.number().int().min(1).max(500).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.compras(api, a)));

  s.registerTool("compra_detalle", { title: "Detalle de compra", description: "Renglones de una compra (storage.getSupply) con importe y unitario en pesos.", inputSchema: { cuenta, supply_id: z.number().int() }, annotations: LECTURA }, envolver((a) => L.compraDetalle(api, a)));

  s.registerTool("saldos", {
    title: "Saldos de inventario",
    description: "Existencias por almacén (storage.getStorageLeftovers). Puede filtrar negativos.",
    inputSchema: { cuenta, storage_id: z.number().int().optional(), buscar: z.string().optional(), solo_negativos: z.boolean().optional(), limite: z.number().int().min(1).max(1000).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.saldos(api, a)));

  s.registerTool("catalogos_base", { title: "Almacenes, proveedores y categorías", description: "IDs necesarios para escribir: almacenes, proveedores, categorías de insumos y de menú.", inputSchema: { cuenta }, annotations: LECTURA }, envolver((a) => L.catalogosBase(api, a)));

  s.registerTool("poster_get", {
    title: "Lectura genérica",
    description: "Llama cualquier método de LECTURA de Póster (<modulo>.get*) con parámetros simples. Respuesta cruda (truncada a 60 KB).",
    inputSchema: { cuenta, metodo: z.string().regex(L.METODO_LECTURA), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() },
    annotations: LECTURA,
  }, envolver((a) => L.posterGet(api, a)));

  s.registerTool("auditoria_reciente", { title: "Auditoría", description: "Últimas escrituras/dry-runs registrados en esta instancia.", inputSchema: { limite: z.number().int().min(1).max(200).default(20) }, annotations: LECTURA }, envolver(async (a: { limite: number }) => auditoriaReciente(a.limite)));

  // ── Escritura ──
  s.registerTool("crear_grupo_cliente", {
    title: "Crear grupo de clientes",
    description: "clients.createGroup. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), tipo: z.enum(["puntos", "descuento"]), porcentaje: z.number().min(0).max(100), bono_cumple: z.number().min(0).optional(), usar_monedero: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearGrupoCliente(ctx(extra), a)));

  s.registerTool("actualizar_grupo_cliente", {
    title: "Actualizar grupo de clientes",
    description: "clients.updateGroup (envía el grupo completo; conserva lo no indicado). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, client_groups_id: z.number().int(), nombre: z.string().min(1).optional(), tipo: z.enum(["puntos", "descuento"]).optional(), porcentaje: z.number().min(0).max(100).optional(), bono_cumple: z.number().min(0).optional(), usar_monedero: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarGrupoCliente(ctx(extra), a)));

  s.registerTool("crear_insumo", {
    title: "Crear insumo",
    description: "menu.createIngredient (rechaza nombres duplicados). Unidad: kg, l o p (pieza). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), categoria_id: z.number().int(), unidad: z.enum(["kg", "l", "p"]), peso_pieza_g: z.number().min(0).optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearInsumo(ctx(extra), a)));

  s.registerTool("crear_compra", {
    title: "Crear compra",
    description: "storage.createSupply. costo_unitario en PESOS por unidad del insumo (se envía en centavos). account_id opcional = cuenta de Finanzas que paga al momento; sin él la compra queda a crédito (sin pagar) y se paga después con asignar_pago_compra. Tras aplicar verifica el total leyendo la compra. Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      storage_id: z.number().int(),
      supplier_id: z.number().int(),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).optional().describe("YYYY-MM-DD HH:MM:SS (hora de Carmen). Por defecto ahora."),
      comentario: z.string().optional().describe("Ej. 'Ticket 51946'. Se usa para detectar duplicados."),
      account_id: z.number().int().optional().describe("Cuenta de Finanzas que paga la compra al momento (finance.getAccounts). Si se omite, la compra queda a crédito."),
      renglones: z.array(z.object({ id: z.number().int(), tipo: z.enum(["insumo", "producto", "modificador"]).optional(), cantidad: z.number().positive(), costo_unitario: z.number().min(0) })).min(1),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearCompra(ctx(extra), a)));

  s.registerTool("asignar_pago_compra", {
    title: "Pagar / asignar cuenta a una compra",
    description:
      "storage.updateSupply: asigna (o reasigna) la cuenta de Finanzas que paga una compra existente — el equivalente del botón \"pagar\" de Póster para compras a crédito. " +
      "Al aplicar, Póster postea el gasto en Finanzas ligado a la compra. Relee la compra y verifica que la cuenta quedó y que el total y los renglones no cambiaron. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, supply_id: z.number().int().describe("Número de compra (supply_id del almacén)"), account_id: z.number().int().describe("Cuenta de Finanzas que paga (finance.getAccounts)"), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.asignarPagoCompra(ctx(extra), a)));

  s.registerTool("actualizar_platillo", {
    title: "Actualizar platillo",
    description:
      "menu.updateDish (update COMPLETO). Cambia nombre, categoría, precio (pesos), visibilidad, color o precio de opciones (pesos). " +
      "Rechaza platillos con receta (updateDish la borraría). Para sacar de carta usa visible:false (no borrar). Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      product_id: z.number().int(),
      nombre: z.string().min(1).optional(),
      categoria_id: z.number().int().optional(),
      precio: z.number().min(0).optional().describe("Precio del platillo en pesos, igual en todos los spots"),
      visible: z.boolean().optional(),
      color: z.string().optional(),
      precios_opciones: z.array(z.object({ dish_modification_id: z.number().int(), precio: z.number().min(0) })).optional().describe("Precio en pesos de opciones existentes"),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarPlatillo(ctx(extra), a)));

  s.registerTool("actualizar_categoria", {
    title: "Actualizar categoría del menú",
    description: "menu.updateCategory: renombrar o mover bajo otra categoría (padre_id 0 = raíz). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, category_id: z.number().int(), nombre: z.string().min(1).optional(), padre_id: z.number().int().min(0).optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarCategoria(ctx(extra), a)));

  s.registerTool("actualizar_precocinado", {
    title: "Actualizar precocinado",
    description: "menu.updatePrepack: nombre, rendimiento (out) y/o receta COMPLETA (reemplaza todas las líneas; unidades g/ml/p). Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      product_id: z.number().int(),
      nombre: z.string().min(1).optional(),
      rendimiento: z.number().positive().optional(),
      receta: z.array(z.object({ ingredient_id: z.number().int(), tipo: z.number().int().min(1).max(2).optional(), brutto: z.number().positive(), netto: z.number().positive().optional(), unidad: z.enum(["g", "ml", "p"]).optional(), lock: z.number().int().min(0).max(1).optional() })).min(1).optional(),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarPrecocinado(ctx(extra), a)));

  // ── Altas de menú ──
  const lineaReceta = z.object({
    ingredient_id: z.number().int(),
    tipo: z.number().int().min(1).max(2).optional().describe("1 = insumo (default), 2 = precocinado. Los IDs se repiten entre ambos: indica siempre el tipo."),
    brutto: z.number().positive().describe("Cantidad en g / ml / piezas (aunque el insumo esté en kg o l)"),
    netto: z.number().positive().optional(),
    lock: z.number().int().min(0).max(1).optional(),
  });

  const grupoSchema = z.array(z.object({
        nombre: z.string().min(1),
        tipo: z.union([z.literal(1), z.literal(2)]).optional().describe("1 = uno de varios (default), 2 = varios"),
        min: z.number().int().min(0),
        max: z.number().int().min(1),
        opciones: z.array(z.object({
          ingredient_id: z.number().int(),
          tipo: z.enum(["insumo", "precocinado", "platillo"]).optional().describe("insumo (type 10, default), precocinado (type 3) o platillo auxiliar sin grupos (type 2, ej. \"Para llevar 12 oz\")"),
          nombre: z.string().min(1),
          brutto: z.number().positive().describe("g / ml / piezas que descuenta la opción"),
          precio: z.number().min(0).optional().describe("Cargo extra en pesos"),
        })).min(1),
      }));

  s.registerTool("crear_categoria", {
    title: "Crear categoría del menú",
    description: "menu.createCategory (rechaza nombre duplicado). padre_id 0 = raíz. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), padre_id: z.number().int().min(0).optional(), color: z.string().optional().describe("white, red, orange, yellow, green, blue, navy blue, purple, black, mint blue, lime green, pink"), oculta: z.boolean().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearCategoria(ctx(extra), a)));

  s.registerTool("crear_precocinado", {
    title: "Crear precocinado",
    description: "menu.createPrepack con receta (valida que cada insumo/precocinado exista; rechaza nombre duplicado). Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, nombre: z.string().min(1), receta: z.array(lineaReceta).min(1), descripcion: z.string().optional(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearPrecocinado(ctx(extra), a)));

  s.registerTool("crear_platillo", {
    title: "Crear platillo con receta",
    description:
      "menu.createDish con receta y grupos de modificadores. Precios en PESOS (se envían en centavos). Valida IDs por tipo, categoría y nombre duplicado; " +
      "tras aplicar relee el producto y compara receta, grupos y precio. La leche va en un grupo obligatorio (min 1). Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      nombre: z.string().min(1),
      categoria_id: z.number().int(),
      workshop: z.number().int().min(0).describe("Taller/estación de la cuenta (cada cuenta usa el suyo)"),
      precio: z.number().min(0).describe("Pesos"),
      receta: z.array(lineaReceta).min(1),
      grupos: grupoSchema.optional(),
      color: z.string().optional(),
      sin_descuento: z.boolean().optional().describe("true = nodiscount 1 (no participa en descuentos). Default false."),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearPlatillo(ctx(extra), a)));

  s.registerTool("ocultar_platillo", {
    title: "Ocultar platillo (sacar de carta)",
    description:
      "menu.getProduct + menu.updateDish con el payload COMPLETO (receta, grupos y opciones con sus IDs): visible 0 en todos los spots y sufijo \" (old)\". " +
      "Nunca borra. Tras aplicar verifica que receta y grupos quedaron intactos. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, product_id: z.number().int(), sufijo: z.string().optional().describe('Default " (old)"'), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.ocultarPlatillo(ctx(extra), a)));

  s.registerTool("borrar_platillo_old", {
    title: "Borrar platillo (old) para liberar lugar",
    description:
      "menu.removeDish SOLO para platillos ya ocultos cuyo nombre termina en \"(old)\" (pasaron por ocultar_platillo). " +
      "Úsalo únicamente cuando Roy pida borrar para liberar lugar del plan de Póster. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, product_id: z.number().int(), ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.borrarPlatilloOld(ctx(extra), a)));

  s.registerTool("actualizar_receta_platillo", {
    title: "Actualizar receta y grupos de un platillo",
    description:
      "menu.updateDish COMPLETO para un platillo con receta: reemplaza receta y grupos de modificadores (ej. sacar el empaque de la receta y agregar el grupo \"Servicio\" con En local / Para llevar). " +
      "Conserva nombre, categoría, precio y visibilidad. Muestra antes/después legible; tras aplicar relee y verifica. Dry-run por defecto.",
    inputSchema: { cuenta: cuentaEscritura, product_id: z.number().int(), receta: z.array(lineaReceta).min(1), grupos: grupoSchema, ...escritura },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.actualizarRecetaPlatillo(ctx(extra), a)));

  // ── Finanzas ──
  s.registerTool("crear_transaccion", {
    title: "Registrar transacción en Finanzas",
    description:
      "finance.createTransactions: registra un gasto (type 0), ingreso (type 1) o transferencia (type 2). " +
      "Monto en PESOS (se envía en centavos). El account_id es la cuenta financiera (ver finance.getAccounts con poster_get); " +
      "category_id es obligatorio en gasto e ingreso (finance.getCategories) y no aplica a transferencias, que usan account_destino_id. " +
      "Valida cuenta y categoría; tras aplicar relee finance.getTransactions del día y verifica monto, cuenta y categoría, avisando si el monto quedó 100× desviado. Dry-run por defecto.",
    inputSchema: {
      cuenta: cuentaEscritura,
      tipo: z.enum(["gasto", "ingreso", "transferencia"]).describe("gasto = salida, ingreso = entrada, transferencia = entre cuentas"),
      monto: z.number().positive().describe("Monto en PESOS (se envía en centavos)"),
      account_id: z.number().int().describe("Cuenta financiera: origen del gasto/transferencia o destino del ingreso (finance.getAccounts)"),
      account_destino_id: z.number().int().optional().describe("Solo transferencias: cuenta financiera destino"),
      category_id: z.number().int().optional().describe("Categoría financiera (finance.getCategories). Obligatoria en gasto e ingreso; se ignora en transferencias"),
      comentario: z.string().optional(),
      fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/).optional().describe("YYYY-MM-DD [HH:MM:SS], hora de Carmen (America/Merida). Por defecto ahora."),
      user_id: z.number().int().optional().describe("Empleado que registra la operación (opcional)"),
      ...escritura,
    },
    annotations: ESCRITURA,
  }, envolver((a, extra) => W.crearTransaccion(ctx(extra), a)));

  return s;
}
