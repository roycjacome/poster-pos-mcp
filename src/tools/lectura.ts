// Herramientas de LECTURA. Cada una devuelve datos compactos (pensados para leerse en el celular)
// con importes ya convertidos a pesos. Ninguna escribe.
import type { PosterApi } from "../poster.js";
import { CUENTAS, config } from "../config.js";
import { coincide, fechaPoster, num, pesos, promoVigente } from "../util.js";

type Obj = Record<string, any>;

export function listarCuentas() {
  return CUENTAS.map((c) => ({ cuenta: c, escritura_por_defecto: config.writeDefault.has(c) }));
}

/** Producto compacto. Precio del platillo se LEE en centavos; precio de opción se LEE en pesos. */
export function productoCompacto(p: Obj) {
  const spots: Obj[] = p.spots ?? [];
  return {
    id: num(p.product_id),
    nombre: String(p.product_name ?? "").trim(),
    categoria: p.category_name,
    categoria_id: num(p.menu_category_id),
    tipo: num(p.type), // 2 = platillo con ficha (updateDish), 1 = producto, 3 = producto con modificaciones
    precio: Object.fromEntries(Object.entries(p.price ?? {}).map(([s, v]) => [s, pesos(v)])),
    visible: spots.length ? spots.every((s) => String(s.visible) === "1") : null,
    grupos: (p.group_modifications ?? []).length,
    receta_lineas: (p.ingredients ?? []).length,
  };
}

export async function menuSnapshot(api: PosterApi, a: { cuenta: string; buscar?: string; categoria_id?: number; solo_visibles?: boolean; limite?: number }) {
  const [cats, prods] = await Promise.all([
    api.get<Obj[]>(a.cuenta, "menu.getCategories"),
    api.get<Obj[]>(a.cuenta, "menu.getProducts"),
  ]);
  let lista = prods.map(productoCompacto).filter((p) => coincide(p.nombre, a.buscar));
  if (a.categoria_id) lista = lista.filter((p) => p.categoria_id === a.categoria_id);
  if (a.solo_visibles) lista = lista.filter((p) => p.visible);
  const limite = a.limite ?? 150;
  return {
    cuenta: a.cuenta,
    categorias: cats.map((c) => ({ id: num(c.category_id), nombre: c.category_name, padre: c.parent_category ? num(c.parent_category) : undefined })),
    total_productos: prods.length,
    coincidencias: lista.length,
    productos: lista.slice(0, limite),
    truncado: lista.length > limite,
  };
}

export async function productoDetalle(api: PosterApi, a: { cuenta: string; product_id: number }) {
  const prods = await api.get<Obj[]>(a.cuenta, "menu.getProducts");
  const p = prods.find((x) => num(x.product_id) === a.product_id);
  if (!p) throw new Error(`Producto ${a.product_id} no existe en ${a.cuenta}`);
  return {
    ...productoCompacto(p),
    color: p.color,
    workshop: num(p.workshop),
    spots: (p.spots ?? []).map((s: Obj) => ({ spot_id: num(s.spot_id), precio: pesos(s.price), visible: String(s.visible) === "1" })),
    grupos: (p.group_modifications ?? []).map((g: Obj) => ({
      id: g.dish_modification_group_id,
      nombre: g.name,
      tipo: num(g.type),
      min: num(g.num_min),
      max: num(g.num_max),
      opciones: (g.modifications ?? []).map((m: Obj) => ({
        id: m.dish_modification_id,
        nombre: m.name,
        tipo: num(m.type), // 1 = insumo, 2 = platillo, 10 = insumo por cantidad
        ingredient_id: num(m.ingredient_id),
        brutto: num(m.brutto),
        precio_pesos: num(m.price), // se lee en pesos
        orden: num(m.sort_order),
      })),
    })),
    receta: (p.ingredients ?? []).map((l: Obj) => ({
      ingredient_id: num(l.ingredient_id),
      nombre: l.ingredient_name,
      brutto: num(l.structure_brutto),
      unidad: l.structure_unit,
      tipo: num(l.structure_type),
    })),
  };
}

