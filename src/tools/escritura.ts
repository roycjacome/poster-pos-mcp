// Herramientas de ESCRITURA. Reglas comunes:
//   · dry-run por defecto: arma el payload, lee el estado actual y devuelve el diff SIN escribir.
//   · confirm: true aplica, lee de vuelta y verifica.
//   · Solo cuentas de WRITE_DEFAULT_ACCOUNTS (cafe-04); otra cuenta exige permitir_otra_cuenta: true.
//   · Todo (dry-run, aplicado o rechazado) queda en auditoría sin token.
import type { PosterApi, PosterRespuesta } from "../poster.js";
import { errorPoster } from "../poster.js";
import { verificarEscritura } from "../config.js";
import { auditar } from "../audit.js";
import { centavos, diff, fechaPoster, hoyMx, norm, num, pesos, unidadReceta, type Cambio } from "../util.js";

type Obj = Record<string, any>;

export interface Contexto {
  api: PosterApi;
  actor: string;
  cliente?: string;
}
export interface BaseEscritura {
  cuenta: string;
  confirm?: boolean;
  permitir_otra_cuenta?: boolean;
}

interface Plan {
  herramienta: string;
  metodo: string;
  payload: Obj;
  form?: boolean;
  antes: unknown;
  despues: unknown;
  avisos?: string[];
  /** Lee de vuelta tras aplicar; devuelve lista de discrepancias (vacía = OK). */
  verificar?: (r: PosterRespuesta) => Promise<{ ok: boolean; detalle: unknown }>;
}

async function ejecutar(ctx: Contexto, a: BaseEscritura, construir: () => Promise<Plan>) {
  const base = { actor: ctx.actor, cliente: ctx.cliente, cuenta: a.cuenta };
  let herramienta = "?";
  try {
    verificarEscritura(a.cuenta, a.permitir_otra_cuenta);
    const plan = await construir();
    herramienta = plan.herramienta;
    const cambios: Cambio[] = diff(plan.antes ?? {}, plan.despues); // creación: cada campo aparece como nuevo
    if (!a.confirm) {
      auditar({ ...base, herramienta, metodo: plan.metodo, modo: "dry-run", payload: plan.payload });
      return {
        modo: "dry-run",
        cuenta: a.cuenta,
        metodo: plan.metodo,
        cambios,
        avisos: plan.avisos ?? [],
        payload: plan.payload,
        siguiente_paso: "Revisa el diff. Para aplicar, repite la llamada con confirm: true.",
      };
    }
    const r = await ctx.api.post(a.cuenta, plan.metodo, plan.payload, { form: plan.form });
    const err = errorPoster(r);
    if (err || (r.response === undefined && r.success !== 1)) {
      auditar({ ...base, herramienta, metodo: plan.metodo, modo: "rechazado", payload: plan.payload, resultado: r, error: err ?? "sin response" });
      return { modo: "rechazado", cuenta: a.cuenta, metodo: plan.metodo, error: err ?? r, payload: plan.payload };
    }
    const verificacion = plan.verificar ? await plan.verificar(r) : { ok: true, detalle: "sin verificación" };
    auditar({ ...base, herramienta, metodo: plan.metodo, modo: "aplicado", payload: plan.payload, resultado: { respuesta: r.response, verificacion } });
    return { modo: "aplicado", cuenta: a.cuenta, metodo: plan.metodo, respuesta: r.response, cambios, verificacion };
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    auditar({ ...base, herramienta, metodo: "-", modo: "rechazado", payload: a, error: msg });
    throw e;
  }
}

// ── Grupos de clientes ──────────────────────────────────────────────────────
const tipoLealtad = (t: "puntos" | "descuento") => (t === "puntos" ? 1 : 2);

export async function crearGrupoCliente(
  ctx: Contexto,
  a: BaseEscritura & { nombre: string; tipo: "puntos" | "descuento"; porcentaje: number; bono_cumple?: number; usar_monedero?: boolean },
) {
  return ejecutar(ctx, a, async () => {
    const grupos = await ctx.api.get<Obj[]>(a.cuenta, "clients.getGroups");
    const dup = grupos.find((g) => String(g.delete) !== "1" && norm(g.client_groups_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe el grupo "${dup.client_groups_name}" (id ${dup.client_groups_id}). Usa actualizar_grupo_cliente.`);
    const payload: Obj = {
      client_groups_name: a.nombre,
      loyalty_type: tipoLealtad(a.tipo),
      client_groups_discount: a.porcentaje,
      birthday_bonus: a.bono_cumple ?? 0,
      use_ewallet: a.usar_monedero ? 1 : 0,
    };
    return {
      herramienta: "crear_grupo_cliente",
      metodo: "clients.createGroup",
      payload,
      antes: null,
      despues: payload,
      verificar: async (r) => {
        const g = (await ctx.api.get<Obj[]>(a.cuenta, "clients.getGroups")).find((x) => num(x.client_groups_id) === num(r.response));
        return { ok: !!g && norm(g.client_groups_name) === norm(a.nombre), detalle: g ?? "no aparece" };
      },
    };
  });
}

export async function actualizarGrupoCliente(
  ctx: Contexto,
  a: BaseEscritura & { client_groups_id: number; nombre?: string; tipo?: "puntos" | "descuento"; porcentaje?: number; bono_cumple?: number; usar_monedero?: boolean },
) {
  return ejecutar(ctx, a, async () => {
    const g = (await ctx.api.get<Obj[]>(a.cuenta, "clients.getGroups")).find((x) => num(x.client_groups_id) === a.client_groups_id);
    if (!g) throw new Error(`Grupo ${a.client_groups_id} no existe en ${a.cuenta}`);
    const antes = {
      client_groups_id: a.client_groups_id,
      client_groups_name: g.client_groups_name,
      loyalty_type: num(g.loyalty_type),
      client_groups_discount: num(g.client_groups_discount),
      birthday_bonus: num(g.birthday_bonus),
      use_ewallet: num(g.use_ewallet),
    };
    // updateGroup se manda completo: lo no pedido se conserva tal cual
    const payload = {
      ...antes,
      ...(a.nombre !== undefined && { client_groups_name: a.nombre }),
      ...(a.tipo !== undefined && { loyalty_type: tipoLealtad(a.tipo) }),
      ...(a.porcentaje !== undefined && { client_groups_discount: a.porcentaje }),
      ...(a.bono_cumple !== undefined && { birthday_bonus: a.bono_cumple }),
      ...(a.usar_monedero !== undefined && { use_ewallet: a.usar_monedero ? 1 : 0 }),
    };
    return {
      herramienta: "actualizar_grupo_cliente",
      metodo: "clients.updateGroup",
      payload,
      antes,
      despues: payload,
      verificar: async () => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "clients.getGroups")).find((x) => num(x.client_groups_id) === a.client_groups_id);
        const ok = !!v && v.client_groups_name === payload.client_groups_name && num(v.client_groups_discount) === num(payload.client_groups_discount) && num(v.loyalty_type) === payload.loyalty_type;
        return { ok, detalle: v };
      },
    };
  });
}

// ── Insumos ─────────────────────────────────────────────────────────────────
export async function crearInsumo(
  ctx: Contexto,
  a: BaseEscritura & { nombre: string; categoria_id: number; unidad: "kg" | "l" | "p"; peso_pieza_g?: number },
) {
  return ejecutar(ctx, a, async () => {
    const [ings, cats] = await Promise.all([
      ctx.api.get<Obj[]>(a.cuenta, "menu.getIngredients"),
      ctx.api.get<Obj[]>(a.cuenta, "menu.getCategoriesIngredients"),
    ]);
    const dup = ings.find((i) => norm(i.ingredient_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe el insumo "${dup.ingredient_name}" (id ${dup.ingredient_id}).`);
    const cat = cats.find((c) => num(c.category_id) === a.categoria_id);
    if (!cat) throw new Error(`Categoría de insumos ${a.categoria_id} no existe. Disponibles: ${cats.map((c) => `${c.category_id}=${c.name}`).join(", ")}`);
    const payload = { ingredient_name: a.nombre, category_id: a.categoria_id, type: a.unidad, weight_ingredient: a.peso_pieza_g ?? 0 };
    return {
      herramienta: "crear_insumo",
      metodo: "menu.createIngredient",
      payload,
      antes: null,
      despues: { ...payload, categoria: cat.name },
      verificar: async (r) => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getIngredients")).find((i) => num(i.ingredient_id) === num(r.response));
        return { ok: !!v && v.ingredient_unit === a.unidad && num(v.category_id) === a.categoria_id, detalle: v ? { id: v.ingredient_id, nombre: v.ingredient_name, unidad: v.ingredient_unit, categoria_id: v.category_id } : "no aparece" };
      },
    };
  });
}