export async function insumos(api: PosterApi, a: { cuenta: string; buscar?: string; categoria_id?: number; limite?: number }) {
  const [cats, ings, saldos] = await Promise.all([
    api.get<Obj[]>(a.cuenta, "menu.getCategoriesIngredients"),
    api.get<Obj[]>(a.cuenta, "menu.getIngredients"),
    api.get<Obj[]>(a.cuenta, "storage.getStorageLeftovers"),
  ]);
  const nombreCat = new Map(cats.map((c) => [num(c.category_id), c.name]));
  // Costo: getIngredients.prime_cost viene ×10 000 (1040000 = $104); getStorageLeftovers.prime_cost en centavos.
  const costo = new Map(saldos.map((x) => [num(x.ingredient_id), pesos(x.prime_cost)]));
  let lista = ings
    .filter((i) => coincide(i.ingredient_name, a.buscar))
    .filter((i) => !a.categoria_id || num(i.category_id) === a.categoria_id)
    .map((i) => ({
      id: num(i.ingredient_id),
      nombre: String(i.ingredient_name).trim(),
      categoria: nombreCat.get(num(i.category_id)) ?? num(i.category_id),
      unidad: i.ingredient_unit,
      existencia: num(i.ingredient_left),
      costo_pesos: costo.get(num(i.ingredient_id)) ?? null,
    }));
  const limite = a.limite ?? 300;
  return {
    cuenta: a.cuenta,
    categorias: cats.map((c) => ({ id: num(c.category_id), nombre: c.name })),
    coincidencias: lista.length,
    insumos: lista.slice(0, limite),
    truncado: lista.length > limite,
  };
}

export async function precocinados(api: PosterApi, a: { cuenta: string; buscar?: string }) {
  const pp = await api.get<Obj[]>(a.cuenta, "menu.getPrepacks");
  return {
    cuenta: a.cuenta,
    precocinados: pp
      .filter((p) => coincide(p.product_name, a.buscar))
      .map((p) => ({
        id: num(p.product_id),
        nombre: String(p.product_name).trim(),
        rendimiento: num(p.out),
        unidad: p.unit,
        costo_crudo: num(p.cost), // unidad sin verificar (Póster no la documenta para prepacks)
        receta: (p.ingredients ?? []).map((l: Obj) => ({
          ingredient_id: num(l.ingredient_id),
          nombre: l.ingredient_name,
          tipo: num(l.structure_type),
          brutto: num(l.structure_brutto),
          netto: num(l.structure_netto),
          unidad: l.structure_unit,
          lock: num(l.structure_lock),
        })),
      })),
  };
}

export async function gruposClientes(api: PosterApi, a: { cuenta: string; incluir_borrados?: boolean }) {
  const g = await api.get<Obj[]>(a.cuenta, "clients.getGroups");
  return {
    cuenta: a.cuenta,
    grupos: g
      .filter((x) => a.incluir_borrados || String(x.delete) !== "1")
      .map((x) => ({
        id: num(x.client_groups_id),
        nombre: x.client_groups_name,
        tipo: num(x.loyalty_type) === 1 ? "puntos" : "descuento",
        porcentaje: num(x.client_groups_discount),
        bono_cumple: num(x.birthday_bonus),
        monedero: num(x.use_ewallet) === 1,
        clientes: num(x.count_groups_clients),
        borrado: String(x.delete) === "1",
      })),
  };
}

export async function promociones(api: PosterApi, a: { cuenta: string; solo_vigentes?: boolean }) {
  const p = await api.get<Obj[]>(a.cuenta, "clients.getPromotions");
  const lista = p.map((x) => ({
    id: num(x.promotion_id),
    nombre: x.name,
    inicio: x.date_start,
    fin: x.date_end,
    vigente: promoVigente(x.date_end),
    auto: String(x.auto_apply) === "1",
    params: x.params,
  }));
  return { cuenta: a.cuenta, promociones: a.solo_vigentes === false ? lista : lista.filter((x) => x.vigente) };
}