// ── Compras ─────────────────────────────────────────────────────────────────
const TIPO_RENGLON = { producto: 1, insumo: 4, modificador: 5 } as const;

export async function crearCompra(
  ctx: Contexto,
  a: BaseEscritura & {
    storage_id: number;
    supplier_id: number;
    fecha?: string;
    comentario?: string;
    account_id?: number; // cuenta de Finanzas que paga (opcional); sin ella la compra queda "sin pagar"
    renglones: Array<{ id: number; tipo?: keyof typeof TIPO_RENGLON; cantidad: number; costo_unitario: number }>;
  },
) {
  return ejecutar(ctx, a, async () => {
    const [alm, prov, ings, sups, cuentas] = await Promise.all([
      ctx.api.get<Obj[]>(a.cuenta, "storage.getStorages"),
      ctx.api.get<Obj[]>(a.cuenta, "storage.getSuppliers"),
      ctx.api.get<Obj[]>(a.cuenta, "menu.getIngredients"),
      ctx.api.get<Obj[]>(a.cuenta, "storage.getSupplies"),
      ctx.api.get<Obj[]>(a.cuenta, "finance.getAccounts"),
    ]);
    if (!alm.some((x) => num(x.storage_id) === a.storage_id)) throw new Error(`Almacén ${a.storage_id} no existe`);
    const p = prov.find((x) => num(x.supplier_id) === a.supplier_id);
    if (!p) throw new Error(`Proveedor ${a.supplier_id} no existe`);
    const cuentaPago = a.account_id === undefined ? undefined : (cuentas ?? []).find((x) => num(x.account_id) === a.account_id);
    if (a.account_id !== undefined && !cuentaPago) throw new Error(`Cuenta financiera ${a.account_id} no existe en ${a.cuenta}. Disponibles: ${(cuentas ?? []).map((x) => `${x.account_id}=${String(x.name).trim()}`).join(", ") || "(ninguna)"}`);
    if (!a.renglones.length) throw new Error("La compra necesita al menos un renglón");
    const porId = new Map(ings.map((i) => [num(i.ingredient_id), i]));
    const avisos: string[] = [];
    const renglones = a.renglones.map((l) => {
      const tipo = l.tipo ?? "insumo";
      const ing = porId.get(l.id);
      if (tipo === "insumo" && !ing) throw new Error(`Insumo ${l.id} no existe en ${a.cuenta}`);
      if (l.cantidad <= 0) throw new Error(`Cantidad inválida en renglón ${l.id}`);
      return { l, tipo, nombre: ing?.ingredient_name ?? `#${l.id}`, unidad: ing?.ingredient_unit };
    });
    if (a.comentario && sups.some((s) => String(s.delete) !== "1" && norm(s.supply_comment) === norm(a.comentario))) {
      avisos.push(`Ya hay una compra con el comentario "${a.comentario}": ¿duplicada?`);
    }
    const fecha = a.fecha ?? new Date().toLocaleString("sv-SE", { timeZone: "America/Merida" }).slice(0, 19);
    // Contrato (probe_supply_final.mjs): multipart con `ingredients` como JSON string.
    // `sum` = costo POR UNIDAD en centavos (la lista getSupplies también viene en centavos).
    const lineas = renglones.map(({ l, tipo }) => ({ id: l.id, type: TIPO_RENGLON[tipo], num: l.cantidad, sum: centavos(l.costo_unitario) }));
    const payload: Obj = { date: fecha, storage_id: a.storage_id, supplier_id: a.supplier_id, supply_comment: a.comentario ?? "", ingredients: lineas };
    if (a.account_id !== undefined) payload.account_id = a.account_id; // con cuenta = pagada al momento; sin cuenta = queda a crédito
    const total = renglones.reduce((s, { l }) => s + l.cantidad * l.costo_unitario, 0);
    return {
      herramienta: "crear_compra",
      metodo: "storage.createSupply",
      payload,
      form: true,
      antes: null,
      despues: {
        fecha,
        proveedor: p.supplier_name,
        renglones: renglones.map(({ l, nombre, unidad }) => ({ nombre, cantidad: l.cantidad, unidad, unitario_pesos: l.costo_unitario, importe_pesos: Math.round(l.cantidad * l.costo_unitario * 100) / 100 })),
        total_pesos: Math.round(total * 100) / 100,
        cuenta_pago: cuentaPago ? `${a.account_id} · ${String(cuentaPago.name).trim()}` : "— (a crédito: sin pagar; asigna la cuenta después con asignar_pago_compra)",
      },
      avisos: [...avisos, "Una compra mueve existencias y costo promedio de los insumos.", ...(a.account_id === undefined ? ["Sin account_id la compra queda a crédito (account_id vacío). El pago se asigna luego con asignar_pago_compra (el botón \"pagar\" de Póster)."] : ["Con account_id, Póster postea el gasto en Finanzas a esa cuenta al momento."])],
      verificar: async (r) => {
        const d = await ctx.api.get<Obj>(a.cuenta, "storage.getSupply", { supply_id: num(r.response) });
        const real = num(d?.supply_sum);
        const ok = Math.abs(real - total) < 0.5;
        return {
          ok,
          detalle: { supply_id: num(r.response), total_esperado: total, total_leido_pesos: real, ...(ok ? {} : { alerta: "El total leído no coincide: revisa unidades (centavos/pesos) antes de seguir y corrige la compra en el panel." }) },
        };
      },
    };
  });
}

// ── Platillos (menu.updateDish) ─────────────────────────────────────────────
/**
 * Arma el payload COMPLETO de updateDish a partir del producto tal como está hoy.
 * Contratos: precio del platillo se lee y escribe en centavos (mapa por spot); precio de opción se LEE en pesos y
 * se ESCRIBE en centavos; visibilidad = spots[].visible (no `hidden`); price/visible/"ingredient[]" siempre presentes.
 */
export function payloadUpdateDish(p: Obj) {
  const precio: Obj = p.price && Object.keys(p.price).length ? p.price : { 1: 0 };
  const spots = Object.keys(precio);
  const vis = Object.fromEntries((p.spots ?? []).map((s: Obj) => [String(s.spot_id), String(s.visible) === "1" ? 1 : 0]));
  return {
    dish_id: num(p.product_id),
    product_name: String(p.product_name),
    menu_category_id: num(p.menu_category_id),
    workshop: num(p.workshop) || 1,
    product_color: p.color || "grey",
    weight_flag: num(p.weight_flag),
    out: num(p.out),
    price: Object.fromEntries(spots.map((s) => [s, num(precio[s])])),
    visible: Object.fromEntries(spots.map((s) => [s, vis[s] ?? 1])),
    modificationgroup: (p.group_modifications ?? []).map((g: Obj) => ({
      name: String(g.name).trim(),
      type: num(g.type) || 1,
      num_min: num(g.num_min),
      num_max: num(g.num_max) || 1,
      minNum: num(g.num_min),
      maxNum: num(g.num_max) || 1,
      modifications: (g.modifications ?? []).map((m: Obj) => ({
        name: m.name,
        ingredientId: num(m.ingredient_id),
        ingredient_id: num(m.ingredient_id),
        type: num(m.type) || 1,
        brutto: num(m.brutto) || 1,
        price: centavos(m.price), // leído en pesos → escrito en centavos
        sort_order: num(m.sort_order),
        _id: num(m.dish_modification_id), // solo para ubicar cambios; se quita antes de enviar
      })),
    })),
    "ingredient[]": [] as unknown[],
  };
}

const sinIds = (pl: ReturnType<typeof payloadUpdateDish>) => ({
  ...pl,
  modificationgroup: pl.modificationgroup.map((g: Obj) => ({ ...g, modifications: g.modifications.map(({ _id, ...m }: Obj) => m) })),
});

export async function actualizarPlatillo(
  ctx: Contexto,
  a: BaseEscritura & {
    product_id: number;
    nombre?: string;
    categoria_id?: number;
    precio?: number;
    visible?: boolean;
    color?: string;
    precios_opciones?: Array<{ dish_modification_id: number; precio: number }>;
  },
) {
  return ejecutar(ctx, a, async () => {
    const prods = await ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts");
    const p = prods.find((x) => num(x.product_id) === a.product_id);
    if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
    if (num(p.type) !== 2) throw new Error(`"${p.product_name}" es tipo ${p.type}, no platillo (2): updateDish no aplica.`);
    // TRAMPA: updateDish es update COMPLETO y vacía la receta. Si la tiene, no se toca (la receta solo vive en el panel).
    if ((p.ingredients ?? []).length) {
      throw new Error(`"${String(p.product_name).trim()}" tiene receta (${p.ingredients.length} líneas): updateDish la borraría. Edítalo en el panel web.`);
    }
    if (a.categoria_id !== undefined) {
      const cats = await ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories");
      if (!cats.some((c) => num(c.category_id) === a.categoria_id)) throw new Error(`Categoría ${a.categoria_id} no existe`);
    }
    const antes = payloadUpdateDish(p);
    const despues = structuredClone(antes);
    if (a.nombre !== undefined) despues.product_name = a.nombre;
    if (a.categoria_id !== undefined) despues.menu_category_id = a.categoria_id;
    if (a.color !== undefined) despues.product_color = a.color;
    if (a.precio !== undefined) for (const s of Object.keys(despues.price)) despues.price[s] = centavos(a.precio);
    if (a.visible !== undefined) for (const s of Object.keys(despues.visible)) despues.visible[s] = a.visible ? 1 : 0;
    for (const po of a.precios_opciones ?? []) {
      const m = despues.modificationgroup.flatMap((g: Obj) => g.modifications).find((x: Obj) => x._id === po.dish_modification_id);
      if (!m) throw new Error(`Opción ${po.dish_modification_id} no pertenece a "${p.product_name}"`);
      m.price = centavos(po.precio);
    }
    const payload = sinIds(despues);
    return {
      herramienta: "actualizar_platillo",
      metodo: "menu.updateDish",
      payload,
      antes: sinIds(antes),
      despues: payload,
      avisos: ["updateDish reescribe el platillo completo; se reenvían grupos, precios y visibilidad actuales."],
      verificar: async () => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts")).find((x) => num(x.product_id) === a.product_id);
        if (!v) return { ok: false, detalle: "no aparece" };
        const leido = sinIds(payloadUpdateDish(v));
        const dif = diff(payload, leido);
        return { ok: dif.length === 0, detalle: dif.length ? { diferencias_tras_leer: dif } : "coincide" };
      },
    };
  });
}

// ── Categorías del menú ─────────────────────────────────────────────────────
export async function actualizarCategoria(ctx: Contexto, a: BaseEscritura & { category_id: number; nombre?: string; padre_id?: number }) {
  return ejecutar(ctx, a, async () => {
    const cats = await ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories");
    const c = cats.find((x) => num(x.category_id) === a.category_id);
    if (!c) throw new Error(`Categoría ${a.category_id} no existe`);
    if (a.padre_id !== undefined && a.padre_id !== 0 && !cats.some((x) => num(x.category_id) === a.padre_id)) throw new Error(`Categoría padre ${a.padre_id} no existe`);
    if (a.padre_id === a.category_id) throw new Error("Una categoría no puede ser su propio padre");
    const antes = { category_id: a.category_id, category_name: c.category_name, parent_category: num(c.parent_category) };
    const payload = { ...antes, ...(a.nombre !== undefined && { category_name: a.nombre }), ...(a.padre_id !== undefined && { parent_category: a.padre_id }) };
    return {
      herramienta: "actualizar_categoria",
      metodo: "menu.updateCategory",
      payload,
      antes,
      despues: payload,
      verificar: async () => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories")).find((x) => num(x.category_id) === a.category_id);
        return { ok: !!v && v.category_name === payload.category_name && num(v.parent_category) === payload.parent_category, detalle: v };
      },
    };
  });
}

// ── Precocinados (menu.updatePrepack) ───────────────────────────────────────
export interface LineaPrepack {
  ingredient_id: number;
  tipo?: number; // 1 = insumo, 2 = precocinado
  brutto: number;
  netto?: number;
  unidad?: string; // g | ml | p
  lock?: number;
}

export function lineasPrepackActuales(p: Obj): Required<LineaPrepack>[] {
  return (p.ingredients ?? []).map((l: Obj) => ({
    ingredient_id: num(l.ingredient_id),
    tipo: num(l.structure_type) || 1,
    brutto: num(l.structure_brutto),
    netto: num(l.structure_netto),
    unidad: unidadReceta(String(l.structure_unit)),
    lock: num(l.structure_lock),
  }));
}