const TIPO_USUARIO: Record<number, string> = { 0: "mesero", 1: "administrador", 2: "marketing", 3: "almacenista", 4: "admin de sala", 50: "gerente", 90: "dueño" };
const SECCIONES: Array<[number, string]> = [[1, "POS"], [2, "Reportes"], [4, "Finanzas"], [8, "Productos"], [16, "Inventario"], [32, "Marketing"], [64, "Accesos"], [128, "Ajustes"], [256, "Admin de sala"], [512, "Seguridad"]];

export async function empleados(api: PosterApi, a: { cuenta: string }) {
  const e = await api.get<Obj[]>(a.cuenta, "access.getEmployees");
  const lista = e.map((x) => ({
    id: num(x.user_id),
    nombre: x.name,
    puesto: x.role_name,
    puesto_id: num(x.role_id),
    rol: TIPO_USUARIO[num(x.user_type)] ?? num(x.user_type),
    accesos: SECCIONES.filter(([b]) => (num(x.access_mask) & b) === b).map(([, n]) => n),
    ultimo_acceso: x.last_in,
  }));
  const puestos = [...new Map(lista.map((x) => [x.puesto_id, { id: x.puesto_id, nombre: x.puesto, empleados: lista.filter((y) => y.puesto_id === x.puesto_id).length }])).values()];
  return { cuenta: a.cuenta, empleados: lista, puestos, nota: "Los permisos de puestos solo se editan en el panel web de Póster." };
}

export async function metodosPago(api: PosterApi, a: { cuenta: string }) {
  const m = await api.get<Obj[]>(a.cuenta, "settings.getPaymentMethods");
  return {
    cuenta: a.cuenta,
    metodos: m.map((x) => ({
      id: num(x.payment_method_id),
      nombre: x.title,
      tipo_dinero: num(x.money_type),
      tipo_pago: num(x.payment_type),
      activo: String(x.is_active) === "1" || x.is_active === true,
      comision_pct: num(x.percents_acquiring),
    })),
  };
}

export async function ajustes(api: PosterApi, a: { cuenta: string }) {
  return { cuenta: a.cuenta, ajustes: await api.get<Obj>(a.cuenta, "settings.getAllSettings") };
}

export async function compras(api: PosterApi, a: { cuenta: string; desde?: string; hasta?: string; limite?: number }) {
  const params: Record<string, string | number> = {};
  if (a.desde) params.dateFrom = fechaPoster(a.desde);
  if (a.hasta) params.dateTo = fechaPoster(a.hasta);
  const s = await api.get<Obj[]>(a.cuenta, "storage.getSupplies", params);
  const lista = s
    .filter((x) => String(x.delete) !== "1")
    .map((x) => ({
      id: num(x.supply_id),
      fecha: x.date,
      proveedor: x.supplier_name,
      proveedor_id: num(x.supplier_id),
      almacen: x.storage_name,
      almacen_id: num(x.storage_id),
      total_pesos: pesos(x.supply_sum), // la LISTA viene en centavos
      comentario: x.supply_comment,
    }))
    .sort((x, y) => String(y.fecha).localeCompare(String(x.fecha)));
  const limite = a.limite ?? 30;
  return { cuenta: a.cuenta, total: lista.length, compras: lista.slice(0, limite) };
}