export async function actualizarPrecocinado(
  ctx: Contexto,
  a: BaseEscritura & { product_id: number; nombre?: string; rendimiento?: number; receta?: LineaPrepack[] },
) {
  return ejecutar(ctx, a, async () => {
    const [pps, ings] = await Promise.all([
      ctx.api.get<Obj[]>(a.cuenta, "menu.getPrepacks"),
      ctx.api.get<Obj[]>(a.cuenta, "menu.getIngredients"),
    ]);
    const p = pps.find((x) => num(x.product_id) === a.product_id);
    if (!p) throw new Error(`Precocinado ${a.product_id} no existe en ${a.cuenta}`);
    const actuales = lineasPrepackActuales(p);
    const insumoIds = new Set(ings.map((i) => num(i.ingredient_id)));
    const prepackIds = new Set(pps.map((x) => num(x.product_id)));
    const receta = (a.receta ?? actuales).map((l) => {
      const tipo = l.tipo ?? 1;
      if (tipo === 1 && !insumoIds.has(l.ingredient_id)) throw new Error(`Insumo ${l.ingredient_id} no existe`);
      if (tipo === 2 && !prepackIds.has(l.ingredient_id)) throw new Error(`Precocinado ${l.ingredient_id} no existe`);
      const previo = actuales.find((x) => x.ingredient_id === l.ingredient_id && x.tipo === tipo);
      return { ingredient_id: l.ingredient_id, tipo, brutto: l.brutto, netto: l.netto ?? l.brutto, unidad: l.unidad ?? previo?.unidad ?? "g", lock: l.lock ?? previo?.lock ?? 0 };
    });
    if (!receta.length) throw new Error("La receta del precocinado no puede quedar vacía");
    // Contrato: ingredient:[{id:number, type, brutto, netto, lock, unit}], prepack_unit (no unit), out = rendimiento
    const conv = (r: typeof receta) => r.map((l) => ({ id: l.ingredient_id, type: l.tipo, brutto: l.brutto, netto: l.netto, lock: l.lock, unit: l.unidad }));
    const antes = { prepack_id: a.product_id, product_id: a.product_id, product_name: String(p.product_name).trim(), prepack_unit: p.unit || "kg", out: num(p.out), ingredient: conv(actuales) };
    const payload = { ...antes, ...(a.nombre !== undefined && { product_name: a.nombre }), ...(a.rendimiento !== undefined && { out: a.rendimiento }), ingredient: conv(receta) };
    return {
      herramienta: "actualizar_precocinado",
      metodo: "menu.updatePrepack",
      payload,
      antes,
      despues: payload,
      avisos: ["updatePrepack reemplaza la receta completa del precocinado (se envían todas las líneas)."],
      verificar: async () => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getPrepacks")).find((x) => num(x.product_id) === a.product_id);
        if (!v) return { ok: false, detalle: "no aparece" };
        const leido = lineasPrepackActuales(v).map((l) => `${l.tipo}_${l.ingredient_id}:${l.brutto}`).sort();
        const esperado = receta.map((l) => `${l.tipo}_${l.ingredient_id}:${l.brutto}`).sort();
        const ok = JSON.stringify(leido) === JSON.stringify(esperado) && Math.abs(num(v.out) - payload.out) < 1;
        return { ok, detalle: { receta_leida: leido, rendimiento_leido: num(v.out) } };
      },
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Altas de menú: categoría, precocinado y platillo con receta; ocultar platillo
// (contratos probados en la temporada de otoño 2026: scripts/temporada-red.js)
// ════════════════════════════════════════════════════════════════════════════

/** Lee un producto: menu.getProduct (trae receta y grupos); si no responde, cae a la lista menu.getProducts. */
export async function leerProducto(api: PosterApi, cuenta: string, productId: number): Promise<Obj | undefined> {
  try {
    const p = await api.get<Obj>(cuenta, "menu.getProduct", { product_id: productId });
    if (p && num(p.product_id) === productId) return p;
  } catch {
    /* cae a la lista */
  }
  const prods = await api.get<Obj[]>(cuenta, "menu.getProducts");
  return (prods ?? []).find((x) => num(x.product_id) === productId);
}

export interface LineaReceta {
  ingredient_id: number;
  tipo?: number; // 1 = insumo, 2 = precocinado
  brutto: number;
  netto?: number;
  lock?: number;
}
export interface OpcionAlta {
  ingredient_id: number;
  tipo?: "insumo" | "precocinado" | "platillo"; // → type 10 | 3 | 2 (platillo auxiliar, ej. "Para llevar 12 oz")
  nombre: string;
  brutto: number;
  precio?: number; // pesos
}
export interface GrupoAlta {
  nombre: string;
  tipo?: 1 | 2; // 1 = uno de varios, 2 = varios
  min: number;
  max: number;
  opciones: OpcionAlta[];
}

/** Catálogo de insumos y precocinados para validar IDs (se distinguen por tipo: los IDs se repiten). */
async function catalogoRecetas(api: PosterApi, cuenta: string) {
  const [ings, pps] = await Promise.all([api.get<Obj[]>(cuenta, "menu.getIngredients"), api.get<Obj[]>(cuenta, "menu.getPrepacks")]);
  const insumo = new Map((ings ?? []).map((i) => [num(i.ingredient_id), i]));
  const prepack = new Map((pps ?? []).map((p) => [num(p.product_id), p]));
  const nombre = (tipo: number, id: number) => {
    if (tipo === 2) {
      const p = prepack.get(id);
      if (!p) throw new Error(`Precocinado ${id} no existe en ${cuenta}`);
      return String(p.product_name).trim();
    }
    const i = insumo.get(id);
    if (!i) throw new Error(`Insumo ${id} no existe en ${cuenta}`);
    return String(i.ingredient_name).trim();
  };
  const unidad = (tipo: number, id: number) => unidadReceta(String(tipo === 2 ? prepack.get(id)?.unit ?? "kg" : insumo.get(id)?.ingredient_unit ?? ""));
  return { ings: ings ?? [], pps: pps ?? [], nombre, unidad };
}

const lineaPoster = (l: LineaReceta) => ({ id: l.ingredient_id, type: l.tipo ?? 1, brutto: l.brutto, netto: l.netto ?? l.brutto, lock: l.lock ?? 1 });

/** Receta actual de un platillo/precocinado en formato de escritura (desde structure_*). */
export function recetaParaEscribir(p: Obj) {
  return (p.ingredients ?? []).map((l: Obj) => ({
    id: num(l.ingredient_id),
    type: num(l.structure_type) || 1,
    brutto: num(l.structure_brutto),
    netto: num(l.structure_netto) || num(l.structure_brutto),
    lock: l.structure_lock === undefined ? 1 : num(l.structure_lock),
  }));
}
const firmaReceta = (r: Array<{ id: number; type: number; brutto: number }>) => r.map((l) => `${l.type}_${l.id}:${l.brutto}`).sort();
/** Firma de grupos. Con brutto solo para comparar lectura contra lectura (Póster puede leer en kg/l lo que se escribe en g/ml). */
const firmaGrupos = (gs: Obj[], conBrutto = false) =>
  gs.map((g) => `${String(g.name).trim()}|${num(g.num_min ?? g.minNum)}-${num(g.num_max ?? g.maxNum)}|` +
    (g.modifications ?? []).map((m: Obj) => `${num(m.ingredient_id ?? m.ingredientId)}${conBrutto ? `:${num(m.brutto)}` : ""}@${num(m.price)}`).sort().join(",")).sort();

// ── crear_categoria (menu.createCategory) ───────────────────────────────────
export async function crearCategoria(ctx: Contexto, a: BaseEscritura & { nombre: string; padre_id?: number; color?: string; oculta?: boolean }) {
  return ejecutar(ctx, a, async () => {
    const cats = await ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories");
    const dup = cats.find((c) => String(c.category_hidden ?? "0") !== "2" && norm(c.category_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe la categoría "${String(dup.category_name).trim()}" (id ${dup.category_id}). Úsala o renómbrala con actualizar_categoria.`);
    const padre = a.padre_id ?? 0;
    if (padre !== 0 && !cats.some((c) => num(c.category_id) === padre)) throw new Error(`Categoría padre ${padre} no existe`);
    const parecidas = cats.filter((c) => norm(c.category_name).split(/\s+/).some((w) => w.length > 4 && norm(a.nombre).includes(w)));
    const payload = { category_name: a.nombre, parent_category: padre, category_color: a.color ?? "orange", category_hidden: a.oculta ? 1 : 0 };
    return {
      herramienta: "crear_categoria",
      metodo: "menu.createCategory",
      payload,
      antes: null,
      despues: payload,
      avisos: parecidas.length ? [`Categorías con nombre parecido: ${parecidas.map((c) => `${c.category_id}=${String(c.category_name).trim()}`).join(", ")}`] : [],
      verificar: async (r) => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories")).find((x) => num(x.category_id) === num(r.response));
        return { ok: !!v && norm(v.category_name) === norm(a.nombre) && num(v.parent_category) === padre, detalle: v ? { category_id: num(v.category_id), nombre: v.category_name, padre: num(v.parent_category) } : "no aparece" };
      },
    };
  });
}

// ── crear_precocinado (menu.createPrepack) ──────────────────────────────────
export async function crearPrecocinado(ctx: Contexto, a: BaseEscritura & { nombre: string; receta: LineaReceta[]; descripcion?: string }) {
  return ejecutar(ctx, a, async () => {
    const cat = await catalogoRecetas(ctx.api, a.cuenta);
    const dup = cat.pps.find((p) => norm(p.product_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe el precocinado "${String(dup.product_name).trim()}" (id ${dup.product_id}). Usa actualizar_precocinado.`);
    if (!a.receta.length) throw new Error("El precocinado necesita al menos una línea de receta");
    const legible = a.receta.map((l) => ({ ...lineaPoster(l), nombre: cat.nombre(l.tipo ?? 1, l.ingredient_id), unidad: cat.unidad(l.tipo ?? 1, l.ingredient_id) }));
    const payload: Obj = { product_name: a.nombre, ingredient: a.receta.map(lineaPoster) };
    if (a.descripcion) payload.product_production_description = a.descripcion;
    const esperado = firmaReceta(payload.ingredient);
    return {
      herramienta: "crear_precocinado",
      metodo: "menu.createPrepack",
      payload,
      antes: null,
      despues: { product_name: a.nombre, receta: legible, rendimiento_estimado: Math.round(a.receta.reduce((s, l) => s + (l.netto ?? l.brutto), 0) * 100) / 100 },
      avisos: ["Póster recalcula el rendimiento sumando pesos; las cantidades van en g / ml / piezas."],
      verificar: async (r) => {
        const v = (await ctx.api.get<Obj[]>(a.cuenta, "menu.getPrepacks")).find((x) => num(x.product_id) === num(r.response));
        if (!v) return { ok: false, detalle: "no aparece" };
        const leido = firmaReceta(recetaParaEscribir(v));
        return { ok: JSON.stringify(leido) === JSON.stringify(esperado), detalle: { product_id: num(v.product_id), receta_leida: leido, rendimiento_leido: num(v.out) } };
      },
    };
  });
}

const TIPO_OPCION = { insumo: 10, precocinado: 3, platillo: 2 } as const;

/** Valida grupos: opciones existentes según su tipo (platillo = otro producto tipo 2 SIN grupos propios: Póster no anida). */
function validarGrupos(grupos: GrupoAlta[], cat: Awaited<ReturnType<typeof catalogoRecetas>>, prods: Obj[], avisos: string[]) {
  for (const g of grupos) {
    if (!g.opciones.length) throw new Error(`Grupo "${g.nombre}" sin opciones`);
    if (g.min > g.max) throw new Error(`Grupo "${g.nombre}": min > max`);
    if (/leche/i.test(g.nombre) && g.min < 1) avisos.push(`⚠ Grupo "${g.nombre}" es opcional: si no eligen leche no se descuenta.`);
    for (const o of g.opciones) {
      if (o.tipo === "platillo") {
        const aux = prods.find((x) => num(x.product_id) === o.ingredient_id);
        if (!aux || num(aux.type) !== 2) throw new Error(`Platillo auxiliar ${o.ingredient_id} no existe (o no es platillo) en la cuenta`);
        if ((aux.group_modifications ?? []).length) throw new Error(`Platillo auxiliar "${aux.product_name}" tiene grupos propios: Póster no permite anidarlo.`);
      } else cat.nombre(o.tipo === "precocinado" ? 2 : 1, o.ingredient_id);
    }
  }
}
const gruposPoster = (grupos: GrupoAlta[]) =>
  grupos.map((g) => ({
    name: g.nombre,
    type: g.tipo ?? 1,
    minNum: g.min,
    maxNum: g.max,
    modifications: g.opciones.map((o) => ({ ingredientId: o.ingredient_id, type: TIPO_OPCION[o.tipo ?? "insumo"], name: o.nombre, brutto: o.brutto, price: centavos(o.precio ?? 0) })),
  }));

// ── crear_platillo (menu.createDish) ────────────────────────────────────────
export async function crearPlatillo(
  ctx: Contexto,
  a: BaseEscritura & {
    nombre: string;
    categoria_id: number;
    workshop: number;
    precio: number; // pesos
    receta: LineaReceta[];
    grupos?: GrupoAlta[];
    color?: string;
    sin_descuento?: boolean;
  },
) {
  return ejecutar(ctx, a, async () => {
    const [prods, cats, cat] = await Promise.all([
      ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts"),
      ctx.api.get<Obj[]>(a.cuenta, "menu.getCategories"),
      catalogoRecetas(ctx.api, a.cuenta),
    ]);
    const dup = prods.find((p) => norm(p.product_name) === norm(a.nombre));
    if (dup) throw new Error(`Ya existe el producto "${String(dup.product_name).trim()}" (id ${dup.product_id}).`);
    const c = cats.find((x) => num(x.category_id) === a.categoria_id);
    if (!c) throw new Error(`Categoría ${a.categoria_id} no existe en ${a.cuenta}`);
    if (!a.receta.length) throw new Error("El platillo necesita receta");
    const avisos: string[] = [];
    if (a.precio <= 0) avisos.push("⚠ Precio en $0.");
    const talleres = new Set(prods.filter((p) => num(p.type) === 2).map((p) => num(p.workshop)));
    if (!talleres.has(a.workshop)) avisos.push(`⚠ Ningún platillo de ${a.cuenta} usa workshop ${a.workshop} (en uso: ${[...talleres].join(", ")}).`);
    const grupos = a.grupos ?? [];
    validarGrupos(grupos, cat, prods, avisos);
    const receta = a.receta.map(lineaPoster);
    const legible = a.receta.map((l) => ({ id: l.ingredient_id, tipo: l.tipo ?? 1, nombre: cat.nombre(l.tipo ?? 1, l.ingredient_id), cantidad: `${l.brutto} ${cat.unidad(l.tipo ?? 1, l.ingredient_id)}` }));
    const modificationgroup = gruposPoster(grupos);
    const payload: Obj = {
      product_name: a.nombre,
      menu_category_id: a.categoria_id,
      workshop: a.workshop,
      weight_flag: 0,
      nodiscount: a.sin_descuento ? 1 : 0,
      visible: 1,
      price: centavos(a.precio),
      ...(a.color && { product_color: a.color }),
      ingredient: receta,
      modificationgroup,
    };
    const esperadoReceta = firmaReceta(receta);
    // opciones se escriben en centavos y se leen en pesos: la firma esperada usa pesos
    const esperadoGrupos = firmaGrupos(modificationgroup.map((g) => ({ ...g, modifications: g.modifications.map((m) => ({ ...m, price: m.price / 100 })) })));
    return {
      herramienta: "crear_platillo",
      metodo: "menu.createDish",
      payload,
      antes: null,
      despues: {
        nombre: a.nombre,
        categoria: `${a.categoria_id} · ${String(c.category_name).trim()}`,
        workshop: a.workshop,
        precio_pesos: a.precio,
        receta: legible,
        grupos: grupos.map((g) => ({ nombre: g.nombre, min: g.min, max: g.max, opciones: g.opciones.map((o) => `${o.nombre} · ${o.brutto} · +$${o.precio ?? 0}`) })),
      },
      avisos,
      verificar: async (r) => {
        const id = num((r.response as Obj)?.product_id ?? r.response);
        const v = await leerProducto(ctx.api, a.cuenta, id);
        if (!v) return { ok: false, detalle: { product_id: id, error: "no aparece" } };
        const leidoReceta = firmaReceta(recetaParaEscribir(v));
        const leidoGrupos = firmaGrupos(v.group_modifications ?? []);
        const bruttos = (v.group_modifications ?? []).flatMap((g: Obj) => (g.modifications ?? []).map((m: Obj) => `${String(m.name).trim()}=${num(m.brutto)}`));
        const precioLeido = num((v.price ?? {})[Object.keys(v.price ?? {})[0]] ?? v.spots?.[0]?.price);
        const fallas = [
          JSON.stringify(leidoReceta) !== JSON.stringify(esperadoReceta) && { receta_esperada: esperadoReceta, receta_leida: leidoReceta },
          JSON.stringify(leidoGrupos) !== JSON.stringify(esperadoGrupos) && { grupos_esperados: esperadoGrupos, grupos_leidos: leidoGrupos },
          precioLeido !== centavos(a.precio) && { precio_esperado_centavos: centavos(a.precio), precio_leido_centavos: precioLeido },
        ].filter(Boolean);
        return { ok: fallas.length === 0, detalle: { product_id: id, ...(fallas.length ? { fallas } : { receta: `${leidoReceta.length} líneas`, grupos: leidoGrupos.length, precio_pesos: precioLeido / 100, bruttos_opciones_leidos: bruttos }) } };
      },
    };
  });
}

// ── ocultar_platillo (menu.getProduct + menu.updateDish COMPLETO) ───────────
export async function ocultarPlatillo(ctx: Contexto, a: BaseEscritura & { product_id: number; sufijo?: string }) {
  return ejecutar(ctx, a, async () => {
    const sufijo = a.sufijo ?? " (old)";
    const p = await leerProducto(ctx.api, a.cuenta, a.product_id);
    if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
    if (num(p.type) !== 2) throw new Error(`"${p.product_name}" es tipo ${p.type}, no platillo (2).`);
    const nombre = String(p.product_name).trim();
    const yaOculto = (p.spots ?? []).length > 0 && (p.spots ?? []).every((s: Obj) => String(s.visible) !== "1");
    if (yaOculto && nombre.endsWith(sufijo.trim())) throw new Error(`"${nombre}" ya está oculto y renombrado: nada que hacer.`);
    const receta = recetaParaEscribir(p);
    // Base = payload completo que ya usa actualizar_platillo; se añade receta e IDs de grupos/opciones para no perder nada
    const base = payloadUpdateDish(p);
    const grupos = (p.group_modifications ?? []).map((g: Obj, gi: number) => ({
      dish_modification_group_id: num(g.dish_modification_group_id),
      ...base.modificationgroup[gi],
      modifications: base.modificationgroup[gi].modifications.map(({ _id, ...m }: Obj) => ({ dish_modification_id: _id, ...m })),
    }));
    const { "ingredient[]": _vacio, ...resto } = base;
    const antes = { ...resto, modificationgroup: grupos, ...(receta.length ? { ingredient: receta } : { "ingredient[]": [] }) };
    const payload = structuredClone(antes) as Obj;
    payload.product_name = nombre.endsWith(sufijo.trim()) ? nombre : `${nombre}${sufijo}`;
    for (const s of Object.keys(payload.visible)) payload.visible[s] = 0;
    return {
      herramienta: "ocultar_platillo",
      metodo: "menu.updateDish",
      payload,
      antes,
      despues: payload,
      avisos: [`Se reenvía la receta (${receta.length} líneas) y ${grupos.length} grupos tal como están; solo cambian nombre y visibilidad.`],
      verificar: async () => {
        const v = await leerProducto(ctx.api, a.cuenta, a.product_id);
        if (!v) return { ok: false, detalle: "no aparece" };
        const oculto = (v.spots ?? []).every((s: Obj) => String(s.visible) !== "1");
        const recetaOk = JSON.stringify(firmaReceta(recetaParaEscribir(v))) === JSON.stringify(firmaReceta(receta));
        const gruposOk = JSON.stringify(firmaGrupos(v.group_modifications ?? [], true)) === JSON.stringify(firmaGrupos(p.group_modifications ?? [], true));
        const nombreOk = String(v.product_name).trim() === String(payload.product_name).trim();
        return { ok: oculto && recetaOk && gruposOk && nombreOk, detalle: { nombre: v.product_name, oculto, receta_intacta: recetaOk, grupos_intactos: gruposOk } };
      },
    };
  });
}

// ── borrar_platillo_old (menu.removeDish) ───────────────────────────────────
// Solo para liberar lugar del plan de Póster: el platillo debe estar OCULTO en todos los spots
// y su nombre debe terminar en "(old)" (es decir, ya pasó por ocultar_platillo). Las ventas históricas se conservan.
export async function borrarPlatilloOld(ctx: Contexto, a: BaseEscritura & { product_id: number }) {
  return ejecutar(ctx, a, async () => {
    const p = await leerProducto(ctx.api, a.cuenta, a.product_id);
    if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
    if (num(p.type) !== 2) throw new Error(`"${p.product_name}" es tipo ${p.type}, no platillo (2).`);
    const nombre = String(p.product_name).trim();
    if (!/\(old\)$/i.test(nombre)) throw new Error(`"${nombre}" no termina en "(old)": primero ocúltalo con ocultar_platillo.`);
    const visible = (p.spots ?? []).some((s: Obj) => String(s.visible) === "1");
    if (visible) throw new Error(`"${nombre}" sigue visible en algún spot: no se borra.`);
    const payload = { dish_id: a.product_id };
    return {
      herramienta: "borrar_platillo_old",
      metodo: "menu.removeDish",
      payload,
      antes: { product_id: a.product_id, nombre, receta: `${(p.ingredients ?? []).length} líneas`, grupos: (p.group_modifications ?? []).length },
      despues: { borrado: true },
      avisos: ["Borra el platillo del menú para liberar lugar del plan. Las ventas históricas se quedan en reportes."],
      verificar: async () => {
        const prods = await ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts");
        const sigue = prods.some((x) => num(x.product_id) === a.product_id);
        return { ok: !sigue, detalle: sigue ? "sigue apareciendo en menu.getProducts" : "ya no aparece en el menú" };
      },
    };
  });
}


// ── actualizar_receta_platillo (menu.updateDish COMPLETO con receta y grupos nuevos) ─
// Reemplaza receta y grupos de un platillo existente; conserva nombre, categoría, workshop, color, precio y visibilidad.
export async function actualizarRecetaPlatillo(ctx: Contexto, a: BaseEscritura & { product_id: number; receta: LineaReceta[]; grupos: GrupoAlta[] }) {
  return ejecutar(ctx, a, async () => {
    const [p, prods, cat] = await Promise.all([
      leerProducto(ctx.api, a.cuenta, a.product_id),
      ctx.api.get<Obj[]>(a.cuenta, "menu.getProducts"),
      catalogoRecetas(ctx.api, a.cuenta),
    ]);
    if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
    if (num(p.type) !== 2) throw new Error(`"${p.product_name}" es tipo ${p.type}, no platillo (2).`);
    if (!a.receta.length) throw new Error("La receta no puede quedar vacía");
    const avisos: string[] = [];
    validarGrupos(a.grupos, cat, prods, avisos);
    if (a.grupos.some((g) => g.opciones.some((o) => o.tipo === "platillo" && o.ingredient_id === a.product_id))) throw new Error("Un platillo no puede ser opción de sí mismo");
    const receta = a.receta.map(lineaPoster);
    for (const l of a.receta) cat.nombre(l.tipo ?? 1, l.ingredient_id);
    const base = payloadUpdateDish(p);
    const { "ingredient[]": _v, modificationgroup: _g, ...resto } = base;
    const legible = (r: Array<{ id: number; type: number; brutto: number }>) => r.map((l) => `${cat.nombre(l.type, l.id)} · ${l.brutto} ${cat.unidad(l.type, l.id)}`);
    const gruposLegibles = (gs: Obj[]) => gs.map((g) => `${String(g.name).trim()} [${num(g.num_min ?? g.minNum)}-${num(g.num_max ?? g.maxNum)}]: ` + (g.modifications ?? []).map((m: Obj) => String(m.name).trim()).join(" | "));
    const actual = recetaParaEscribir(p);
    const payload = { ...resto, ingredient: receta, modificationgroup: gruposPoster(a.grupos) };
    const esperadoReceta = firmaReceta(receta);
    const esperadoGrupos = firmaGrupos(payload.modificationgroup.map((g) => ({ ...g, modifications: g.modifications.map((m) => ({ ...m, price: m.price / 100 })) })));
    return {
      herramienta: "actualizar_receta_platillo",
      metodo: "menu.updateDish",
      payload,
      antes: { nombre: String(p.product_name).trim(), receta: legible(actual), grupos: gruposLegibles(p.group_modifications ?? []) },
      despues: { nombre: String(p.product_name).trim(), receta: legible(receta), grupos: gruposLegibles(payload.modificationgroup) },
      avisos: [...avisos, "updateDish reemplaza receta y grupos completos; nombre, precio, categoría y visibilidad se conservan."],
      verificar: async () => {
        const v = await leerProducto(ctx.api, a.cuenta, a.product_id);
        if (!v) return { ok: false, detalle: "no aparece" };
        const r = firmaReceta(recetaParaEscribir(v)), g = firmaGrupos(v.group_modifications ?? []);
        const precioOk = JSON.stringify(payloadUpdateDish(v).price) === JSON.stringify(payload.price);
        const visOk = JSON.stringify(payloadUpdateDish(v).visible) === JSON.stringify(payload.visible);
        const fallas = [
          JSON.stringify(r) !== JSON.stringify(esperadoReceta) && { receta_esperada: esperadoReceta, receta_leida: r },
          JSON.stringify(g) !== JSON.stringify(esperadoGrupos) && { grupos_esperados: esperadoGrupos, grupos_leidos: g },
          !precioOk && "precio cambió", !visOk && "visibilidad cambió",
        ].filter(Boolean);
        return { ok: fallas.length === 0, detalle: fallas.length ? { fallas } : { receta: `${r.length} líneas`, grupos: g.length } };
      },
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Finanzas: registrar transacciones (finance.createTransactions)
//   type 0 = gasto   → salida de una cuenta  (account_from / amount_from)
//   type 1 = ingreso → entrada a una cuenta  (account_to   / amount_to)
//   type 2 = transferencia → account_from/amount_from (origen) → account_to/amount_to (destino)
//   category_id: obligatorio en gasto e ingreso; en transferencia no aplica.
//   Montos SE ENVÍAN en centavos (como el resto de la API Póster) y se LEEN en centavos.
//   ⚠ No está confirmado si al escribir Póster espera pesos o centavos: tras aplicar se relee
//   finance.getTransactions del día y, si el monto quedó 100× desviado, se reporta claramente.
// ════════════════════════════════════════════════════════════════════════════
const TIPO_TX = { gasto: 0, ingreso: 1, transferencia: 2 } as const;
export type TipoTransaccion = keyof typeof TIPO_TX;

/** Monto (en centavos) de una transacción leída, según su tipo. Tolera varios nombres de campo. */
export function montoTxnCentavos(t: Obj, tipo: TipoTransaccion): number {
  const campos = tipo === "ingreso"
    ? ["amount_to", "amount", "sum", "amount_from"]
    : ["amount_from", "amount", "sum", "amount_to"];
  for (const c of campos) {
    const v = num(t?.[c]);
    if (v) return Math.abs(v);
  }
  return 0;
}

export async function crearTransaccion(
  ctx: Contexto,
  a: BaseEscritura & {
    tipo: TipoTransaccion;
    monto: number; // pesos
    account_id: number;
    account_destino_id?: number;
    category_id?: number;
    comentario?: string;
    fecha?: string; // YYYY-MM-DD [HH:MM:SS], hora de Carmen (America/Merida)
    user_id?: number;
  },
) {
  return ejecutar(ctx, a, async () => {
    if (a.monto <= 0) throw new Error("El monto debe ser mayor a 0 (pesos).");
    const [cuentas, categorias] = await Promise.all([
      ctx.api.get<Obj[]>(a.cuenta, "finance.getAccounts"),
      ctx.api.get<Obj[]>(a.cuenta, "finance.getCategories"),
    ]);
    const listaCuentas = cuentas ?? [];
    const listaCategorias = categorias ?? [];
    const nombreCuenta = (id: number) => {
      const c = listaCuentas.find((x) => num(x.account_id) === id);
      if (!c) throw new Error(`Cuenta financiera ${id} no existe en ${a.cuenta}. Disponibles: ${listaCuentas.map((x) => `${x.account_id}=${String(x.name).trim()}`).join(", ") || "(ninguna)"}`);
      return String(c.name).trim();
    };

    const tipoNum = TIPO_TX[a.tipo];
    const montoEnviado = a.monto; // finance.createTransactions usa PESOS, no centavos (confirmado 25 oct: enviar centavos dejó el monto 100× alto, txn 4473)
    const origen = nombreCuenta(a.account_id);
    const fecha = a.fecha
      ? (a.fecha.length <= 10 ? `${a.fecha} 00:00:00` : a.fecha)
      : new Date().toLocaleString("sv-SE", { timeZone: "America/Merida" }).slice(0, 19);

    const avisos: string[] = [];
    // Contrato real de finance.createTransactions: `type` es OBLIGATORIO (si falta → error 34 "type is undefined");
    // la categoría va como `category` (no `category_id`); la dirección usa account_from/amount_from (salida) y account_to/amount_to (entrada).
    const payload: Obj = { type: tipoNum, comment: a.comentario ?? "", date: fecha };
    if (a.user_id !== undefined) payload.user_id = a.user_id;

    let destino: string | undefined;
    let catNombre: string | undefined;
    if (a.tipo === "transferencia") {
      if (a.account_destino_id === undefined) throw new Error("La transferencia necesita account_destino_id (cuenta destino).");
      if (a.account_destino_id === a.account_id) throw new Error("Origen y destino no pueden ser la misma cuenta.");
      destino = nombreCuenta(a.account_destino_id);
      if (a.category_id !== undefined) avisos.push("category_id no aplica a transferencias: se ignora.");
      payload.account_from = a.account_id;
      payload.account_to = a.account_destino_id;
      payload.amount_from = montoEnviado;
      payload.amount_to = montoEnviado;
    } else {
      if (a.account_destino_id !== undefined) throw new Error("account_destino_id solo aplica a transferencias.");
      if (a.category_id === undefined) throw new Error(`En ${a.tipo} el category_id es obligatorio.`);
      const cat = listaCategorias.find((x) => num(x.category_id) === a.category_id);
      if (!cat) throw new Error(`Categoría financiera ${a.category_id} no existe en ${a.cuenta}. Disponibles: ${listaCategorias.map((x) => `${x.category_id}=${String(x.name).trim()}`).join(", ") || "(ninguna)"}`);
      catNombre = String(cat.name).trim();
      payload.category = a.category_id;
      if (a.tipo === "gasto") {
        payload.account_from = a.account_id;
        payload.amount_from = montoEnviado;
      } else {
        payload.account_to = a.account_id;
        payload.amount_to = montoEnviado;
      }
    }

    avisos.push("Montos enviados en PESOS (finance.createTransactions NO usa centavos, al revés que el resto de la API). Tras aplicar se relee en centavos; si queda 100× desviado, NO repitas: corrige en el panel y revisa la unidad.");

    return {
      herramienta: "crear_transaccion",
      metodo: "finance.createTransactions",
      payload,
      antes: null,
      despues: {
        tipo: `${a.tipo} (type ${tipoNum})`,
        monto_pesos: a.monto,
        cuenta_origen: `${a.account_id} · ${origen}`,
        ...(destino ? { cuenta_destino: `${a.account_destino_id} · ${destino}` } : {}),
        ...(a.tipo !== "transferencia" ? { categoria: `${a.category_id} · ${catNombre}` } : {}),
        comentario: a.comentario ?? "",
        fecha,
        ...(a.user_id !== undefined ? { user_id: a.user_id } : {}),
      },
      avisos,
      verificar: async (r) => {
        const resp = r.response as Obj | number | Array<Obj | number> | undefined;
        const primero = Array.isArray(resp) ? resp[0] : resp;
        const id = num((primero as Obj)?.transaction_id ?? primero);
        // Ventana que cubre el día de la transacción y hoy (por zona horaria / fecha de aplicación).
        const diaTx = fechaPoster(fecha.slice(0, 10)), hoy = fechaPoster(hoyMx());
        const desde = diaTx <= hoy ? diaTx : hoy, hasta = diaTx >= hoy ? diaTx : hoy;
        let txns: Obj[] = [];
        try {
          txns = (await ctx.api.get<Obj[]>(a.cuenta, "finance.getTransactions", { dateFrom: desde, dateTo: hasta })) ?? [];
        } catch {
          txns = [];
        }
        const t = (txns ?? []).find((x) => num(x.transaction_id) === id);
        if (!t) {
          return { ok: false, detalle: { transaction_id: id, alerta: "No se encontró la transacción al releer finance.getTransactions del día. Verifícala manualmente en el panel antes de reintentar." } };
        }
        const leidoCent = montoTxnCentavos(t, a.tipo);
        const leidoPesos = pesos(leidoCent);
        const ratio = a.monto ? leidoPesos / a.monto : 0;
        const montoOk = Math.abs(leidoPesos - a.monto) < 0.5;
        const desviacion100x = !montoOk && (Math.abs(ratio - 100) < 1 || (ratio > 0 && Math.abs(ratio - 0.01) < 0.0001));
        const catOk = a.tipo === "transferencia" || num(t.category_id) === a.category_id;
        const cuentaLeida = a.tipo === "ingreso" ? num(t.account_to ?? t.account_id) : num(t.account_from ?? t.account_id);
        const cuentaOk = cuentaLeida === a.account_id || cuentaLeida === 0; // 0 = Póster no la expone en la lectura

        const detalle: Obj = {
          transaction_id: id,
          monto_esperado_pesos: a.monto,
          monto_leido_pesos: leidoPesos,
          ...(a.tipo !== "transferencia" ? { categoria_esperada: a.category_id, categoria_leida: num(t.category_id) } : {}),
          cuenta_esperada: a.account_id,
          cuenta_leida: cuentaLeida,
        };
        if (desviacion100x) {
          detalle.alerta_100x = `⚠ MONTO 100× DESVIADO: quedó ${ratio >= 50 ? "100 veces MÁS ALTO" : "100 veces MÁS BAJO"} ($${leidoPesos} leídos vs $${a.monto} esperados). Póster interpretó el monto en la otra unidad (pesos↔centavos). NO repitas la escritura: corrige el monto en el panel y ajusta la herramienta antes de volver a usarla.`;
        } else if (!montoOk) {
          detalle.alerta_monto = `El monto leído ($${leidoPesos}) no coincide con el esperado ($${a.monto}).`;
        }
        if (!catOk) detalle.alerta_categoria = `La categoría leída (${num(t.category_id)}) no coincide con ${a.category_id}: revisa el nombre del campo de categoría en finance.createTransactions.`;
        if (!cuentaOk) detalle.alerta_cuenta = `La cuenta leída (${cuentaLeida}) no coincide con ${a.account_id}.`;
        return { ok: montoOk && catOk && cuentaOk, detalle };
      },
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// asignar_pago_compra (storage.updateSupply): el "botón pagar" de Póster por API
//   Compra a crédito → entra a inventario con account_id "" (sin pagar). Asignarle la cuenta
//   hace que Póster postee el gasto en Finanzas, ligado a la compra (binding_type 12).
//   updateSupply es update COMPLETO: se relee la compra y se reenvía TAL CUAL, cambiando solo account_id.
//   ⚠ Contrato de updateSupply sin verificar en vivo: tras aplicar se relee y se compara total y # de
//   renglones; si algo cambió (o la cuenta no quedó), se marca para corregir en el panel y NO reintentar.
// ════════════════════════════════════════════════════════════════════════════
/** account_id de una compra leída: "" / null = sin pagar (null). */
export const cuentaDeCompra = (sup: Obj): number | null =>
  sup.account_id === "" || sup.account_id === null || sup.account_id === undefined ? null : num(sup.account_id);

export async function asignarPagoCompra(ctx: Contexto, a: BaseEscritura & { supply_id: number; account_id: number }) {
  return ejecutar(ctx, a, async () => {
    const [sup, cuentas] = await Promise.all([
      ctx.api.get<Obj>(a.cuenta, "storage.getSupply", { supply_id: a.supply_id }),
      ctx.api.get<Obj[]>(a.cuenta, "finance.getAccounts"),
    ]);
    if (!sup || num(sup.supply_id) !== a.supply_id) throw new Error(`Compra ${a.supply_id} no existe en ${a.cuenta}`);
    const cuenta = (cuentas ?? []).find((x) => num(x.account_id) === a.account_id);
    if (!cuenta) throw new Error(`Cuenta financiera ${a.account_id} no existe en ${a.cuenta}. Disponibles: ${(cuentas ?? []).map((x) => `${x.account_id}=${String(x.name).trim()}`).join(", ") || "(ninguna)"}`);
    const actual = cuentaDeCompra(sup);
    if (actual === a.account_id) throw new Error(`La compra ${a.supply_id} ya está pagada con la cuenta ${a.account_id} (${String(cuenta.name).trim()}): nada que hacer.`);
    const avisos: string[] = [];
    if (actual !== null) avisos.push(`La compra ya tenía la cuenta ${actual}; se REASIGNA a ${a.account_id}. Verifica en el panel que no se duplique el gasto.`);
    // Reenvío COMPLETO tal como se lee. getSupply da el importe por renglón como TOTAL en pesos; createSupply/updateSupply
    // esperan sum = costo POR UNIDAD en centavos, así que se reconstruye num*sum ≈ total y la verificación lo compara.
    const renglones = (sup.ingredients ?? []).map((i: Obj) => {
      const cantidad = num(i.supply_ingredient_num);
      const totalPesos = num(i.supply_ingredient_sum);
      return { id: num(i.ingredient_id), type: num(i.type), num: cantidad, sum: cantidad ? Math.round((totalPesos / cantidad) * 100) : centavos(totalPesos) };
    });
    const totalEsperado = num(sup.supply_sum); // el DETALLE viene en pesos
    const payload: Obj = {
      supply_id: a.supply_id,
      date: sup.date,
      storage_id: num(sup.storage_id),
      supplier_id: num(sup.supplier_id),
      account_id: a.account_id,
      supply_comment: sup.supply_comment ?? "",
      ingredients: renglones,
    };
    return {
      herramienta: "asignar_pago_compra",
      metodo: "storage.updateSupply",
      payload,
      form: true,
      antes: { supply_id: a.supply_id, proveedor: sup.supplier_name, cuenta_pago: actual, total_pesos: totalEsperado, renglones: renglones.length },
      despues: { supply_id: a.supply_id, proveedor: sup.supplier_name, cuenta_pago: `${a.account_id} · ${String(cuenta.name).trim()}`, total_pesos: totalEsperado, renglones: renglones.length },
      avisos: [...avisos, "updateSupply reenvía la compra completa cambiando solo la cuenta de pago; al aplicar, Póster postea el gasto en Finanzas ligado a la compra (como el botón \"pagar\"). Contrato sin verificar en vivo: se relee y compara total y renglones."],
      verificar: async () => {
        const v = await ctx.api.get<Obj>(a.cuenta, "storage.getSupply", { supply_id: a.supply_id });
        if (!v || num(v.supply_id) !== a.supply_id) return { ok: false, detalle: "no aparece al releer" };
        const cuentaOk = cuentaDeCompra(v) === a.account_id;
        const totalOk = Math.abs(num(v.supply_sum) - totalEsperado) < 0.5;
        const renglonesOk = (v.ingredients ?? []).length === renglones.length;
        const detalle: Obj = { cuenta_pago_leida: cuentaDeCompra(v), total_leido_pesos: num(v.supply_sum), renglones_leidos: (v.ingredients ?? []).length };
        if (!cuentaOk) detalle.alerta_cuenta = `La cuenta de pago no quedó asignada (leído: ${v.account_id === "" ? "vacío" : v.account_id}).`;
        if (!totalOk) detalle.alerta_total = `El total cambió tras actualizar ($${num(v.supply_sum)} vs $${totalEsperado}): revisa la compra en el panel y NO reintentes.`;
        if (!renglonesOk) detalle.alerta_renglones = `Cambió el número de renglones (${(v.ingredients ?? []).length} vs ${renglones.length}): revisa la compra en el panel.`;
        return { ok: cuentaOk && totalOk && renglonesOk, detalle };
      },
    };
  });
}