export async function compraDetalle(api: PosterApi, a: { cuenta: string; supply_id: number }) {
  const d = await api.get<Obj>(a.cuenta, "storage.getSupply", { supply_id: a.supply_id });
  if (!d || !d.supply_id) throw new Error(`Compra ${a.supply_id} no existe en ${a.cuenta}`);
  // El DETALLE viene en pesos: supply_sum y supply_ingredient_sum (= importe total del renglón)
  return {
    cuenta: a.cuenta,
    id: num(d.supply_id),
    fecha: d.date,
    proveedor: d.supplier_name,
    almacen_id: num(d.storage_id),
    total_pesos: num(d.supply_sum),
    comentario: d.supply_comment,
    renglones: (d.ingredients ?? []).map((i: Obj) => ({
      id: num(i.ingredient_id),
      nombre: i.ingredient_name,
      tipo: num(i.type),
      cantidad: num(i.supply_ingredient_num),
      unidad: i.ingredient_unit,
      importe_pesos: num(i.supply_ingredient_sum),
      unitario_pesos: num(i.supply_ingredient_num) ? Math.round((num(i.supply_ingredient_sum) / num(i.supply_ingredient_num)) * 100) / 100 : null,
    })),
  };
}

export async function saldos(api: PosterApi, a: { cuenta: string; storage_id?: number; buscar?: string; solo_negativos?: boolean; limite?: number }) {
  const params: Record<string, string | number> = {};
  if (a.storage_id) params.storage_id = a.storage_id;
  const l = await api.get<Obj[]>(a.cuenta, "storage.getStorageLeftovers", params);
  let lista = l
    .filter((x) => coincide(x.ingredient_name, a.buscar))
    .map((x) => ({
      id: num(x.ingredient_id),
      nombre: String(x.ingredient_name).trim(),
      existencia: num(x.ingredient_left),
      unidad: x.ingredient_unit,
      minimo: num(x.limit_value),
      costo_unitario_pesos: pesos(x.prime_cost),
      valor_pesos: pesos(x.storage_ingredient_sum),
    }));
  if (a.solo_negativos) lista = lista.filter((x) => x.existencia < 0);
  const limite = a.limite ?? 300;
  return { cuenta: a.cuenta, storage_id: a.storage_id ?? "todos", coincidencias: lista.length, saldos: lista.slice(0, limite), truncado: lista.length > limite };
}

export async function catalogosBase(api: PosterApi, a: { cuenta: string }) {
  const [alm, prov, catIng, catMenu] = await Promise.all([
    api.get<Obj[]>(a.cuenta, "storage.getStorages"),
    api.get<Obj[]>(a.cuenta, "storage.getSuppliers"),
    api.get<Obj[]>(a.cuenta, "menu.getCategoriesIngredients"),
    api.get<Obj[]>(a.cuenta, "menu.getCategories"),
  ]);
  return {
    cuenta: a.cuenta,
    almacenes: alm.filter((x) => String(x.delete) !== "1").map((x) => ({ id: num(x.storage_id), nombre: x.storage_name })),
    proveedores: prov.filter((x) => String(x.delete) !== "1").map((x) => ({ id: num(x.supplier_id), nombre: x.supplier_name })),
    categorias_insumos: catIng.map((x) => ({ id: num(x.category_id), nombre: x.name })),
    categorias_menu: catMenu.map((x) => ({ id: num(x.category_id), nombre: x.category_name })),
  };
}

/** Escape de solo lectura: cualquier método `<modulo>.get*` con parámetros simples. */
export const METODO_LECTURA = /^[a-zA-Z]+\.get[A-Za-z0-9]*$/;
export async function posterGet(api: PosterApi, a: { cuenta: string; metodo: string; params?: Record<string, string | number> }) {
  if (!METODO_LECTURA.test(a.metodo)) throw new Error("Solo se permiten métodos de lectura <modulo>.get*");
  const r = await api.get(a.cuenta, a.metodo, a.params ?? {});
  const texto = JSON.stringify(r);
  return { cuenta: a.cuenta, metodo: a.metodo, bytes: texto.length, respuesta: texto.length > 60_000 ? `${texto.slice(0, 60_000)}… (truncado)` : r };
}
