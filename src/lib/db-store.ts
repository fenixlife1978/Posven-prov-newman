'use client';

import { AppState, Terminal, Movimiento } from './types';
import { enqueueOfflineOperation, registerOfflineProcessor } from './offline-queue';
import { db, rtdb } from './firebase';
import {
  collection, doc, getDoc, getDocs, onSnapshot, orderBy, limit, query, setDoc, where,
  writeBatch, runTransaction, startAfter
} from "firebase/firestore";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { onValue, ref, update, get as rtdbGet } from "firebase/database";

const STORAGE_KEY = 'posven_pro_session_data_cache';
const PAGE_SIZE = 50;
const CONFIG_COLLECTION = 'config';
const CONFIG_DOC_ID = 'general';
const CATALOGOS_COLLECTION = 'catalogos';
const RTDB_PRODUCTS_PATH = 'pos_system_data/productos';

// ============================================================
// UBICACIÓN EN FIRESTORE POR LISTA DEL ESTADO.
// Cada lista vive en SU PROPIA COLECCIÓN (documento por registro).
// El doc pos_system_data/state YA NO se lee ni se escribe.
// ============================================================
const COLLECTIONS: Record<string, string> = {
  productos: 'productos',
  movimientos: 'movimientos',
  ventas: 'ventas',
  cxc: 'cxc',
  cxp: 'cxp',
  clientes: 'clientes',
  proveedores: 'proveedores',
  devoluciones: 'devoluciones',
  anulaciones: 'anulaciones',
  terminales: 'terminales',
  libroDiario: 'libroDiario',
  reportesZ: 'reportesZ',
  cashHistory: 'caja',
  compras: 'compras',
};

// Catálogos: viven como docs catalogos/{nombre} con { lista: [...] }
const OPERATIONS_COLLECTION = 'operaciones';

function operationDocId(prefix: string, operationId: string): string {
  const input = prefix + '|' + operationId;
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return prefix.slice(0, 20) + '-' + (h >>> 0).toString(36);
}

async function claimOperation(tx: any, prefix: string, operationId: string): Promise<any> {
  const ref = doc(db, OPERATIONS_COLLECTION, operationDocId(prefix, operationId));
  const snap = await tx.get(ref);
  if (snap.exists()) throw new Error('Esta operación ya fue procesada. No se registrará nuevamente.');
  return ref;
}


function terminalPrefix(terminal: any, terminalId?: string): string {
  const raw = String(terminal?.prefijoCaja || '').trim().toUpperCase();
  if (raw) return raw;
  if (terminalId) return 'C-' + String(terminalId).replace(/[^A-Z0-9]/gi, '').slice(-6).toUpperCase();
  return 'GLOBAL';
}

function terminalSeries(prefix: string, label: string, number: number, width = 6): string {
  return prefix + '-' + label + '-' + String(number).padStart(width, '0');
}

const CATALOG_CACHE_META_KEY = 'posven_pro_catalog_cache_meta_v1';

const CATALOG_FIELDS: Record<string, string> = {
  categorias: 'categorias',
  departamentos: 'departamentos',
  marcas: 'marcas',
  presentaciones: 'presentaciones',
  productCategories: 'productCategories',
  productUnits: 'productUnits',
  productColors: 'productColors',
  productSizes: 'productSizes',
  brands: 'brands',
  groups: 'groups',
  subgroups: 'subgroups',
  lines: 'lines',
  suppliers: 'suppliers',
};

// Campos de configuración que se guardan en config/general (nunca en state).
// NOTA: El estado de caja (isCashOpen, cashData, fondos, ultimoZ, fechaUltimoZ,
// acumuladoHistorico, cashHistory) NO vive aquí: es POR TERMINAL (por caja),
// y se guarda en cada documento de la colección `terminales`. Eso evita que dos
// cajas compartan apertura/corte Z y se pisen la información entre sí.
const CONFIG_FIELDS = [
  'tasa', 'pinDevolucion', 'isInitialized', 'empresa',
  'proximoRecibo', 'proximaDevolucion', 'proximaAnulacion', 'config',
];

export const initialState: AppState = {
  user: null,
  isAuthenticated: false,
  tasa: 36.50,
  pinDevolucion: '000000',
  isInitialized: false,
  productos: [],
  ventas: [],
  cxc: [],
  cxp: [],
  clientes: [],
  devoluciones: [],
  anulaciones: [],
  movimientos: [],
  libroDiario: [],
  carrito: [],
  terminales: [],
  reportesZ: [],
  ultimoZ: 0,
  proximoRecibo: 1,
  proximaDevolucion: 1,
  proximaAnulacion: 1,
  acumuladoHistorico: 0,
  fechaUltimoZ: '',
  fondoCajaHoyUSD: 0,
  fondoCajaHoyBS: 0,

  isCashOpen: false,
  cashData: null,
  cashHistory: [],

  empresa: {
    nombre: 'NOMBRE DE SU NEGOCIO',
    rif: 'J-00000000-0',
    direccion: 'DIRECCIÓN FISCAL',
    telefono: '0000-0000000'
  },
  departamentos: ['Licores', 'Viveres', 'Otros'],
  categorias: ['Ron', 'Vino', 'Cerveza', 'Whisky', 'Refrescos', 'Otros'],
  marcas: ['Genérica'],
  presentaciones: ['750ml', '1L', 'Unidad', 'Caja'],
  proveedores: [],
  compras: [],

  config: {
    exchangeRate: 36.50,
    ivaRate: 16,
    igtfRate: 3
  },

  productCategories: ['Repuesto', 'Lubricante', 'Filtro', 'Químico', 'Accesorio', 'Batería', 'Caucho', 'Freno', 'Suspensión', 'Motor', 'Eléctrico', 'Transmisión', 'Servicio'],
  productUnits: ['unidad', 'litro', 'galón', 'cuarto', 'paila', 'kit', 'juego', 'par', 'metro', 'kilogramo', 'gramo', 'tambor'],
  productColors: ['No Aplica', 'Negro', 'Gris', 'Cromo', 'Rojo', 'Azul', 'Blanco', 'Ámbar'],
  productSizes: ['N/A', 'Estándar', '0.10', '0.20', '0.30', '0.40', '0.50', '20', '30', '40', '50', '60'],

  brands: [],
  groups: [],
  subgroups: [],
  lines: [],
  suppliers: [],

  marcasString: ['Genérica'],
  proveedoresString: [],

  products: [],
};

// ============================================================
// CACHE EN MEMORIA + localStorage (SOLO para mostrar UI rápido).
// El cache NUNCA se sube a Firestore (no más sobrescritura de datos).
//
// ⚠️ localStorage (no sessionStorage): la sesión debe sobrevivir
// cortes de luz / reinicios del PC. Si sessionStorage se usa, el cache
// se borra al cerrar el navegador y los Reportes X/Z se generan vacíos
// al volver a abrir el sistema (bug reportado por usuario).
// ============================================================
function readSession(): Partial<AppState> {
  if (typeof window === 'undefined') return {};
  try {
    const d = localStorage.getItem(STORAGE_KEY);
    if (!d) return {};
    const parsed = JSON.parse(d) as Partial<AppState>;
    delete (parsed as any).carrito;
    return parsed;
  } catch { return {}; }
}

let cache: AppState = { ...initialState, ...readSession() } as AppState;
const listeners = new Set<(s: Partial<AppState>) => void>();

// Mide cuánto ocupa el cache serializado; si pasa de ~4MB deja de escribir
// a localStorage para no tumbar la app (el cache en memoria sigue activo).
const LOCALSTORAGE_SOFT_LIMIT = 4 * 1024 * 1024; // 4 MB

function applyPatch(patch: Partial<AppState>) {
  cache = { ...cache, ...patch } as AppState;
  if (typeof window !== 'undefined') {
    try {
      const cacheToSave = { ...cache };
      delete (cacheToSave as any).carrito;
      const serialized = JSON.stringify(cacheToSave);
      if (serialized.length <= LOCALSTORAGE_SOFT_LIMIT) {
        localStorage.setItem(STORAGE_KEY, serialized);
      } else {
        // Excede el límite: no escribimos para evitar QuotaExceededError.
        // La próxima vez que se llame a readSession() se seguirá usando lo
        // último que cupo, pero el cache en memoria sigue 100% funcional.
        console.warn(
          '[db-store] Cache excede ' + (LOCALSTORAGE_SOFT_LIMIT / 1024 / 1024) +
          'MB, se omite escritura a localStorage (cuota llena).'
        );
      }
    } catch (e: any) {
      // QuotaExceededError u otro: no tumbamos la app.
      console.warn('[db-store] No se pudo persistir cache en localStorage:', e?.message || e);
    }
  }
  listeners.forEach(cb => { try { cb(patch); } catch (e) { console.error(e); } });
}

// Firestore rechaza undefined (y NaN/Infinity): los normaliza para no tumbar la escritura.
function sanitizeForFirestore(value: any): any {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForFirestore).filter(v => v !== undefined);
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) {
      const v = sanitizeForFirestore(value[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return value;
}

// Une dos listas por id sin duplicados (mantiene los elementos locales aún no persistidos).
function mergeById<T extends { id?: any }>(existing: T[] | undefined, incoming: T[]): T[] {
  const map = new Map<string, T>();
  (existing || []).forEach(x => { if (x && x.id !== undefined) map.set(String(x.id), x); });
  incoming.forEach(x => { if (x && x.id !== undefined) map.set(String(x.id), x); });
  return [...map.values()];
}

// Persistencia optimista por documento.
// Antes de sobrescribir un registro existente se comprueba dentro de una
// transacción que Firestore siga teniendo exactamente la versión que esta
// caja leyó. Si otra caja lo cambió entretanto, abortamos en lugar de
// pisar silenciosamente su modificación con un array local antiguo.
async function syncArrayToCollection(name: string, prevArr: any[] | undefined, newArr: any[] | undefined): Promise<void> {
  if (!db) return;
  const prevList = prevArr || [];
  const newList = newArr || [];
  const prevById = new Map(prevList.filter(x => x && x.id).map(x => [String(x.id), x]));
  const newById = new Map(newList.filter(x => x && x.id).map(x => [String(x.id), x]));
  const changed: Array<{id:string; before:any; after:any|null}> = [];

  newById.forEach((after, id) => {
    const before = prevById.get(id);
    if (!before || JSON.stringify(sanitizeForFirestore(before)) !== JSON.stringify(sanitizeForFirestore(after))) {
      changed.push({ id, before: before ?? null, after });
    }
  });
  prevById.forEach((before, id) => {
    if (!newById.has(id)) changed.push({ id, before, after: null });
  });

  // Agrupamos cambios en transacciones para reducir round-trips. Cada lote
  // mantiene la validación optimista: primero lee todas las versiones remotas
  // y solo después escribe, sin sobrepasar el límite de la transacción.
  const CHUNK_SIZE = 450;
  for (let offset = 0; offset < changed.length; offset += CHUNK_SIZE) {
    const chunk = changed.slice(offset, offset + CHUNK_SIZE);
    await runTransaction(db, async tx => {
      const snapshots = new Map<string, any>();
      for (const item of chunk) {
        const ref = doc(db, name, item.id);
        const snap = await tx.get(ref);
        snapshots.set(item.id, snap);
      }

      for (const item of chunk) {
        const ref = doc(db, name, item.id);
        const snap = snapshots.get(item.id);
        const remote = snap.exists() ? sanitizeForFirestore(snap.data()) : null;
        const expected = item.before ? sanitizeForFirestore(item.before) : null;

        if (!item.before) {
          if (snap.exists()) {
            throw new Error('Conflicto de sincronización: el registro ' + item.id + ' ya existe en Firestore.');
          }
          tx.set(ref, sanitizeForFirestore(item.after), { merge: true });
          continue;
        }

        if (!snap.exists() || JSON.stringify(remote) !== JSON.stringify(expected)) {
          throw new Error('Conflicto de sincronización en ' + name + '/' + item.id + '. Otro terminal modificó el registro. Se conserva la versión remota.');
        }

        if (item.after === null) {
          tx.delete(ref);
        } else {
          tx.set(ref, sanitizeForFirestore(item.after), { merge: true });
        }
      }
    });
  }
}

// Stock atómico entre cajas (transacciones): calcula deltas por producto y los aplica contra el
// stock REAL de Firestore para que dos cajas no se pisen el inventario.
function syncProductosTransactional(prevArr: any[] | undefined, newArr: any[] | undefined): Promise<Map<string, number> | undefined> {
  if (!db) return Promise.resolve(undefined);
  const prevList = prevArr || [];
  const newList = newArr || [];
  const prevById = new Map(prevList.filter(x => x && x.id).map(x => [String(x.id), x]));
  const newById = new Map(newList.filter(x => x && x.id).map(x => [String(x.id), x]));

  const createdIds = [...newById.keys()].filter(id => !prevById.has(id));
  const changedIds = [...newById.keys()].filter(id =>
    prevById.has(id) &&
    JSON.stringify(sanitizeForFirestore(prevById.get(id))) !== JSON.stringify(sanitizeForFirestore(newById.get(id)))
  );
  const removedIds = [...prevById.keys()].filter(id => !newById.has(id));

  if (createdIds.length === 0 && changedIds.length === 0 && removedIds.length === 0) return Promise.resolve(new Map());

  return runTransaction(db, async (tx) => {
    const finalStocks = new Map<string, number>();
    for (const id of createdIds) {
      const prod = newById.get(id) || {};
      tx.set(doc(db, 'productos', id), sanitizeForFirestore(prod), { merge: true });
      finalStocks.set(id, typeof prod.stock === 'number' ? prod.stock : 0);
    }
    for (const id of changedIds) {
      const prevP = prevById.get(id) || {};
      const newP = newById.get(id) || {};
      const prevStock = typeof prevP.stock === 'number' ? prevP.stock : 0;
      const newStock = typeof newP.stock === 'number' ? newP.stock : 0;
      const delta = newStock - prevStock;
      const ref = doc(db, 'productos', id);
      const snap = await tx.get(ref);
      const remote = snap.exists() ? snap.data() : null;
      const baseStock = remote && typeof remote.stock === 'number' ? remote.stock : (delta === 0 ? newStock : 0);
      const finalStock = baseStock + delta;
      tx.set(ref, sanitizeForFirestore({ ...newP, stock: finalStock }), { merge: true });
      finalStocks.set(id, finalStock);
    }
    for (const id of removedIds) {
      tx.delete(doc(db, 'productos', id));
    }
    return finalStocks;
  }).catch((e) => {
    // No hacemos fallback a escrituras por fuera de la transacción:
    // si la transacción falla por concurrencia, repetir la escritura con el
    // array local podría pisar cambios hechos por otra caja.
    console.error("Error transaccional productos:", e);
    throw e;
  });
}

// Movimiento de inventario atómico: toma el stock REAL de Firestore y registra
// el movimiento con stockAntes/stockDespues calculados dentro de la transacción.
async function applyInventoryMovementsTransaction(params: {
  operationId: string;
  operationType: string;
  movements: any[];
  productPatches?: Record<string, any>;
  fromOfflineQueue?: boolean;
}): Promise<any> {
  if (!db) return null;
  const { operationId, operationType, movements, productPatches = {}, fromOfflineQueue } = params;
  if (!movements?.length) throw new Error('No hay movimientos de inventario para registrar.');

  if (!fromOfflineQueue && typeof window !== 'undefined' && navigator.onLine === false) {
    if (!['AJUSTE-INVENTARIO', 'AJUSTE-INVENTARIO-POS'].includes(operationType)) {
      throw new Error('Esta operación requiere conexión para proteger la consistencia de ventas/devoluciones.');
    }
    enqueueOfflineOperation('INVENTARIO', { operationId, operationType, movements, productPatches, fromOfflineQueue: true }, operationId);
    return { queuedOffline: true, operationId, movements, products: [] };
  }

  const productIds = [...new Set(movements.map(m => String(m.productoId || '')).filter(Boolean))];
  let result: any = null;
  await runTransaction(db, async tx => {
    const operationRef = await claimOperation(tx, operationType, operationId);
    const remoteProducts = new Map<string, any>();
    for (const pid of productIds) {
      const snap = await tx.get(doc(db, 'productos', pid));
      if (!snap.exists()) throw new Error('El producto ' + pid + ' ya no existe en Firestore.');
      remoteProducts.set(pid, { ...sanitizeForFirestore(snap.data()), id: pid });
    }

    if (movements.length + productIds.length + 1 > 450) {
      throw new Error('La operación contiene demasiados movimientos para una sola transacción.');
    }

    const byProduct = new Map<string, any[]>();
    movements.forEach(m => {
      const pid = String(m.productoId);
      const list = byProduct.get(pid) || [];
      list.push(m);
      byProduct.set(pid, list);
    });

    const persisted: any[] = [];
    const persistedProducts: any[] = [];
    for (const pid of productIds) {
      const product = remoteProducts.get(pid);
      let running = Number(product.stock) || 0;
      for (const movement of byProduct.get(pid) || []) {
        const delta = Number(movement.cantidad) || 0;
        const before = running;
        running = before + delta;
        const persistedMovement = {
          ...movement,
          productoId: pid,
          stockAntes: before,
          stockDespues: running,
          id: String(movement.id || Store.uid())
        };
        tx.set(doc(db, 'movimientos', persistedMovement.id), sanitizeForFirestore(persistedMovement), { merge: false });
        persisted.push(persistedMovement);
      }

      const patch = productPatches[pid] || {};
      const persistedProduct = { ...product, ...patch, stock: running };
      tx.set(doc(db, 'productos', pid), sanitizeForFirestore(persistedProduct), { merge: true });
      persistedProducts.push(persistedProduct);
    }

    tx.set(operationRef, {
      tipo: operationType,
      operationId,
      fecha: String(movements[0]?.fecha || Utils.ahora()),
      referencia: String(movements[0]?.referencia || operationId)
    }, { merge: false });
    result = { movements: persisted, productIds, products: persistedProducts };
  });
  if (result?.products?.length) {
    await syncProductosRTDB([], result.products);
  }
  return result;
}

// ============================================================
// ESPEJO EN TIEMPO REAL (RTDB) PARA PRODUCTOS.
// El stock/precios viven en RTDB para sincronizar cajas sin re-leer
// toda la colección de Firestore en cada cambio (gran ahorro de lecturas).
// Firestore sigue siendo la fuente de verdad persistente.
// ============================================================
function syncProductosRTDB(prevArr: any[] | undefined, newArr: any[] | undefined): Promise<void> {
  if (!rtdb) return Promise.resolve();
  const prevById = new Map((prevArr || []).filter(x => x && x.id).map(x => [String(x.id), x]));
  const newList = newArr || [];
  const updates: Record<string, any> = {};
  const removals: string[] = [];
  newList.forEach(p => {
    if (!p || !p.id) return;
    const before = prevById.get(String(p.id));
    const clean = sanitizeForFirestore(p);
    if (!before || JSON.stringify(sanitizeForFirestore(before)) !== JSON.stringify(clean)) {
      updates[String(p.id)] = clean;
    }
  });
  prevById.forEach((_x, id) => {
    if (!newList.some(p => p && String(p.id) === id)) removals.push(id);
  });
  if (Object.keys(updates).length === 0 && removals.length === 0) return Promise.resolve();
  // RTDB permite enviar actualizaciones y eliminaciones en un único update
  // multipath. Así una operación que elimina varios productos no genera un
  // write remoto independiente por cada producto.
  const rootRef = ref(rtdb, RTDB_PRODUCTS_PATH);
  const payload: Record<string, any> = { ...updates };
  removals.forEach(id => { payload[id] = null; });
  return update(rootRef, payload)
    .catch(e => console.error('RTDB sync productos:', e));
}

// Sincroniza el espejo RTDB con Firestore (migración y sanado):
//  - Si el espejo está vacío → lo siembra COMPLETO desde Firestore.
//  - Si está incompleto (menos productos que Firestore) → lo repuebla completo.
// Firestore sigue siendo la fuente de verdad; RTDB es el espejo barato de tiempo real.
async function bootstrapProductos(): Promise<void> {
  if (!rtdb || !db) return;
  try {
    const snap = await rtdbGet(ref(rtdb, RTDB_PRODUCTS_PATH));
    const val = snap.val();
    const mirrorItems: any[] = val ? Object.values(val).filter(Boolean) : [];

    if (mirrorItems.length === 0) {
      const items = await loadCollection('productos');
      if (items.length > 0) {
        applyPatch({ productos: mergeById((cache as any).productos, items) });
        const updates: Record<string, any> = {};
        items.forEach(p => { updates[String(p.id)] = sanitizeForFirestore(p); });
        await update(ref(rtdb, RTDB_PRODUCTS_PATH), updates);
      }
      return;
    }

    applyPatch({ productos: mergeById((cache as any).productos, mirrorItems) });
    // Si el espejo ya existe, RTDB es el canal realtime de productos.
    // No hacemos un count() de Firestore en cada arranque: es una lectura
    // adicional innecesaria. El saneado completo se ejecuta solo cuando
    // el espejo está vacío; las escrituras normales mantienen ambos lados.

  } catch (e) {
    console.error('bootstrapProductos:', e);
  }
}

// ============================================================
// LECTURAS
// ============================================================
const loadedAll: Record<string, boolean> = {};
const cursors: Record<string, QueryDocumentSnapshot<DocumentData> | null> = {};

async function loadCollection(name: string): Promise<any[]> {
  if (!db) return [];
  const snap = await getDocs(collection(db, name));
  return snap.docs.map(d => sanitizeForFirestore(d.data())).filter(Boolean);
}

// Carga COMPLETA de una colección paginada de 500 (evita leer doc a doc en loops).
async function loadAll(name: string): Promise<void> {
  if (!db || loadedAll[name]) return;
  loadedAll[name] = true;
  const col = COLLECTIONS[name];
  if (!col) return;
  try {
    const all: any[] = [];
    let lastDoc: any = null;
    do {
      const q = lastDoc
        ? query(collection(db, col), orderBy('fecha', 'desc'), startAfter(lastDoc), limit(500))
        : query(collection(db, col), orderBy('fecha', 'desc'), limit(500));
      const snap = await getDocs(q);
      const items = snap.docs.map(d => sanitizeForFirestore(d.data())).filter(Boolean);
      all.push(...items);
      lastDoc = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
      if (snap.docs.length < 500) break;
    } while (lastDoc);
    applyPatch({ [name]: mergeById((cache as any)[name], all) });
  } catch (e) {
    console.error("Error loadAll " + name + ":", e);
    loadedAll[name] = false;
  }
}

// Carga completa "bajo demanda" (para módulos que necesitan todo: reportes, kardex, contabilidad).
// Trackea la promesa en curso para que múltiples llamadas concurrentes
// compartan la misma carga (evita que la segunda retorne "ya cargado"
// cuando en realidad la primera aún no terminó — race condition que
// causaba Reportes X/Z en $0 tras reinicio).
const loadingPromises: Record<string, Promise<void>> = {};
async function ensureLoaded(name: string): Promise<void> {
  if (loadedAll[name]) return;
  if (!db) return;
  if (loadingPromises[name]) return loadingPromises[name];
  const p = (async () => {
    loadedAll[name] = true;
    try {
      const items = await loadCollection(name);
      applyPatch({ [name]: items });
    } catch (e) {
      console.error("Error cargando " + name + ":", e);
      loadedAll[name] = false;
    } finally {
      delete loadingPromises[name];
    }
  })();
  loadingPromises[name] = p;
  return p;
}

// Garantiza que TODAS las colecciones necesarias para los Reportes X/Z
// estén cargadas antes de generar el reporte. Evita la race condition
// donde el usuario abre X/Z justo después de un reinicio y el cache
// aún no terminó de hidratarse desde Firestore (resultados en $0).
// Como cada caja filtra por SU PROPIO `fechaUltimoZ` (per-terminal), ventas y
// libroDiario se cargan COMPLETOS: una caja nunca debe perder datos porque
// otra hizo su corte Z.
async function loadReportWindow(name: string, terminalId: string, cutoff: string): Promise<void> {
  if (!db || !COLLECTIONS[name]) return;
  const key = `report:${name}:${terminalId}:${cutoff}`;
  if (SINCE_STAMP[key] === 'done') return;

  try {
    const filters: any[] = [where('fecha', '>', cutoff)];
    if (name === 'ventas' || name === 'libroDiario') {
      filters.push(where('terminalId', '==', terminalId));
    }

    // Carga por páginas para no truncar un reporte si una caja supera 1000
    // operaciones desde su último Z. Cada página sigue siendo una consulta
    // acotada al período/terminal; no se descarga el histórico completo.
    let cursor: QueryDocumentSnapshot | null = null;
    let total = 0;
    while (true) {
      const pageQuery = cursor
        ? query(
            collection(db, COLLECTIONS[name]),
            ...filters,
            orderBy('fecha', 'asc'),
            startAfter(cursor),
            limit(1000)
          )
        : query(
            collection(db, COLLECTIONS[name]),
            ...filters,
            orderBy('fecha', 'asc'),
            limit(1000)
          );

      let snap;
      try {
        snap = await getDocs(pageQuery);
      } catch (e: any) {
        // Si el índice compuesto aún no fue desplegado en Firebase, no bloqueamos
        // Reporte X/Z. Reintentamos la misma ventana solo por fecha y filtramos
        // la terminal en memoria. Este camino es de contingencia; cuando el índice
        // existe, la consulta optimizada anterior sigue siendo la utilizada.
        if (e?.code !== 'failed-precondition' || name === 'devoluciones') throw e;
        const fallbackFilters: any[] = [where('fecha', '>', cutoff)];
        const fallbackQuery = cursor
          ? query(collection(db, COLLECTIONS[name]), ...fallbackFilters, orderBy('fecha', 'asc'), startAfter(cursor), limit(1000))
          : query(collection(db, COLLECTIONS[name]), ...fallbackFilters, orderBy('fecha', 'asc'), limit(1000));
        snap = await getDocs(fallbackQuery);
      }
      const items = snap.docs
        .map(d => sanitizeForFirestore(d.data()))
        .filter(Boolean)
        .filter((item: any) => name !== 'ventas' && name !== 'libroDiario' || String(item.terminalId || '') === terminalId);
      if (items.length) {
        applyPatch({ [name]: mergeById((cache as any)[name], items) });
        total += items.length;
      }

      if (snap.docs.length < 1000) break;
      cursor = snap.docs[snap.docs.length - 1];
    }

    SINCE_STAMP[key] = 'done';
    console.info("[db-store] Ventana de reporte cargada:", name, total, "registros");
  } catch (e) {
    console.error("Error cargando ventana de reporte " + name + ":", e);
    throw e;
  }
}

// Reportes X/Z solo necesitan el período posterior al último Z de ESTA caja.
// No tiene sentido descargar ventas/libroDiario históricos de todas las cajas.
async function ensureReportData(terminalId?: string, cutoff?: string): Promise<void> {
  if (!db) return;

  const termId = String(terminalId || 'GLOBAL');
  const desde = String(cutoff || '');

  // Si no tenemos terminal/corte (casos administrativos), conservamos el
  // comportamiento seguro anterior.
  if (!terminalId || !cutoff) {
    await Promise.all([
      ensureLoaded('ventas'),
      ensureLoaded('devoluciones'),
      ensureLoaded('libroDiario'),
    ]);
    return;
  }

  await Promise.all([
    loadReportWindow('ventas', termId, desde),
    loadReportWindow('devoluciones', termId, desde),
    loadReportWindow('libroDiario', termId, desde),
  ]);
}

async function ensureReportRange(name: string, desde: string, hasta: string, terminalId = 'all'): Promise<void> {
  if (!db || !COLLECTIONS[name] || !desde || !hasta) return;

  const start = String(desde) + 'T00:00:00.000';
  const endDate = new Date(String(hasta) + 'T00:00:00.000');
  endDate.setDate(endDate.getDate() + 1);
  const end = endDate.toISOString().slice(0, 23);
  const key = `report-range:${name}:${terminalId}:${desde}:${hasta}`;
  if (SINCE_STAMP[key] === 'done') return;

  try {
    const filters: any[] = [
      where('fecha', '>=', start),
      where('fecha', '<', end),
    ];
    if (terminalId !== 'all') {
      filters.push(where('terminalId', '==', terminalId));
    }

    let cursor: QueryDocumentSnapshot | null = null;
    while (true) {
      const q = cursor
        ? query(collection(db, COLLECTIONS[name]), ...filters, orderBy('fecha', 'asc'), startAfter(cursor), limit(1000))
        : query(collection(db, COLLECTIONS[name]), ...filters, orderBy('fecha', 'asc'), limit(1000));
      const snap = await getDocs(q);
      const items = snap.docs.map(d => sanitizeForFirestore(d.data())).filter(Boolean);
      if (items.length) applyPatch({ [name]: mergeById((cache as any)[name], items) });
      if (snap.docs.length < 1000) break;
      cursor = snap.docs[snap.docs.length - 1];
    }

    SINCE_STAMP[key] = 'done';
  } catch (e) {
    console.error("Error cargando rango de reporte " + name + ":", e);
    throw e;
  }
}

// Siguiente página (10) de una colección ordenada por fecha desc (listas históricas).
async function loadMore(name: string, pageSize: number = PAGE_SIZE): Promise<number> {
  const col = COLLECTIONS[name];
  if (!col || !db) return 0;
  try {
    const last = cursors[name] || null;
    const q = last
      ? query(collection(db, col), orderBy('fecha', 'desc'), startAfter(last), limit(pageSize))
      : query(collection(db, col), orderBy('fecha', 'desc'), limit(pageSize));
    const snap = await getDocs(q);
    const items = snap.docs.map(d => sanitizeForFirestore(d.data())).filter(Boolean);
    cursors[name] = snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null;
    applyPatch({ [name]: mergeById((cache as any)[name], items) });
    return items.length;
  } catch (e) {
    console.error("loadMore " + name + ":", e);
    return 0;
  }
}

const SINCE_STAMP: Record<string, string> = {};

// Kardex de un producto (where + orden). Si falta el índice compuesto, carga y filtra en memoria.
async function kardex(productoId: string, max = 100): Promise<any[]> {
  if (!db) return [];
  try {
    const snap = await getDocs(query(
      collection(db, 'movimientos'),
      where('productoId', '==', productoId),
      orderBy('fecha', 'desc'),
      limit(max)
    ));
    return snap.docs.map(d => sanitizeForFirestore(d.data())).filter(Boolean);
  } catch (e: any) {
    if (e?.code === 'failed-precondition' || /index/i.test(String(e?.message || ''))) {
      await ensureLoaded('movimientos');
      return (cache.movimientos || [])
        .filter(m => m.productoId === productoId)
        .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
        .slice(0, max);
    }
    throw e;
  }
}

function readCatalogCacheMeta(): { ready: boolean; version: string } {
  if (typeof window === 'undefined') return { ready: false, version: '' };
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_META_KEY);
    if (!raw) return { ready: false, version: '' };
    const parsed = JSON.parse(raw);
    return {
      ready: parsed?.ready === true,
      version: String(parsed?.version || '')
    };
  } catch {
    return { ready: false, version: '' };
  }
}

function writeCatalogCacheMeta(version: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CATALOG_CACHE_META_KEY, JSON.stringify({
      ready: true,
      version: String(version || ''),
      updatedAt: Date.now()
    }));
  } catch {
    // La caché principal sigue funcionando aunque localStorage no esté disponible.
  }
}

async function loadCatalogs(force = false, version = ''): Promise<void> {
  if (!db) return;

  const meta = readCatalogCacheMeta();
  if (!force && meta.ready && (!version || meta.version === version)) return;

  const entries = Object.entries(CATALOG_FIELDS);
  const results = await Promise.all(entries.map(async ([field, catName]) => {
    try {
      const snap = await getDoc(doc(db, CATALOGOS_COLLECTION, catName));
      return [field, snap.exists() ? (snap.data().lista || []) : []] as const;
    } catch (e) {
      console.warn("Catálogo " + catName + ":", e);
      return null;
    }
  }));

  const patch: any = {};
  results.forEach(result => {
    if (result) patch[result[0]] = result[1];
  });

  if (Object.keys(patch).length > 0) applyPatch(patch);
  writeCatalogCacheMeta(version || meta.version);
}

// ============================================================
// INICIALIZACIÓN DE LISTENERS
// ============================================================
let started = false;
let teardownFns: (() => void)[] = [];
const masterSyncFns: Record<string, () => void> = {};
const terminalSyncFns: Record<string, () => void> = {};

function stopTerminalSync(): void {
  for (const key of ['main', 'sales']) {
    const unsub = terminalSyncFns[key];
    if (unsub) {
      try { unsub(); } catch (e) { console.error(e); }
      delete terminalSyncFns[key];
    }
  }
}

function startTerminalSync(terminalId?: string, all = false, initialItems: Terminal[] = []): () => void {
  if (!db || typeof window === 'undefined') return () => {};
  stopTerminalSync();

  if (initialItems.length > 0) {
    applyPatch({ terminales: mergeById((cache as any).terminales, initialItems) });
  }

  const target = all
    ? collection(db, COLLECTIONS.terminales)
    : (terminalId ? doc(db, COLLECTIONS.terminales, terminalId) : null);

  if (!target) return () => {};

  const unsub = onSnapshot(
    target as any,
    (snap: any) => {
      if (all) {
        const items = snap.docs.map((d: any) => sanitizeForFirestore(d.data())).filter(Boolean);
        applyPatch({ terminales: items });
      } else if (snap.exists()) {
        const item = sanitizeForFirestore(snap.data());
        const id = String(item?.id || snap.id);
        applyPatch({ terminales: mergeById((cache as any).terminales, [{ ...item, id }]) });
      }
    },
    (err: any) => {
      if (err?.code !== 'permission-denied') console.warn("Sync terminal:", err);
    }
  );
  terminalSyncFns.main = unsub;

  // Historial operativo del POS: para un cajero cargamos las ventas de SU caja,
  // no solo las últimas 50 ventas globales. Así un reinicio no puede dejar la
  // pantalla mostrando únicamente operaciones antiguas de otra jornada/caja.
  // Se usa solo un filtro de igualdad para evitar depender de un índice compuesto;
  // el orden se hace en memoria.
  const salesQuery = all
    ? query(collection(db, COLLECTIONS.ventas), limit(500))
    : (terminalId
      ? query(collection(db, COLLECTIONS.ventas), where('terminalId', '==', terminalId), limit(500))
      : null);

  if (salesQuery) {
    const salesUnsub = onSnapshot(
      salesQuery,
      (snap: any) => {
        const items = snap.docs
          .map((d: any) => sanitizeForFirestore({ ...d.data(), id: d.data()?.id || d.id }))
          .filter(Boolean)
          .sort((a: any, b: any) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
        applyPatch({ ventas: items });
      },
      (err: any) => {
        if (err?.code !== 'permission-denied') console.warn("Sync ventas terminal:", err);
      }
    );
    terminalSyncFns.sales = salesUnsub;
  }

  return stopTerminalSync;
}



function stopMasterSync(name: string): void {
  const unsub = masterSyncFns[name];
  if (unsub) {
    try { unsub(); } catch (e) { console.error(e); }
    delete masterSyncFns[name];
  }
  // Al cerrar el listener ya no podemos considerar esta colección como
  // completamente hidratada por realtime. Si un módulo pide el histórico
  // después, ensureLoaded() volverá a consultarlo solo cuando sea necesario.
  if (name === 'clientes' || name === 'proveedores') {
    loadedAll[name] = false;
  }
}

function startMasterSync(name: string): () => void {
  if (!db || typeof window === 'undefined') return () => {};
  if (!COLLECTIONS[name]) return () => {};
  if (masterSyncFns[name]) return () => stopMasterSync(name);

  const col = COLLECTIONS[name];
  const unsub = onSnapshot(
    collection(db, col),
    (snap) => {
      const items = snap.docs
        .map(d => sanitizeForFirestore(d.data()))
        .filter(Boolean);
      applyPatch({ [name]: items });

      // Este snapshot ya contiene la colección completa. Marcarla como
      // hidratada evita que ensureReportData()/ensureLoaded() dispare una
      // segunda lectura completa mientras el listener está activo.
      if (name === 'clientes' || name === 'proveedores') {
        loadedAll[name] = true;
      }
    },
    (err) => {
      if (err.code !== 'permission-denied') console.warn("Sync maestro " + name + ":", err);
    }
  );
  masterSyncFns[name] = unsub;
  return () => stopMasterSync(name);
}

// Ajusta los listeners maestros al módulo activo sin reiniciarlos cuando
// el nuevo módulo sigue necesitando la misma colección. Así, por ejemplo,
// Dashboard → Ventas → CxC mantiene un único listener de clientes durante
// toda la navegación y evita repetir el snapshot inicial completo.
function syncMasterSync(names: string[]): void {
  const wanted = new Set(names.filter(name => !!COLLECTIONS[name]));
  Object.keys(masterSyncFns).forEach(name => {
    if (!wanted.has(name)) stopMasterSync(name);
  });
  wanted.forEach(name => {
    if (!masterSyncFns[name]) startMasterSync(name);
  });
}

function cleanup() {
  teardownFns.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  teardownFns = [];
  Object.keys(masterSyncFns).forEach(stopMasterSync);
  stopTerminalSync();
  started = false;
  Object.keys(loadedAll).forEach(k => { loadedAll[k] = false; });
  Object.keys(cursors).forEach(k => { cursors[k] = null; });
}

function init() {
  if (started) return;
  started = true;
  if (!db || typeof window === 'undefined') return;

  // 1) CONFIG (doc pequeño, en vivo)
  teardownFns.push(onSnapshot(doc(db, CONFIG_COLLECTION, CONFIG_DOC_ID), (snap) => {
    if (!snap.exists()) return;
    const val = snap.data();
    const patch: any = {};
    for (const f of CONFIG_FIELDS) {
      if (val[f] !== undefined) patch[f] = sanitizeForFirestore(val[f]);
    }
    if (Object.keys(patch).length > 0) applyPatch(patch);

    // Los catálogos son relativamente estáticos. Solo se vuelven a leer cuando
    // su versión cambió en config/general, o cuando esta caja aún no tiene caché.
    const remoteCatalogVersion = String(val.catalogosVersion || '');
    const catalogMeta = readCatalogCacheMeta();
    if (!catalogMeta.ready || (remoteCatalogVersion && catalogMeta.version !== remoteCatalogVersion)) {
      void loadCatalogs(true, remoteCatalogVersion);
    }
  }, (err) => { if (err.code !== 'permission-denied') console.warn("Sync config:", err); }));

  // 2) PRODUCTOS (tiempo real vía RTDB: el espejo evita re-leer la colección en cada venta).
  bootstrapProductos();
  if (rtdb) {
    teardownFns.push(onValue(ref(rtdb, RTDB_PRODUCTS_PATH), (snap) => {
      const val = snap.val() || {};
      const items = Object.values(val).filter(Boolean);
      // El espejo RTDB representa el estado completo de productos.
      // Reemplazamos el cache, no hacemos merge, para que una eliminación
      // remota tampoco pueda dejar un producto fantasma en esta caja.
      applyPatch({ productos: items });
    }, (err) => { if (err?.code !== 'permission-denied') console.warn("RTDB productos:", err); }));
  }

  // 3) LISTAS VIVAS ENTRE CAJAS.
  // CxC/CxP: el POS solo necesita deuda ACTIVA en tiempo real. Mantener
  // miles de deudas ya pagadas conectadas en cada terminal genera lecturas
  // iniciales innecesarias. El histórico completo se hidrata únicamente
  // cuando se entra al módulo que lo necesita.
  for (const name of ['cxc', 'cxp']) {
    const col = COLLECTIONS[name];
    teardownFns.push(onSnapshot(
      query(collection(db, col), where('estado', 'in', ['pendiente', 'parcial'])),
      (snap) => {
        const currentArr = [...((cache as any)[name] || [])];
        const map = new Map<string, any>(currentArr.map(x => [String(x.id), x]));
        snap.docChanges().forEach(change => {
          const item = sanitizeForFirestore(change.doc.data());
          const id = String(item?.id || change.doc.id);
          if (change.type === 'removed') {
            // Si dejó de pertenecer al conjunto activo porque pasó a pagada,
            // conservamos el histórico ya hidratado. Si realmente fue
            // eliminado y seguía activa, sí retiramos el documento.
            if (item && String(item.estado || '') !== 'pagada') map.delete(id);
          } else if (item) map.set(id, item);
        });
        applyPatch({ [name]: [...map.values()] });
      },
      (err) => { if (err.code !== 'permission-denied') console.warn("Sync " + name + ":", err); }
    ));
  }

  // Clientes/proveedores se sincronizan solo mientras el módulo que los necesita está abierto.
  // Así evitamos descargar y mantener dos colecciones maestras completas en cada caja
  // durante toda la jornada cuando el operador está trabajando en otro módulo.

  // Terminales: el listener se activa bajo demanda.
  // Un cajero escucha solo SU terminal; administradores pueden activar el
  // listado completo cuando necesitan gestionar las cajas.
  // Históricos de auditoría: solo mantenemos una ventana reciente en realtime.
  // El histórico completo se carga bajo demanda al abrir el módulo correspondiente.
  for (const name of ['devoluciones', 'anulaciones', 'reportesZ']) {
    const col = COLLECTIONS[name];
    teardownFns.push(onSnapshot(
      query(collection(db, col), orderBy('fecha', 'desc'), limit(100)),
      (snap) => {
        const currentArr = [...((cache as any)[name] || [])];
        const map = new Map<string, any>(currentArr.map(x => [String(x.id), x]));
        snap.docChanges().forEach(change => {
          const item = sanitizeForFirestore(change.doc.data());
          if (!item || !item.id) return;
          if (change.type === 'removed') map.delete(String(item.id));
          else map.set(String(item.id), item);
        });
        applyPatch({ [name]: [...map.values()] });
      },
      (err) => { if (err.code !== 'permission-denied') console.warn("Sync " + name + ":", err); }
    ));
  }

  // Históricos operativos: mantenemos la ventana de últimas 50 para no
  // convertir cada movimiento de una caja en una lectura completa.
  for (const name of ['movimientos']) {
    const col = COLLECTIONS[name];
    teardownFns.push(onSnapshot(
      query(collection(db, col), orderBy('fecha', 'desc'), limit(50)),
      (snap) => {
        const currentArr = [...((cache as any)[name] || [])];
        const map = new Map<string, any>(currentArr.map(x => [String(x.id), x]));
        snap.docChanges().forEach(change => {
          const item = sanitizeForFirestore(change.doc.data());
          if (!item || !item.id) return;
          if (change.type === 'removed') map.delete(String(item.id));
          else map.set(String(item.id), item);
        });
        applyPatch({ [name]: [...map.values()] });
      },
      (err) => { if (err.code !== 'permission-denied') console.warn("Sync " + name + ":", err); }
    ));
  }

  // 4) CARGA INICIAL: listas pequeñas completas + ventas/libroDiario COMPLETOS
  //    (cada caja filtra por su propio corte Z, así que ninguna puede perder datos
  //    porque otra caja cierre el suyo). El resto del histórico se carga bajo
  //    demanda cuando se abre el módulo que lo necesita.
  // Los listeners ya entregan el snapshot inicial de estas colecciones.
  // No hacemos un getDocs() inmediatamente después: sería una segunda lectura
  // de los mismos documentos al arrancar. Los históricos se cargan bajo demanda
  // cuando el módulo correspondiente los necesita.


  // 5) CATÁLOGOS
  // Se hidratan desde la caché local. Si config/general detecta una versión
  // nueva, el listener anterior ejecuta loadCatalogs() de forma controlada.
}

// ============================================================
// API PÚBLICA
// ============================================================
async function getSaleById(saleId: string): Promise<any | null> {
  if (!saleId) return null;
  const id = String(saleId);
  const cached = (cache.ventas || []).find((v: any) => String(v?.id || '') === id);
  if (cached) return sanitizeForFirestore(cached);
  if (!db) return null;
  try {
    const snap = await getDoc(doc(db, 'ventas', id));
    return snap.exists() ? sanitizeForFirestore({ ...snap.data(), id }) : null;
  } catch (e) {
    console.error('Error leyendo venta puntual:', e);
    throw e;
  }
}

export const Store = {
  applyInventoryMovementsTransaction,
  subscribe(callback: (state: Partial<AppState>) => void): () => void {
    listeners.add(callback);
    init();
    callback(Store.get());
    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) cleanup();
    };
  },

  get(): AppState {
    if (typeof window === 'undefined') return initialState;
    return { ...cache } as AppState;
  },

  /**
   * Aplica un abono sobre la deuda REAL de Firestore.
   * La deuda y sus efectos contables se escriben en una sola transacción,
   * evitando que dos cajas trabajen sobre el mismo saldo antiguo.
   */
  async processReturnOrCancellationTransaction(params: { operationId: string; operationType: 'DEVOLUCION' | 'ANULACION'; saleId: string; operationDoc: any; movements: any[]; journal?: any; refundItems?: any[]; fullCancellation?: boolean; fromOfflineQueue?: boolean; }): Promise<any> {
    if (!db) return null;
    const { operationId, operationType, saleId, operationDoc, movements, journal, refundItems = [], fullCancellation = false } = params;
    if (!params.fromOfflineQueue && typeof window !== 'undefined' && navigator.onLine === false) {
      enqueueOfflineOperation(operationType, { ...params }, operationId);
      return { queuedOffline: true, operationId };
    }
    let result: any = null;
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, operationType, operationId);
      const saleRef = doc(db, 'ventas', String(saleId));
      const saleSnap = await tx.get(saleRef);
      if (!saleSnap.exists()) throw new Error('La venta ya no existe en Firestore.');
      const sale = { ...sanitizeForFirestore(saleSnap.data()), id: String(saleId) } as any;
      if (operationType === 'ANULACION' && String(sale.estado || '') === 'anulada') throw new Error('La factura ya fue anulada.');
      const productIds = [...new Set((movements || []).map((m:any) => String(m.productoId || '')).filter(Boolean))];
      const products = new Map<string, any>();
      for (const pid of productIds) { const s = await tx.get(doc(db,'productos',pid)); if (!s.exists()) throw new Error('Un producto de la operación ya no existe en Firestore.'); products.set(pid,{...sanitizeForFirestore(s.data()),id:pid}); }
      const journalRef = journal ? doc(db,'libroDiario',String(journal.id)) : null;
      if (journalRef) { const js = await tx.get(journalRef); if (js.exists()) throw new Error('El asiento contable de esta operación ya existe.'); }
      const terminalId = String(operationDoc.terminalId || '');
      const terminalRef = terminalId ? doc(db,'terminales',terminalId) : null;
      const terminalSnap = terminalRef ? await tx.get(terminalRef) : null;
      if (terminalId && !terminalSnap?.exists()) throw new Error('La terminal de la operación ya no existe.');
      const terminalRemote = terminalSnap?.exists() ? sanitizeForFirestore(terminalSnap.data()) as any : null;
      const counterField = operationType === 'DEVOLUCION' ? 'proximaDevolucion' : 'proximaAnulacion';
      const label = operationType === 'DEVOLUCION' ? 'DEV' : 'ANU';
      const nextCounter = Number(terminalRemote?.[counterField]) || 1;
      const canonicalId = terminalRemote
        ? terminalSeries(terminalPrefix(terminalRemote, terminalId), label, nextCounter, 6)
        : terminalSeries('GLOBAL', label, Date.now(), 6);
      const canonicalOperationDoc = sanitizeForFirestore({ ...operationDoc, id: canonicalId, terminalId: terminalId || operationDoc.terminalId, terminalName: terminalRemote?.nombre || operationDoc.terminalName });
      const existingRef = doc(db, operationType === 'DEVOLUCION' ? 'devoluciones' : 'anulaciones', canonicalId);
      const existingOp = await tx.get(existingRef); if (existingOp.exists()) throw new Error('Esta operación ya fue registrada.');
      if ((movements?.length || 0) + productIds.length + 6 > 450) throw new Error('La operación contiene demasiados movimientos.');
      for (const m of movements || []) {
        const pid = String(m.productoId); const p = products.get(pid); const before = Number(p.stock)||0; const after = before + (Number(m.cantidad)||0);
        const mr = doc(db,'movimientos',String(m.id || Store.uid()));
        tx.set(mr,sanitizeForFirestore({...m,productoId:pid,stockAntes:before,stockDespues:after,id:mr.id}),{merge:false});
        products.set(pid,{...p,stock:after});
      }
      for (const [pid,p] of products) tx.set(doc(db,'productos',pid),sanitizeForFirestore(p),{merge:true});
      tx.set(existingRef, canonicalOperationDoc, {merge:false});
      tx.set(saleRef,sanitizeForFirestore({...sale,estado: operationType === 'ANULACION' ? 'anulada' : 'parcialmente_devuelta'}),{merge:true});
      if (journalRef && journal) tx.set(journalRef,sanitizeForFirestore({ ...journal, referencia: canonicalId, terminalId: terminalId || journal.terminalId, terminalName: terminalRemote?.nombre || journal.terminalName }),{merge:false});
      if (terminalRef && terminalRemote) tx.set(terminalRef, {[counterField]: nextCounter + 1}, {merge:true});
      tx.set(operationRef,{tipo:operationType,operationId,fecha:String(canonicalOperationDoc.fecha||Utils.ahora()),referencia:String(canonicalId),terminalId:terminalId||'GLOBAL'},{merge:false});
      result={operationId,operationType,receiptId:canonicalId,operationDoc:canonicalOperationDoc,products:[...products.values()],terminal: terminalRef ? {...terminalRemote,id:terminalId,[counterField]:nextCounter+1} : null};
    });
    if (result?.products?.length) await syncProductosRTDB([],result.products);
    return result;
  },

  async applyGlobalProviderPaymentTransaction(params: {
    operationId?: string;
    provider: string;
    amountUSD: number;
    amountBS?: number;
    payment: any;
    journal?: any;
    terminalId?: string;
  }): Promise<{ appliedUSD: number; debts: any[]; receiptId?: string }> {
    if (typeof window === 'undefined' || !db) return { appliedUSD: 0, debts: [] };
    const { operationId, provider, amountUSD, payment, journal, terminalId } = params;
    if (!(amountUSD > 0)) return { appliedUSD: 0, debts: [] };

    const q = query(collection(db, 'cxp'), where('proveedor', '==', provider));
    let result = { appliedUSD: 0, debts: [] as any[] };
    const opId = String(operationId || payment?.id || (provider + '|' + amountUSD + '|' + payment?.fecha + '|' + payment?.metodo));
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'PAGO-CXP-GLOBAL', opId);
      const terminalRef = terminalId ? doc(db, 'terminales', terminalId) : null;
      const terminalSnap = terminalRef ? await tx.get(terminalRef) : null;
      const terminalRemote = terminalSnap?.exists() ? sanitizeForFirestore(terminalSnap.data()) as any : null;
      if (terminalId && !terminalRemote) throw new Error('La caja/terminal ya no existe en Firestore.');
      // IMPORTANTE: Firestore puede reintentar esta función completa si detecta
      // concurrencia. Todo el resultado se reconstruye en cada intento para no
      // duplicar appliedUSD/debts en memoria.
      const nextResult = { appliedUSD: 0, debts: [] as any[], receiptId: '' as string };
      const nextCounter = Number(terminalRemote?.proximoPagoProveedor) || 1;
      nextResult.receiptId = terminalRemote
        ? terminalSeries(terminalPrefix(terminalRemote, terminalId), 'CXP', nextCounter, 6)
        : terminalSeries('GLOBAL', 'CXP', Date.now(), 6);
      const snap = await tx.get(q);

      const docs = snap.docs
        .map(d => ({ ref: d.ref, data: sanitizeForFirestore(d.data()) as any }))
        .filter(x => (Number(x.data.saldoUSD) || 0) > 0.001 && x.data.estado !== 'pagada')
        .sort((a, b) => {
          const fecha = String(a.data.fecha || '').localeCompare(String(b.data.fecha || ''));
          return fecha !== 0 ? fecha : String(a.data.id || '').localeCompare(String(b.data.id || ''));
        });

      let remanente = amountUSD;

      for (const item of docs) {
        if (remanente <= 0.001) break;

        const saldo = Number(item.data.saldoUSD) || 0;
        const pago = Math.min(saldo, remanente);
        if (pago <= 0.001) continue;

        remanente = Math.max(0, remanente - pago);

        const historial = Array.isArray(item.data.historialPagos) ? [...item.data.historialPagos] : [];
        const pagoHistorial = sanitizeForFirestore({
          ...payment,
          id: nextResult.receiptId,
          reciboId: nextResult.receiptId,
          terminalId: terminalId || payment?.terminalId,
          // El mismo pago global puede liquidar varias facturas, pero cada
          // entrada conserva exactamente lo aplicado a esa factura.
          montoUSD: pago,
          montoBS: pago * (Number(payment.tasaAplicada) || 1)
        });
        historial.push(pagoHistorial);

        const nuevoSaldo = Math.max(0, saldo - pago);
        const updated = {
          ...item.data,
          abonadoUSD: (Number(item.data.abonadoUSD) || 0) + pago,
          saldoUSD: nuevoSaldo,
          estado: nuevoSaldo <= 0.001 ? 'pagada' : 'parcial',
          historialPagos: historial
        };

        tx.set(item.ref, sanitizeForFirestore(updated), { merge: true });
        nextResult.debts.push({ ...updated, appliedUSD: pago });
        nextResult.appliedUSD += pago;
      }

      if (nextResult.appliedUSD <= 0.001) {
        throw new Error('No hay saldo pendiente del proveedor para registrar este pago.');
      }

      if (journal?.id) {
        tx.set(
          doc(db, 'libroDiario', journal.id),
          sanitizeForFirestore({ ...journal, montoUSD: nextResult.appliedUSD, referencia: nextResult.receiptId, terminalId: terminalId || journal.terminalId, terminalName: terminalRemote?.nombre || journal.terminalName }),
          { merge: true }
        );
      }
      if (terminalRef && terminalRemote) tx.set(terminalRef, { proximoPagoProveedor: nextCounter + 1 }, { merge: true });

      tx.set(operationRef, { tipo: 'PAGO-CXP-GLOBAL', operationId: opId, fecha: payment?.fecha || new Date().toISOString(), referencia: nextResult.receiptId, terminalId: terminalId || 'GLOBAL' }, { merge: false });
      result = nextResult;
    });

    // CxP se actualiza exclusivamente por el snapshot completo autoritativo.
    if (journal?.id) applyPatch({ libroDiario: mergeById(cache.libroDiario, [{ ...journal, montoUSD: result.appliedUSD, referencia: result.receiptId, terminalId: terminalId || journal.terminalId }]) });

    return result;
  },

  async applyGlobalCustomerPaymentTransaction(params: {
    operationId?: string;
    customerName: string;
    customerCedula?: string;
    amountUSD: number;
    amountBS?: number;
    payment: any;
    journal?: any;
    terminalId?: string;
  }): Promise<{ appliedUSD: number; appliedBS: number; debts: any[]; receiptId?: string }> {
    if (typeof window === 'undefined' || !db) return { appliedUSD: 0, appliedBS: 0, debts: [] };
    const { operationId, customerName, customerCedula, amountUSD, amountBS, payment, journal, terminalId } = params;
    if (!(amountUSD > 0)) return { appliedUSD: 0, appliedBS: 0, debts: [] };

    const customerLabel = customerCedula ? `${customerName} [${customerCedula}]` : customerName;
    const q = query(collection(db, 'cxc'), where('cliente', '==', customerLabel));
    let result = { appliedUSD: 0, appliedBS: 0, debts: [] as any[], receiptId: '' as string };
    const opId = String(operationId || payment?.id || ('CXC-GLOBAL|' + customerLabel + '|' + amountUSD + '|' + payment?.fecha + '|' + payment?.metodo));

    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'PAGO-CXC-GLOBAL', opId);
      const terminalRef = terminalId ? doc(db, 'terminales', terminalId) : null;
      const terminalSnap = terminalRef ? await tx.get(terminalRef) : null;
      const terminalRemote = terminalSnap?.exists() ? sanitizeForFirestore(terminalSnap.data()) as any : null;
      if (terminalId && !terminalRemote) throw new Error('La caja/terminal ya no existe en Firestore.');

      const nextResult = { appliedUSD: 0, appliedBS: 0, debts: [] as any[], receiptId: '' as string };
      const nextCounter = Number(terminalRemote?.proximoCobroDeuda) || 1;
      nextResult.receiptId = terminalRemote
        ? terminalSeries(terminalPrefix(terminalRemote, terminalId), 'CXC', nextCounter, 6)
        : terminalSeries('GLOBAL', 'CXC', Date.now(), 6);

      const snap = await tx.get(q);
      const docs = snap.docs
        .map(d => ({ ref: d.ref, data: sanitizeForFirestore(d.data()) as any }))
        .filter(x => (Number(x.data.saldoUSD) || 0) > 0.001 && x.data.estado !== 'pagada')
        .sort((a, b) => {
          const fecha = String(a.data.fecha || '').localeCompare(String(b.data.fecha || ''));
          return fecha !== 0 ? fecha : String(a.data.id || '').localeCompare(String(b.data.id || ''));
        });

      let remanenteUSD = amountUSD;
      let remanenteBS = Number(amountBS) > 0 ? Number(amountBS) : amountUSD * (Number(payment?.tasaAplicada) || Number(Store.get().tasa) || 0);
      const tasaAplicada = Number(payment?.tasaAplicada) || Number(Store.get().tasa) || 0;

      for (const item of docs) {
        if (remanenteUSD <= 0.000001) break;
        const saldo = Number(item.data.saldoUSD) || 0;
        const pagoUSD = Math.min(saldo, remanenteUSD);
        if (pagoUSD <= 0) continue;

        const pagoBS = Math.min(remanenteBS, pagoUSD * tasaAplicada);
        remanenteUSD = Math.max(0, remanenteUSD - pagoUSD);
        remanenteBS = Math.max(0, remanenteBS - pagoBS);

        const historial = Array.isArray(item.data.historialPagos) ? [...item.data.historialPagos] : [];
        const pagoHistorial = sanitizeForFirestore({
          ...payment,
          id: nextResult.receiptId,
          reciboId: nextResult.receiptId,
          terminalId: terminalId || payment?.terminalId,
          montoUSD: pagoUSD,
          montoBS: pagoBS
        });
        historial.push(pagoHistorial);

        const nuevoSaldo = Math.max(0, saldo - pagoUSD);
        const updated = {
          ...item.data,
          abonadoUSD: (Number(item.data.abonadoUSD) || 0) + pagoUSD,
          saldoUSD: nuevoSaldo,
          estado: nuevoSaldo <= 0.001 ? 'pagada' : 'parcial',
          historialPagos: historial
        };

        tx.set(item.ref, sanitizeForFirestore(updated), { merge: true });
        nextResult.debts.push({ ...updated, appliedUSD: pagoUSD, appliedBS: pagoBS });
        nextResult.appliedUSD += pagoUSD;
        nextResult.appliedBS += pagoBS;
      }

      if (nextResult.appliedUSD <= 0.000001) {
        throw new Error('No hay saldo pendiente del cliente para registrar este pago.');
      }

      if (customerCedula) {
        const customersSnap = await tx.get(query(collection(db, 'clientes'), where('cedula', '==', customerCedula), limit(1)));
        if (!customersSnap.empty) {
          const customerRef = customersSnap.docs[0].ref;
          const customer = customersSnap.docs[0].data() as any;
          const customerDebt = Number(customer.debt) || 0;
          tx.set(customerRef, { debt: Math.max(0, customerDebt - nextResult.appliedUSD) }, { merge: true });
        }
      }

      if (journal?.id) {
        tx.set(
          doc(db, 'libroDiario', journal.id),
          sanitizeForFirestore({
            ...journal,
            montoUSD: nextResult.appliedUSD,
            montoBS: nextResult.appliedBS,
            referencia: nextResult.receiptId,
            terminalId: terminalId || journal.terminalId,
            terminalName: terminalRemote?.nombre || journal.terminalName
          }),
          { merge: true }
        );
      }

      if (terminalRef && terminalRemote) tx.set(terminalRef, { proximoCobroDeuda: nextCounter + 1 }, { merge: true });
      tx.set(operationRef, {
        tipo: 'PAGO-CXC-GLOBAL',
        operationId: opId,
        fecha: payment?.fecha || new Date().toISOString(),
        referencia: nextResult.receiptId,
        terminalId: terminalId || 'GLOBAL'
      }, { merge: false });

      nextResult.debts = nextResult.debts.map((d: any) => d);
      result = nextResult;
    });

    if (journal?.id) {
      applyPatch({
        libroDiario: mergeById(cache.libroDiario, [{
          ...journal,
          montoUSD: result.appliedUSD,
          montoBS: result.appliedBS,
          referencia: result.receiptId,
          terminalId: terminalId || journal.terminalId
        }])
      });
    }

    return result;
  },

  async applyDebtPaymentTransaction(params: {
    operationId?: string;
    collection: 'cxc' | 'cxp';
    debtId: string;
    amountUSD: number;
    amountBS?: number;
    payment: any;
    journal?: any | any[];
    sale?: any;
    customerCedula?: string;
    terminalId?: string;
  }): Promise<any | null> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, collection: collectionName, debtId, amountUSD, amountBS, payment, journal, sale, customerCedula, terminalId } = params;
    if (!(amountUSD > 0)) return null;
    const debtRef = doc(db, collectionName, debtId);
    let result: any = null;
    const opId = String(operationId || payment?.id || (collectionName + '|' + debtId + '|' + amountUSD + '|' + payment?.metodo + '|' + payment?.fecha));
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'PAGO-DEUDA', opId);
      const terminalRef = terminalId ? doc(db, 'terminales', terminalId) : null;
      const terminalSnap = terminalRef ? await tx.get(terminalRef) : null;
      const terminalRemote = terminalSnap?.exists() ? sanitizeForFirestore(terminalSnap.data()) as any : null;
      if (terminalId && !terminalRemote) throw new Error('La caja/terminal ya no existe en Firestore.');
      const debtSnap = await tx.get(debtRef);
      if (!debtSnap.exists()) throw new Error('La deuda ya no existe o fue eliminada en otra caja.');
      const remote = sanitizeForFirestore(debtSnap.data()) as any;
      const saldoActual = Number(remote.saldoUSD) || 0;
      if (saldoActual <= 0.001) throw new Error('La deuda ya está pagada en otra caja.');
      if (amountUSD > saldoActual + 0.001) throw new Error('El saldo cambió en otra caja. Actualice y vuelva a intentar.');
      const applied = Math.min(amountUSD, saldoActual);
      const nuevoSaldo = Math.max(0, saldoActual - applied);
      const nuevoAbonado = (Number(remote.abonadoUSD) || 0) + applied;
      const historial = Array.isArray(remote.historialPagos) ? [...remote.historialPagos] : [];
      const counterField = collectionName === 'cxc' ? 'proximoCobroDeuda' : 'proximoPagoProveedor';
      const nextCounter = Number(terminalRemote?.[counterField]) || 1;
      const receiptId = terminalRemote ? terminalSeries(terminalPrefix(terminalRemote, terminalId), collectionName === 'cxc' ? 'CXC' : 'CXP', nextCounter, 6) : terminalSeries('GLOBAL', collectionName === 'cxc' ? 'CXC' : 'CXP', Date.now(), 6);
      const appliedBS = Number(amountBS) > 0 ? Math.min(Number(amountBS), Number(payment?.montoBS) || Number(amountBS)) : (Number(payment?.montoBS) || (applied * (Number(Store.get().tasa) || 0)));
      const pago = sanitizeForFirestore({ ...payment, id: receiptId, reciboId: receiptId, terminalId: terminalId || payment?.terminalId, montoUSD: applied, montoBS: appliedBS });
      historial.push(pago);
      const updated = {
        ...remote,
        ...(collectionName === 'cxc' && customerCedula ? {} : {}),
        abonadoUSD: nuevoAbonado,
        saldoUSD: nuevoSaldo,
        estado: nuevoSaldo <= 0.001 ? 'pagada' : 'parcial',
        historialPagos: historial
      };
      let customerRef: any = null;
      let customerDebt: number | null = null;
      if (collectionName === 'cxc' && customerCedula) {
        const customersSnap = await tx.get(query(collection(db, 'clientes'), where('cedula', '==', customerCedula), limit(1)));
        if (!customersSnap.empty) {
          customerRef = customersSnap.docs[0].ref;
          const customer = customersSnap.docs[0].data() as any;
          customerDebt = Number(customer.debt) || 0;
        }
      }
      tx.set(debtRef, sanitizeForFirestore(updated), { merge: true });
      if (customerRef) tx.set(customerRef, { debt: Math.max(0, (customerDebt || 0) - applied) }, { merge: true });
      const journalItems = (Array.isArray(journal) ? journal : (journal ? [journal] : [])).map((entry: any) => entry ? sanitizeForFirestore({ ...entry, referencia: receiptId, terminalId: terminalId || entry.terminalId, terminalName: terminalRemote?.nombre || entry.terminalName }) : entry);
      journalItems.forEach((entry: any) => {
        if (entry?.id) tx.set(doc(db, 'libroDiario', entry.id), sanitizeForFirestore(entry), { merge: true });
      });
      const persistedSale = sale?.id
        ? sanitizeForFirestore({ ...sale, id: receiptId, terminalId: terminalId || sale.terminalId, terminalName: terminalRemote?.nombre || sale.terminalName })
        : null;
      if (persistedSale?.id) tx.set(doc(db, 'ventas', persistedSale.id), persistedSale, { merge: true });
      if (terminalRef && terminalRemote) {
        tx.set(terminalRef, { [counterField]: nextCounter + 1 }, { merge: true });
      }
      tx.set(operationRef, { tipo: 'PAGO-DEUDA', operationId: opId, fecha: payment?.fecha || new Date().toISOString(), referencia: debtId }, { merge: false });
      result = { ...updated, appliedUSD: applied, appliedBS, receiptId, payment: pago, journal: journalItems, sale: persistedSale, terminal: terminalRef ? { ...terminalRemote, id: terminalId, [counterField]: nextCounter + 1 } : null };
    });
    // CxC/CxP se actualizan exclusivamente por sus snapshots completos autoritativos.
    // No parcheamos aquí el resultado local: un snapshot remoto puede haber llegado
    // inmediatamente antes y el resultado de esta transacción sería una versión
    // potencialmente antigua para la UI de esta caja.
    if (result?.journal?.length) applyPatch({ libroDiario: mergeById(cache.libroDiario, result.journal) });
    if (result?.sale?.id) applyPatch({ ventas: mergeById(cache.ventas, [result.sale]) });
    if (result?.terminal?.id) applyPatch({ terminales: mergeById(cache.terminales || [], [result.terminal]) });
    return result;
  },

  async createSupplierDebtTransaction(params: {
    operationId?: string;
    debt: any;
    journal?: any;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, debt, journal } = params;
    const debtRef = doc(db, 'cxp', debt.id);
    let result: any = null;
    const opId = String(operationId || debt.id);
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'DEUDA-CXP', opId);
      const existing = await tx.get(debtRef);
      if (existing.exists()) throw new Error('La deuda de proveedor ya existe en otra caja. Actualice y vuelva a intentar.');
      tx.set(debtRef, sanitizeForFirestore(debt), { merge: false });
      if (journal?.id) tx.set(doc(db, 'libroDiario', journal.id), sanitizeForFirestore(journal), { merge: false });
      tx.set(operationRef, { tipo: 'DEUDA-CXP', operationId: opId, fecha: debt.fecha, referencia: debt.id }, { merge: false });
      result = debt;
    });
    // CxP se actualiza exclusivamente por el snapshot completo autoritativo.
    if (journal?.id) applyPatch({ libroDiario: mergeById(cache.libroDiario, [journal]) });
    return result;
  },

  async createPurchaseTransaction(params: {
    operationId?: string;
    purchase: any;
    items: any[];
    purchaseDate: string;
    purchaseDateTime: string;
    supplier: string;
    invoiceNumber: string;
    condition: 'contado' | 'credito' | 'mixto';
    exchangeRate: number;
    paidUSD: number;
    dueDate: string;
    journal?: any;
    debt?: any;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;

    const {
      operationId, purchase, items, purchaseDate, purchaseDateTime, supplier, invoiceNumber,
      condition, exchangeRate, paidUSD, dueDate, journal, debt
    } = params;

    if (!items?.length) throw new Error('La compra no contiene productos.');
    if (!invoiceNumber || !supplier) throw new Error('La compra no tiene factura/proveedor.');
    if (!(Number(exchangeRate) > 0)) throw new Error('La tasa de la compra no es válida.');

    const purchaseRef = doc(db, 'compras', purchase.id);
    const opId = String(operationId || purchase.id || (invoiceNumber + '|' + supplier + '|' + purchaseDate));
    if (typeof window !== 'undefined' && navigator.onLine === false) {
      enqueueOfflineOperation('COMPRA', { ...params, operationId: opId }, opId);
      return { queuedOffline: true, operationId: opId, purchase };
    }
    const productIds = [...new Set(items.map((i: any) => String(i.productoId || '')).filter(Boolean))];

    let result: any = null;
    let journalResult: any = null;
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'COMPRA', opId);
      // TODAS las lecturas van antes de cualquier escritura.
      const purchaseSnap = await tx.get(purchaseRef);
      if (purchaseSnap.exists()) {
        throw new Error('Esta compra ya fue registrada en Firestore. Evite duplicarla.');
      }

      const existingPurchasesSnap = await tx.get(
        query(collection(db, 'compras'), where('numeroFactura', '==', invoiceNumber))
      );
      const duplicatePurchase = existingPurchasesSnap.docs.find(d => {
        const x = d.data() as any;
        return String(x.proveedor || '').trim() === supplier &&
          (!purchaseDate || String(x.fecha || '').slice(0, 10) === String(purchaseDate).slice(0, 10));
      });
      if (duplicatePurchase) {
        throw new Error('Ya existe una compra con la misma factura, proveedor y fecha en otra caja.');
      }

      const existingDebtsSnap = await tx.get(
        query(collection(db, 'cxp'), where('numeroFactura', '==', invoiceNumber))
      );
      const duplicateDebt = existingDebtsSnap.docs.find(d => {
        const x = d.data() as any;
        return String(x.proveedor || '').trim() === supplier &&
          (!purchaseDate || String(x.fecha || '').slice(0, 10) === String(purchaseDate).slice(0, 10));
      });
      if (duplicateDebt) {
        throw new Error('Ya existe una cuenta por pagar para esta factura y proveedor.');
      }

      const remoteProducts = new Map<string, any>();
      const movementDocsByProduct = new Map<string, any[]>();

      for (const pid of productIds) {
        const productSnap = await tx.get(doc(db, 'productos', pid));
        if (!productSnap.exists()) {
          throw new Error('El producto ' + pid + ' ya no existe en Firestore. Actualice el inventario.');
        }
        remoteProducts.set(pid, { ...sanitizeForFirestore(productSnap.data()), id: pid });

        // Optimización: una compra normalmente se agrega al final del kardex.
        // Primero consultamos solo el último movimiento. Solo si la compra está
        // fechada antes (o exactamente en la misma marca de tiempo) descargamos
        // el historial completo para reconstruir stockAntes/stockDespues.
        const latestSnap = await tx.get(query(
          collection(db, 'movimientos'),
          where('productoId', '==', pid),
          orderBy('fecha', 'desc'),
          limit(1)
        ));
        const latestFecha = latestSnap.empty ? '' : String((latestSnap.docs[0].data() as any).fecha || '');
        if (!latestFecha || String(purchaseDateTime) > latestFecha) {
          movementDocsByProduct.set(pid, []);
        } else {
          const movementSnap = await tx.get(
            query(collection(db, 'movimientos'), where('productoId', '==', pid))
          );
          movementDocsByProduct.set(pid, movementSnap.docs.map(d => ({
            id: d.id,
            ref: d.ref,
            data: sanitizeForFirestore(d.data()) as any
          })));
        }
      }

      const writesForProducts = productIds.length;
      const writesForNewMovements = items.length;
      const writesForHistoricalMovements = [...movementDocsByProduct.values()]
        .reduce((n, docs) => n + docs.length, 0);
      const writesForDebt = debt?.id ? 1 : 0;
      const writesForJournal = journal?.id ? 1 : 0;
      const writesPlanned = 2 + writesForProducts + writesForNewMovements +
        writesForHistoricalMovements + writesForDebt + writesForJournal;

      // Dejamos margen respecto al límite duro de 500 escrituras.
      if (writesPlanned > 450) {
        throw new Error('La compra tiene demasiados movimientos históricos para registrarla en una sola transacción. Debe procesarse/revisarse antes de continuar.');
      }

      const itemsByProduct = new Map<string, any>();
      for (const item of items) {
        const pid = String(item.productoId);
        const prev = itemsByProduct.get(pid);
        itemsByProduct.set(pid, prev ? {
          ...prev,
          cantidad: (Number(prev.cantidad) || 0) + (Number(item.cantidad) || 0),
          subtotalUSD: (Number(prev.subtotalUSD) || 0) + (Number(item.subtotalUSD) || 0)
        } : { ...item });
      }

      // Calculamos el kardex completo de cada producto con el estado REMOTO.
      // Así una compra registrada desde otra caja no parte del stock viejo de esta terminal.
      const finalMovementsByProduct = new Map<string, any[]>();
      const finalProducts = new Map<string, any>();

      for (const pid of productIds) {
        const product = remoteProducts.get(pid);
        const incoming = itemsByProduct.get(pid);
        const existing = [...(movementDocsByProduct.get(pid) || [])]
          .sort((a, b) => String(a.data.fecha || '').localeCompare(String(b.data.fecha || '')));

        const baseExisting = existing.find(m => String(m.data.tipo || '') !== 'compra' || true);
        let balance = baseExisting ? Number(baseExisting.data.stockAntes) || 0 : 0;

        const newMovement = {
          id: String(items.find((i: any) => String(i.productoId) === pid)?.movementId || ('MOV-' + Store.uid())),
          productoId: pid,
          tipo: 'compra',
          cantidad: Number(incoming.cantidad) || 0,
          stockAntes: 0,
          stockDespues: 0,
          fecha: purchaseDateTime,
          referencia: `COMPRA FACT: ${invoiceNumber} - PROV: ${supplier}`,
          terminalId: String(purchase.terminalId || 'ADMIN')
        };

        const combined = [
          ...existing.map(m => ({ id: m.id, ref: m.ref, data: m.data })),
          { id: newMovement.id, ref: doc(db, 'movimientos', newMovement.id), data: newMovement }
        ].sort((a, b) => String(a.data.fecha || '').localeCompare(String(b.data.fecha || '')));

        let running = balance;
        const recalculated = combined.map(entry => {
          const before = running;
          const after = before + (Number(entry.data.cantidad) || 0);
          running = after;
          return {
            ...entry,
            data: { ...entry.data, stockAntes: before, stockDespues: after }
          };
        });

        finalMovementsByProduct.set(pid, recalculated);

        const currentStock = Number(product.stock) || 0;
        const incomingQty = Number(incoming.cantidad) || 0;
        const newStock = currentStock + incomingQty;
        const currentCost = Number(product.costoUSD) || 0;
        const incomingCost = Number(incoming.costoUnitarioUSD) || 0;
        const newCost = newStock > 0
          ? Math.round((((currentStock * currentCost) + (incomingQty * incomingCost)) / newStock + Number.EPSILON) * 10000) / 10000
          : incomingCost;

        finalProducts.set(pid, { ...product, stock: newStock, costoUSD: newCost });
      }

      // Escrituras: compra + productos + kardex + CxP + asiento.
      tx.set(purchaseRef, sanitizeForFirestore(purchase), { merge: false });

      for (const [pid, product] of finalProducts) {
        tx.set(doc(db, 'productos', pid), sanitizeForFirestore(product), { merge: true });
      }

      for (const [pid, entries] of finalMovementsByProduct) {
        const existingIds = new Set((movementDocsByProduct.get(pid) || []).map(m => m.id));
        for (const entry of entries) {
          if (existingIds.has(entry.id)) {
            tx.set(entry.ref, sanitizeForFirestore(entry.data), { merge: true });
          } else {
            tx.set(entry.ref, sanitizeForFirestore(entry.data), { merge: false });
          }
        }
      }

      if (debt?.id) {
        tx.set(doc(db, 'cxp', debt.id), sanitizeForFirestore(debt), { merge: false });
      }
      if (journal?.id) {
        tx.set(doc(db, 'libroDiario', journal.id), sanitizeForFirestore(journal), { merge: false });
        journalResult = journal;
      }
      tx.set(operationRef, { tipo: 'COMPRA', operationId: opId, fecha: purchaseDateTime, referencia: invoiceNumber }, { merge: false });

      result = {
        purchase,
        debt: debt || null,
        journal: journal || null,
        productIds,
        movementCount: items.length
      };
    });

    // CxP y productos/movimientos/compras se mantienen por snapshots autoritativos.
    if (journalResult?.id) {
      applyPatch({ libroDiario: mergeById(cache.libroDiario, [journalResult]) });
    }
    return result;
  },

  async createSaleTransaction(params: {
    operationId?: string;
    cart: any[];
    payments: any[];
    clientName: string;
    terminalId?: string;
    fallbackReceiptNumber?: number;
    now: string;
    tasa: number;
    saleType?: string;
    credit?: { customer: any; debtId: string };
    cajeroId?: string;
    fromOfflineQueue?: boolean;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, cart, payments, clientName, terminalId, fallbackReceiptNumber, now, tasa, saleType = 'VENTA', credit, cajeroId, fromOfflineQueue } = params;
    if (!cart?.length) throw new Error('La venta no contiene productos.');
    if (!(Number(tasa) > 0)) throw new Error('La tasa de la venta no es válida.');

    const opId = String(operationId || (terminalId || 'GLOBAL') + '|' + saleType + '|' + JSON.stringify({ cart, payments, client: clientName, credit: credit ? { customerId: credit.customer?.id, cedula: credit.customer?.cedula } : null }));

    // Las transacciones Firestore no funcionan completamente offline. En ese caso
    // persistimos la INTENCIÓN de venta en una cola local que sobrevive al reinicio.
    // Al volver la conexión, el procesador la ejecuta contra el Firestore real.
    if (!fromOfflineQueue && typeof window !== 'undefined' && navigator.onLine === false) {
      const queued = enqueueOfflineOperation('VENTA', { ...params, operationId: opId, fromOfflineQueue: true }, opId);
      const total = cart.reduce((s: number, i: any) => s + (Number(i.subtotalUSD) || 0), 0);
      const paid = (payments || []).reduce((s: number, p: any) => s + (Number(p.montoUSD) || 0), 0);
      const provisionalId = 'PEND-' + opId.replace(/[^a-zA-Z0-9]/g, '').slice(-18);
      const provisionalSale: any = {
        id: provisionalId, fecha: now, cliente: clientName, items: cart.map((x: any) => ({ ...x })),
        subtotalUSD: total, descuentoUSD: 0, totalUSD: total, totalBS: total * tasa,
        metodoPago: credit ? 'credito' : ((payments || []).length > 1 ? 'mixto' : ((payments || [])[0]?.metodo || 'efectivo_usd')),
        estado: 'pendiente', type: saleType, received: paid, change: Math.max(0, paid - total),
        payments: (payments || []).map((x: any) => ({ ...x })), terminalId, terminalName: 'PENDIENTE OFFLINE', cajeroId, tasa,
        offlinePending: true, operationId: opId
      };
      let provisionalDebt: any = null;
      if (credit?.customer) {
        provisionalDebt = {
          id: credit.debtId || ('PEND-CRD-' + provisionalId), fecha: now.slice(0,10), fechaVencimiento: '2099-12-31',
          cliente: credit.customer.name + ' [' + credit.customer.cedula + ']', montoUSD: total, abonadoUSD: 0, saldoUSD: total,
          estado: 'pendiente', historialPagos: [], ventaId: provisionalId, offlinePending: true, operationId: opId
        };
      }
      return { queuedOffline: true, operationId: opId, sale: provisionalSale, debt: provisionalDebt, nextNumber: fallbackReceiptNumber };
    }

    let result: any = null;
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'VENTA', opId);
      // Lecturas completas antes de cualquier escritura.
      const terminalRef = terminalId ? doc(db, 'terminales', terminalId) : null;
      const terminalSnap = terminalRef ? await tx.get(terminalRef) : null;
      const terminalRemote = terminalSnap?.exists() ? sanitizeForFirestore(terminalSnap.data()) as any : null;

      if (terminalId && !terminalRemote) {
        throw new Error('La caja/terminal ya no existe en Firestore. Actualice la sesión.');
      }

      const nextNumber = Number(
        terminalRemote?.proximoRecibo ??
        fallbackReceiptNumber ??
        1
      );
      const prefijo = terminalPrefix(terminalRemote, terminalId);
      const reciboId = terminalSeries(prefijo, 'V', nextNumber, 9);
      const saleRef = doc(db, 'ventas', reciboId);
      const existingSale = await tx.get(saleRef);
      if (existingSale.exists()) {
        throw new Error('El correlativo de esta venta ya fue utilizado por otra operación. Actualice la caja.');
      }

      const remoteProducts = new Map<string, any>();
      const productIds = [...new Set(cart.map((i: any) => String(i.productoId || '')).filter(Boolean))];

      for (const pid of productIds) {
        const snap = await tx.get(doc(db, 'productos', pid));
        if (!snap.exists()) throw new Error('Un producto de la venta ya no existe en Firestore.');
        remoteProducts.set(pid, { ...sanitizeForFirestore(snap.data()), id: pid });
      }

      // Resolver componentes de kits desde Firestore, nunca desde el estado viejo de la caja.
      const componentIds = new Set<string>();
      for (const item of cart) {
        const p = remoteProducts.get(String(item.productoId));
        if (p?.isKit && p.kitType === 'stock_componentes' && Array.isArray(p.kitItems)) {
          p.kitItems.forEach((ki: any) => componentIds.add(String(ki.productoId)));
        }
      }
      for (const pid of componentIds) {
        if (!remoteProducts.has(pid)) {
          const snap = await tx.get(doc(db, 'productos', pid));
          if (!snap.exists()) throw new Error('Un componente del kit ya no existe en Firestore.');
          remoteProducts.set(pid, { ...sanitizeForFirestore(snap.data()), id: pid });
        }
      }

      // CxC: resolver cliente remoto dentro de la misma transacción.
      let customerRef: any = null;
      let remoteCustomer: any = null;
      if (credit) {
        if (credit.customer?.id) {
          customerRef = doc(db, 'clientes', credit.customer.id);
          const snap = await tx.get(customerRef);
          if (snap.exists()) remoteCustomer = sanitizeForFirestore(snap.data()) as any;
        }
        if (!remoteCustomer && credit.customer?.cedula) {
          const snaps = await tx.get(query(
            collection(db, 'clientes'),
            where('cedula', '==', credit.customer.cedula),
            limit(1)
          ));
          if (!snaps.empty) {
            customerRef = snaps.docs[0].ref;
            remoteCustomer = sanitizeForFirestore(snaps.docs[0].data()) as any;
          }
        }
      }

      const totals = cart.reduce((acc: any, item: any) => {
        const p = remoteProducts.get(String(item.productoId));
        const sub = Number(item.subtotalUSD) || 0;
        if (p?.aplicaIVA) {
          const base = sub / 1.16;
          acc.base += base;
          acc.iva += sub - base;
        } else {
          acc.exento += sub;
        }
        acc.total += sub;
        return acc;
      }, { total: 0, base: 0, iva: 0, exento: 0 });

      const totalPaid = payments.reduce((s: number, p: any) => s + (Number(p.montoUSD) || 0), 0);
      if (!credit && totalPaid + 0.001 < totals.total) {
        throw new Error('El pago recibido es menor al total de la venta.');
      }

      const movements: any[] = [];
      const productUpdates = new Map<string, any>();
      const deductions = new Map<string, { qty: number; references: string[] }>();

      // Agregamos primero todas las salidas por producto. Así dos kits que
      // comparten un componente descuentan una sola vez sobre el stock remoto.
      for (const item of cart) {
        const p = remoteProducts.get(String(item.productoId));
        if (!p) throw new Error('Producto no encontrado.');
        const qty = Number(item.cantidad) || 0;
        if (qty <= 0) throw new Error('La venta contiene una cantidad inválida.');
        if (p.isKit && p.kitType === 'stock_componentes' && Array.isArray(p.kitItems)) {
          for (const ki of p.kitItems) {
            const componentId = String(ki.productoId);
            const required = qty * (Number(ki.cantidad) || 0);
            const d = deductions.get(componentId) || { qty: 0, references: [] };
            d.qty += required;
            d.references.push(String(p.nombre || item.nombre || item.productoId));
            deductions.set(componentId, d);
          }
        } else {
          const productId = String(p.id);
          const d = deductions.get(productId) || { qty: 0, references: [] };
          d.qty += qty;
          d.references.push(String(p.nombre || item.nombre || item.productoId));
          deductions.set(productId, d);
        }
      }

      for (const [pid, deduction] of deductions) {
        const p = remoteProducts.get(pid);
        const stock = Number(p?.stock) || 0;
        if (!p || stock < deduction.qty) throw new Error('Stock insuficiente para: ' + (p?.nombre || pid));
        const updated = { ...p, stock: stock - deduction.qty };
        productUpdates.set(pid, updated);
        movements.push({
          id: Store.uid(),
          productoId: pid,
          tipo: 'venta',
          cantidad: -deduction.qty,
          stockAntes: stock,
          stockDespues: updated.stock,
          fecha: now,
          referencia: saleType + ' ' + reciboId + (deduction.references.length > 1 ? ' - SALIDA AGRUPADA' : ''),
          terminalId: terminalId || 'GLOBAL'
        });
      }

      // Validación final de cantidades; las deducciones reales ya fueron agregadas arriba.
      for (const item of cart) {
        if ((Number(item.cantidad) || 0) <= 0) throw new Error('La venta contiene una cantidad inválida.');
      }

      const vIgtf = payments
        .filter((p: any) => p.metodo === 'efectivo_usd' || p.metodo === 'zelle')
        .reduce((s: number, p: any) => s + (Number(p.montoUSD) || 0) * 0.03, 0);

      const sale: any = {
        id: reciboId,
        fecha: now,
        cliente: clientName,
        items: cart.map((x: any) => ({ ...x })),
        subtotalUSD: totals.total,
        descuentoUSD: 0,
        totalUSD: totals.total,
        totalBS: totals.total * tasa,
        metodoPago: credit ? 'credito' : (payments.length > 1 ? 'mixto' : (payments[0]?.metodo || 'efectivo_usd')),
        estado: 'completada',
        type: saleType,
        received: totalPaid,
        change: Math.max(0, totalPaid - totals.total),
        payments: payments.map((x: any) => ({ ...x })),
        terminalId: terminalId,
        terminalName: terminalRemote?.nombre || 'SISTEMA GLOBAL',
        cajeroId,
        baseImponibleUSD: Utils.round(totals.base),
        ivaUSD: Utils.round(totals.iva),
        exentoUSD: Utils.round(totals.exento),
        igtfUSD: Utils.round(vIgtf),
        tasa
      };

      const journals = credit ? [] : payments.map((p: any) => ({
        id: 'ACC-' + Store.uid().toUpperCase().slice(0, 10),
        fecha: now,
        tipo: 'ingreso',
        categoria: 'VENTA',
        concepto: `VENTA #${reciboId} - CLIENTE: ${String(clientName).toUpperCase()}`,
        montoUSD: Number(p.montoUSD) || 0,
        montoBS: Number(p.montoBS) || (Number(p.montoUSD) || 0) * tasa,
        metodo: p.metodo,
        referencia: reciboId + '-' + (terminalId || 'GLOBAL'),
        terminalId: terminalId || 'GLOBAL'
      }));

      let debt: any = null;
      if (credit) {
        if (!remoteCustomer && credit.customer) {
          customerRef = doc(db, 'clientes', credit.customer.id);
          remoteCustomer = { ...credit.customer, debt: 0 };
        }
        if (!customerRef || !remoteCustomer) throw new Error('No se pudo resolver el cliente para la venta a crédito.');
        debt = {
          id: 'CRD-' + reciboId,
          fecha: now.slice(0, 10),
          fechaVencimiento: '2099-12-31',
          cliente: `${remoteCustomer.name} [${remoteCustomer.cedula}]`,
          montoUSD: totals.total,
          abonadoUSD: 0,
          saldoUSD: totals.total,
          estado: 'pendiente',
          historialPagos: [],
          ventaId: reciboId
        };
      }

      const writesPlanned = 2 + productUpdates.size + movements.length + journals.length +
        (terminalRef ? 1 : 0) + (debt ? 1 : 0) + (customerRef ? 1 : 0);
      if (writesPlanned > 450) {
        throw new Error('La venta tiene demasiados movimientos para procesarse en una sola transacción.');
      }

      tx.set(saleRef, sanitizeForFirestore(sale), { merge: false });
      for (const [pid, product] of productUpdates) {
        tx.set(doc(db, 'productos', pid), sanitizeForFirestore(product), { merge: true });
      }
      for (const movement of movements) {
        tx.set(doc(db, 'movimientos', movement.id), sanitizeForFirestore(movement), { merge: false });
      }
      for (const entry of journals) {
        tx.set(doc(db, 'libroDiario', entry.id), sanitizeForFirestore(entry), { merge: false });
      }
      if (debt) tx.set(doc(db, 'cxc', debt.id), sanitizeForFirestore(debt), { merge: false });
      if (customerRef && remoteCustomer) {
        tx.set(customerRef, sanitizeForFirestore({
          ...remoteCustomer,
          debt: (Number(remoteCustomer.debt) || 0) + totals.total
        }), { merge: true });
      }
      if (terminalRef && terminalRemote) {
        tx.set(terminalRef, sanitizeForFirestore({
          ...terminalRemote,
          proximoRecibo: nextNumber + 1
        }), { merge: true });
      }

      tx.set(operationRef, { tipo: 'VENTA', operationId: opId, fecha: now, referencia: reciboId, terminalId: terminalId || 'GLOBAL' }, { merge: false });

      result = { sale, debt, journals, products: [...productUpdates.values()], nextNumber: nextNumber + 1, terminal: { ...(terminalRemote || {}), id: terminalId, proximoRecibo: nextNumber + 1 } };
    });

    // Las colecciones autoritativas se actualizan por sus snapshots. Solo
    // parcheamos libroDiario para que el asiento aparezca inmediatamente.
    if (result?.products?.length) {
      // Productos: Firestore sigue siendo la fuente de verdad y RTDB es su espejo.
      await syncProductosRTDB(cache.productos || [], result.products);
      applyPatch({ productos: mergeById(cache.productos || [], result.products) });
    }
    if (result?.journals?.length) {
      applyPatch({ libroDiario: mergeById(cache.libroDiario, result.journals) });
    }
    if (result?.terminal?.id) {
      applyPatch({ terminales: mergeById(cache.terminales || [], [result.terminal]) });
    }
    return result;
  },

  async deletePurchaseTransaction(params: {
    operationId?: string;
    purchaseId?: string;
    invoiceNumber: string;
    supplier: string;
    purchaseDate?: string;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;

    const operationId = String(params.operationId || '');
    const invoiceNumber = String(params.invoiceNumber || '').trim();
    const supplier = String(params.supplier || '').trim();
    const purchaseDate = String(params.purchaseDate || '').slice(0, 10);
    if (!invoiceNumber || !supplier) throw new Error('La compra no tiene factura/proveedor identificables.');

    let result: any = null;
    let journalPatch: LibroDiarioEntry[] = [];
    const opId = operationId || (invoiceNumber + '|' + supplier + '|' + purchaseDate + '|DELETE');
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'ELIMINAR-COMPRA', opId);
      const purchaseRef = params.purchaseId ? doc(db, 'compras', params.purchaseId) : null;
      const purchaseSnap = purchaseRef ? await tx.get(purchaseRef) : null;

      const cxpSnap = await tx.get(
        query(collection(db, 'cxp'), where('numeroFactura', '==', invoiceNumber))
      );
      const linkedDebts = cxpSnap.docs.filter(d => {
        const debt = d.data() as any;
        return String(debt.proveedor || '') === supplier &&
          (!purchaseDate || String(debt.fecha || '').slice(0, 10) === purchaseDate);
      });

      const journalSnap = await tx.get(
        query(collection(db, 'libroDiario'), where('referencia', '==', invoiceNumber))
      );
      const purchaseJournal = journalSnap.docs.filter(d => String((d.data() as any).categoria || '') === 'COMPRA');

      // Los movimientos de una compra se identifican por su referencia exacta.
      // Esto permite encontrar compras de contado aunque no exista CxP.
      const purchaseReference = `COMPRA FACT: ${invoiceNumber} - PROV: ${supplier}`;
      const movementSnap = await tx.get(
        query(collection(db, 'movimientos'), where('referencia', '==', purchaseReference))
      );
      const movementMatches = movementSnap.docs.filter(d => String((d.data() as any).tipo || '') === 'compra');

      const affectedIds = new Set(movementMatches.map(d => String((d.data() as any).productoId || '')).filter(Boolean));
      const productSnaps = [];
      const movementDocsByProduct = new Map<string, any[]>();

      for (const pid of affectedIds) {
        const deletedForProduct = movementMatches
          .filter(d => String((d.data() as any).productoId || '') === pid)
          .sort((a, b) => String((a.data() as any).fecha || '').localeCompare(String((b.data() as any).fecha || '')));
        const firstDeletedFecha = deletedForProduct.length
          ? String((deletedForProduct[0].data() as any).fecha || '')
          : '';

        // Solo necesitamos la cola del kardex desde la compra eliminada hacia
        // adelante. Evitamos descargar el historial anterior del producto.
        let tailSnap;
        if (firstDeletedFecha) {
          tailSnap = await tx.get(query(
            collection(db, 'movimientos'),
            where('productoId', '==', pid),
            where('fecha', '>=', firstDeletedFecha)
          ));
        } else {
          tailSnap = await tx.get(query(
            collection(db, 'movimientos'),
            where('productoId', '==', pid)
          ));
        }
        movementDocsByProduct.set(pid, tailSnap.docs.map(d => ({
          id: d.id,
          ref: d.ref,
          data: sanitizeForFirestore(d.data()) as any
        })));

        const snap = await tx.get(doc(db, 'productos', pid));
        if (snap.exists()) productSnaps.push({ pid, snap });
      }

      const movementDocs: any[] = [...movementDocsByProduct.values()].flat();

      const paymentJournalIds = new Set<string>();
      linkedDebts.forEach(d => {
        const history = Array.isArray((d.data() as any).historialPagos) ? (d.data() as any).historialPagos : [];
        history.forEach((p: any) => {
          if (p?.asientoId) paymentJournalIds.add(String(p.asientoId));
        });
      });

      const paymentJournalSnaps = [];
      for (const id of paymentJournalIds) {
        const snap = await tx.get(doc(db, 'libroDiario', id));
        paymentJournalSnaps.push({ id, snap });
      }

      // Todas las lecturas terminan antes de cualquier escritura para que Firestore
      // pueda reintentar de forma segura si otra caja cambia alguno de estos documentos.
      const remainingMovementUpdates = movementDocs.filter(d =>
        !movementMatches.some(m => m.id === d.id) &&
        affectedIds.has(String((d.data() as any).productoId || ''))
      ).length;
      const writesPlanned =
        movementMatches.length +
        remainingMovementUpdates +
        linkedDebts.length +
        purchaseJournal.length +
        paymentJournalSnaps.filter(x => x.snap.exists()).length +
        (purchaseRef && purchaseSnap?.exists() ? 1 : 0) +
        productSnaps.length;

      if (writesPlanned > 450) {
        throw new Error('La compra tiene demasiados movimientos históricos para revertirla en una sola transacción. Debe revisarse antes de eliminarla.');
      }

      // Si otra caja registró una compra equivalente antes de esta transacción,
      // no borramos a ciegas. La coincidencia se basa en factura + proveedor + fecha.
      const alreadyLinked = linkedDebts.length > 0 || purchaseSnap?.exists() || movementMatches.length > 0;
      if (!alreadyLinked) throw new Error('La compra ya no existe en Firestore o fue modificada en otra caja. Actualice el historial.');

      const newMovementsByProduct = new Map<string, any[]>();

      for (const pid of affectedIds) {
        const ms = (movementDocsByProduct.get(pid) || [])
          .map(d => ({ ref: d.ref, data: d.data as any }))
          .sort((a, b) => {
            const af = String(a.data.fecha || '');
            const bf = String(b.data.fecha || '');
            return af === bf ? 0 : af < bf ? -1 : 1;
          });

        const deletedIds = new Set(movementMatches
          .filter(d => String((d.data() as any).productoId || '') === pid)
          .map(d => d.id));

        const deletedQty = movementMatches
          .filter(d => String((d.data() as any).productoId || '') === pid)
          .reduce((sum, d) => sum + Math.abs(Number((d.data() as any).cantidad) || 0), 0);

        // Como solo cargamos el tramo desde la compra eliminada, los valores
        // históricos del primer movimiento restante ya contienen la compra.
        // Se corrigen restando exactamente la cantidad eliminada.
        const remaining = ms
          .filter(x => !deletedIds.has(x.ref.id))
          .map(x => ({
            ...x,
            data: {
              ...x.data,
              stockAntes: (Number(x.data.stockAntes) || 0) - deletedQty,
              stockDespues: (Number(x.data.stockDespues) || 0) - deletedQty
            }
          }));

        newMovementsByProduct.set(pid, remaining);
      }

      const productUpdates: any[] = [];
      for (const { pid, snap } of productSnaps) {
        const remoteProduct = snap.data() as any;
        const remaining = newMovementsByProduct.get(pid) || [];
        const deletedQty = movementMatches
          .filter(d => String((d.data() as any).productoId || '') === pid)
          .reduce((sum, d) => sum + Math.abs(Number((d.data() as any).cantidad) || 0), 0);
        const finalStock = Math.max(
          0,
          (Number(remoteProduct.stock) || 0) - deletedQty
        );

        let finalCost = Number(remoteProduct.costoUSD) || 0;
        const deleted = movementMatches
          .filter(d => String((d.data() as any).productoId || '') === pid)
          .sort((a, b) => String((a.data() as any).fecha || '').localeCompare(String((b.data() as any).fecha || '')));
        const delMov = deleted[0];
        const item = linkedDebts
          .flatMap(d => Array.isArray((d.data() as any).items) ? (d.data() as any).items : [])
          .find((i: any) => String(i.productoId || '') === pid);
        const q = Math.abs(Number(delMov ? (delMov.data() as any).cantidad : item?.cantidad) || 0);
        const cq = Number(item?.costoUnitarioUSD) || 0;
        const delFecha = delMov ? String((delMov.data() as any).fecha || '') : '';

        const laterPurchaseLike = remaining.some(x =>
          ['compra', 'ajuste_entrada', 'inicial'].includes(String(x.data.tipo || '')) &&
          delFecha !== '' && String(x.data.fecha || '') > delFecha
        );

        const stockTrasCompra = delMov ? Number((delMov.data() as any).stockDespues) || 0 : (finalStock + q);
        if (!laterPurchaseLike && q > 0 && (stockTrasCompra - q) > 0 && cq > 0) {
          const den = stockTrasCompra - q;
          finalCost = Math.max(0, Math.round((((stockTrasCompra * finalCost) - (q * cq)) / den + Number.EPSILON) * 10000) / 10000);
        }

        productUpdates.push({ ref: snap.ref, data: { ...remoteProduct, stock: finalStock, costoUSD: finalCost } });
      }

      movementMatches.forEach(d => tx.delete(d.ref));
      newMovementsByProduct.forEach(items => {
        items.forEach(x => tx.set(x.ref, sanitizeForFirestore(x.data), { merge: false }));
      });
      productUpdates.forEach(x => tx.set(x.ref, sanitizeForFirestore(x.data), { merge: false }));
      linkedDebts.forEach(d => tx.delete(d.ref));
      purchaseJournal.forEach(d => tx.delete(d.ref));
      paymentJournalSnaps.forEach(x => {
        if (x.snap.exists()) tx.delete(x.snap.ref);
      });
      if (purchaseRef?.exists()) tx.delete(purchaseRef);

      journalPatch = purchaseJournal.map(d => d.data() as LibroDiarioEntry)
        .filter(Boolean)
        .concat(paymentJournalSnaps.filter(x => x.snap.exists()).map(x => x.snap.data() as LibroDiarioEntry));

      tx.set(operationRef, { tipo: 'ELIMINAR-COMPRA', operationId: opId, fecha: new Date().toISOString(), referencia: invoiceNumber }, { merge: false });
      result = {
        deletedMovements: movementMatches.length,
        deletedDebts: linkedDebts.length,
        deletedJournals: purchaseJournal.length + paymentJournalSnaps.filter(x => x.snap.exists()).length,
        deletedPurchase: !!purchaseRef?.exists(),
        affectedProducts: productUpdates.length
      };
    });

    if (journalPatch.length) {
      const deletedIds = new Set(journalPatch.map((e: any) => e.id));
      applyPatch({ libroDiario: (cache.libroDiario || []).filter((e: any) => !deletedIds.has(e.id)) });
    }
    return result;
  },

  async deleteCustomerAndDebtsTransaction(params: {
    operationId?: string;
    customerId: string;
    customerName?: string;
    customerCedula?: string;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, customerId, customerName, customerCedula } = params;
    const customerRef = doc(db, 'clientes', customerId);
    let result: any = null;
    const opId = String(operationId || customerId);
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'ELIMINAR-CLIENTE', opId);
      const customerSnap = await tx.get(customerRef);
      if (!customerSnap.exists()) throw new Error('El cliente ya no existe o fue eliminado en otra caja.');
      const customer = sanitizeForFirestore(customerSnap.data()) as any;
      // Evita leer toda CxC: cuando conocemos la cédula, el formato
      // canónico de cliente permite consultar únicamente las deudas de esa persona.
      // Solo usamos la consulta histórica amplia como compatibilidad para datos
      // antiguos que no contienen la cédula en el campo cliente.
      let debtsSnap;
      if (customerCedula) {
        const clienteExact = `${customerName || customer.cliente || customer.nombre || ''} [${customerCedula}]`.trim();
        debtsSnap = await tx.get(query(
          collection(db, 'cxc'),
          where('cliente', '==', clienteExact)
        ));
        // Compatibilidad con deudas antiguas que guardaban solo el nombre:
        // solo hacemos esta segunda lectura si la consulta canónica no encontró
        // nada. En datos nuevos el camino habitual sigue siendo una sola query.
        if (debtsSnap.empty) {
          const legacyName = String(customerName || customer.cliente || customer.nombre || '').trim();
          if (legacyName) {
            debtsSnap = await tx.get(query(
              collection(db, 'cxc'),
              where('cliente', '==', legacyName)
            ));
          }
        }
      } else if (customerName) {
        debtsSnap = await tx.get(query(
          collection(db, 'cxc'),
          where('cliente', '==', customerName)
        ));
      } else {
        debtsSnap = await tx.get(query(collection(db, 'cxc')));
      }
      const debts = debtsSnap.docs;
      const active = debts.find(d => {
        const debt = d.data() as any;
        return debt.estado !== 'pagada' && (Number(debt.saldoUSD) || 0) > 0.001;
      });
      if (active) throw new Error('El cliente tiene una deuda pendiente en otra caja. Actualice y vuelva a intentar.');
      debts.forEach(d => tx.delete(d.ref));
      tx.delete(customerRef);
      tx.set(operationRef, { tipo: 'ELIMINAR-CLIENTE', operationId: opId, fecha: new Date().toISOString(), referencia: customerId }, { merge: false });
      result = { customer, deletedDebts: debts.length };
    });
    return result;
  },

  async deleteCustomerDebtTransaction(params: {
    operationId?: string;
    debtId: string;
    customerCedula?: string;
    customerId?: string;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, debtId, customerCedula, customerId } = params;
    const debtRef = doc(db, 'cxc', debtId);
    let result: any = null;
    const opId = String(operationId || debtId);
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'ELIMINAR-CXC', opId);
      const debtSnap = await tx.get(debtRef);
      if (!debtSnap.exists()) throw new Error('La deuda ya no existe o fue eliminada en otra caja.');
      const debt = sanitizeForFirestore(debtSnap.data()) as any;
      const saldo = Number(debt.saldoUSD) || 0;
      let customerRef: any = null;
      let customer: any = null;
      if (customerId) {
        customerRef = doc(db, 'clientes', customerId);
        const snap = await tx.get(customerRef);
        if (snap.exists()) customer = sanitizeForFirestore(snap.data()) as any;
      } else if (customerCedula) {
        const snaps = await tx.get(query(collection(db, 'clientes'), where('cedula', '==', customerCedula), limit(1)));
        if (!snaps.empty) {
          customerRef = snaps.docs[0].ref;
          customer = sanitizeForFirestore(snaps.docs[0].data()) as any;
        }
      }
      tx.delete(debtRef);
      if (customerRef && customer) {
        tx.set(customerRef, { debt: Math.max(0, (Number(customer.debt) || 0) - saldo) }, { merge: true });
      }
      tx.set(operationRef, { tipo: 'ELIMINAR-CXC', operationId: opId, fecha: new Date().toISOString(), referencia: debtId }, { merge: false });
      result = { debt, customer: customer ? { ...customer, debt: Math.max(0, (Number(customer.debt) || 0) - saldo) } : null };
    });
    // CxC/clientes se actualizan exclusivamente por snapshots completos autoritativos.
    return result;
  },

  async createCustomerDebtTransaction(params: {
    operationId?: string;
    debt: any;
    customer?: any;
    customerId?: string;
    customerCedula?: string;
    journal?: any;
  }): Promise<any> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, debt, customer, customerId, customerCedula, journal } = params;
    const debtRef = doc(db, 'cxc', debt.id);
    let result: any = null;
    const opId = String(operationId || debt.id);
    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'DEUDA-CXC', opId);
      const existing = await tx.get(debtRef);
      if (existing.exists()) throw new Error('La deuda ya existe en otra caja. Actualice y vuelva a intentar.');
      let customerRef: any = null;
      let remoteCustomer: any = null;
      if (customerId) {
        customerRef = doc(db, 'clientes', customerId);
        const snap = await tx.get(customerRef);
        if (!snap.exists()) throw new Error('El cliente ya no existe en otra caja.');
        remoteCustomer = sanitizeForFirestore(snap.data()) as any;
      } else if (customerCedula) {
        const snaps = await tx.get(query(collection(db, 'clientes'), where('cedula', '==', customerCedula), limit(1)));
        if (!snaps.empty) {
          customerRef = snaps.docs[0].ref;
          remoteCustomer = sanitizeForFirestore(snaps.docs[0].data()) as any;
        }
      }
      if (!remoteCustomer && customer) {
        customerRef = doc(db, 'clientes', customer.id);
        const snap = await tx.get(customerRef);
        if (snap.exists()) remoteCustomer = sanitizeForFirestore(snap.data()) as any;
        else tx.set(customerRef, sanitizeForFirestore(customer), { merge: false });
      }
      const amount = Number(debt.montoUSD) || 0;
      const mergedCustomer = remoteCustomer ? {
        ...remoteCustomer,
        debt: (Number(remoteCustomer.debt) || 0) + amount,
        address: customer?.address || remoteCustomer.address || 'Sin dirección',
        phone: customer?.phone || remoteCustomer.phone || 'Sin teléfono'
      } : null;
      if (customerRef && mergedCustomer) tx.set(customerRef, sanitizeForFirestore(mergedCustomer), { merge: true });
      tx.set(debtRef, sanitizeForFirestore(debt), { merge: false });
      if (journal?.id) tx.set(doc(db, 'libroDiario', journal.id), sanitizeForFirestore(journal), { merge: false });
      tx.set(operationRef, { tipo: 'DEUDA-CXC', operationId: opId, fecha: debt.fecha, referencia: debt.id }, { merge: false });
      result = { debt, customer: mergedCustomer };
    });
    // CxC/clientes se actualizan exclusivamente por snapshots completos autoritativos.
    if (journal?.id) applyPatch({ libroDiario: mergeById(cache.libroDiario, [journal]) });
    return result;
  },

  async reverseDebtPaymentTransaction(params: {
    operationId?: string;
    collection: 'cxc' | 'cxp';
    debtId: string;
    paymentId: string;
    journalId?: string;
  }): Promise<any | null> {
    if (typeof window === 'undefined' || !db) return null;
    const { operationId, collection: collectionName, debtId, paymentId, journalId } = params;
    const debtRef = doc(db, collectionName, debtId);
    let result: any = null;
    let journalResult: any = null;
    const opId = String(operationId || (collectionName + '|' + debtId + '|' + paymentId + '|REVERSE'));

    await runTransaction(db, async tx => {
      const operationRef = await claimOperation(tx, 'REVERSAR-PAGO', opId);
      // Cada reintento debe reconstruir completamente el resultado a partir
      // del estado remoto para evitar residuos de un intento anterior.
      let nextResult: any = null;
      let nextJournalResult: any = null;

      const debtSnap = await tx.get(debtRef);
      if (!debtSnap.exists()) throw new Error('La deuda ya no existe.');

      const journalRef = journalId ? doc(db, 'libroDiario', journalId) : null;
      const journalSnap = journalRef ? await tx.get(journalRef) : null;

      const remote = sanitizeForFirestore(debtSnap.data()) as any;
      const historial = Array.isArray(remote.historialPagos) ? [...remote.historialPagos] : [];
      const idx = historial.findIndex((p: any) => String(p?.id || '') === String(paymentId));
      if (idx < 0) throw new Error('El abono ya fue eliminado o no existe en la deuda remota.');

      const pago = historial[idx];
      const monto = Number(pago?.montoUSD) || 0;
      const restantes = historial.filter((_: any, i: number) => i !== idx);
      const abonado = Math.max(
        0,
        Math.round((restantes.reduce((sum: number, p: any) => sum + (Number(p?.montoUSD) || 0), 0) + Number.EPSILON) * 100) / 100
      );
      const saldo = Math.max(
        0,
        Math.round(((Number(remote.montoUSD) || 0) - abonado + Number.EPSILON) * 100) / 100
      );
      const estado = saldo <= 0.001 ? 'pagada' : abonado > 0 ? 'parcial' : 'pendiente';
      const updated = {
        ...remote,
        abonadoUSD: abonado,
        saldoUSD: saldo,
        estado,
        historialPagos: restantes
      };

      tx.set(debtRef, sanitizeForFirestore(updated), { merge: true });

      if (journalRef && journalSnap?.exists()) {
        const journal = sanitizeForFirestore(journalSnap.data()) as any;
        const nuevoMonto = Math.max(
          0,
          Math.round(((Number(journal.montoUSD) || 0) - monto + Number.EPSILON) * 100) / 100
        );
        const nuevoBS = Math.max(
          0,
          Math.round(((Number(journal.montoBS) || 0) - (Number(pago?.montoBS) || 0) + Number.EPSILON) * 100) / 100
        );

        if (nuevoMonto <= 0.001) {
          tx.delete(journalRef);
        } else {
          nextJournalResult = {
            ...journal,
            montoUSD: nuevoMonto,
            montoBS: nuevoBS,
            concepto: String(journal.concepto || '').replace(/ \\(abono revertido\\)$/i, '') + ' (abono revertido)'
          };
          tx.set(journalRef, sanitizeForFirestore(nextJournalResult), { merge: true });
        }
      }

      tx.set(operationRef, { tipo: 'REVERSAR-PAGO', operationId: opId, fecha: new Date().toISOString(), referencia: paymentId }, { merge: false });
      nextResult = { ...updated, reversedPayment: pago };
      result = nextResult;
      journalResult = nextJournalResult;
    });

    const currentJournal = (cache.libroDiario || []).filter((e: any) => e.id !== journalId);
    // La deuda CxC/CxP se actualiza por su snapshot completo autoritativo.
    // El asiento sí puede parchearse localmente porque libroDiario no usa snapshot completo.
    applyPatch({ libroDiario: journalResult ? [...currentJournal, journalResult] : currentJournal });

    return result;
  },

  async set(patch: Partial<AppState>) {
    if (typeof window === 'undefined' || !db) return;
    const prev = Store.get();
    const full = { ...initialState, ...prev, ...patch } as AppState;

    // Echo local inmediato (la UI ya muestra el cambio al instante)
    applyPatch(patch);

    // 1) COLEECCIONES: escritura por documento (nunca el array completo en un doc)
    const jobs: Promise<unknown>[] = [];
    for (const key of Object.keys(COLLECTIONS)) {
      const k = key as keyof AppState;
      if ((patch as any)[k] === undefined) continue;
      const prevArr = ((prev as any)[k] || []) as any[];
      const newArr = ((patch as any)[k] || []) as any[];
      if (k === 'productos') {
        jobs.push(syncProductosTransactional(prevArr, newArr)
          .then((stocks) => {
            let toSync = newArr;
            if (stocks && stocks.size > 0) {
              const corrected = newArr.map((p: any) => {
                const s = stocks.get(String(p.id));
                return s !== undefined ? { ...p, stock: s } : p;
              });
              applyPatch({ productos: corrected });
              toSync = corrected;
            }
            return syncProductosRTDB(prevArr, toSync);
          })
          .catch(e => console.error("Error persistiendo productos:", e)));
      } else {
        jobs.push(syncArrayToCollection(COLLECTIONS[k], prevArr, newArr).catch(e => console.error("Error persistiendo " + k + ":", e)));
      }
    }

    // 2) CATÁLOGOS
    // Los documentos del catálogo y su versión se publican en secuencia:
    // primero deben persistir los cambios y solo después se actualiza la
    // versión local/remota. Así una caja no puede marcar una versión como
    // vigente si el catálogo remoto falló.
    const catalogJobs: Promise<unknown>[] = [];
    let catalogosChanged = false;
    for (const [field, catName] of Object.entries(CATALOG_FIELDS)) {
      if ((patch as any)[field] === undefined) continue;
      const newList = (patch as any)[field] || [];
      const prevList = (prev as any)[field] || [];
      if (JSON.stringify(prevList) !== JSON.stringify(newList)) {
        catalogosChanged = true;
        catalogJobs.push(
          setDoc(doc(db, CATALOGOS_COLLECTION, catName), { lista: sanitizeForFirestore(newList) })
        );
      }
    }

    if (catalogosChanged) {
      const catalogVersion = new Date().toISOString();
      jobs.push(
        Promise.all(catalogJobs)
          .then(() => setDoc(
            doc(db, CONFIG_COLLECTION, CONFIG_DOC_ID),
            { catalogosVersion: catalogVersion },
            { merge: true }
          ))
          .then(() => writeCatalogCacheMeta(catalogVersion))
          .catch(e => console.error("Error persistiendo catálogo/version:", e))
      );
    }

    // 3) CONFIG (config/general) — solo campos que cambiaron
    const toWrite: Record<string, any> = {};
    for (const f of CONFIG_FIELDS) {
      const key = f as keyof AppState;
      if ((patch as any)[f] === undefined) continue;
      const clean = sanitizeForFirestore((patch as any)[f]);
      if (clean === undefined) continue;
      if (JSON.stringify(prev[key]) !== JSON.stringify((patch as any)[f])) {
        toWrite[f] = clean;
      }
    }
    if (Object.keys(toWrite).length > 0) {
      jobs.push(setDoc(doc(db, CONFIG_COLLECTION, CONFIG_DOC_ID), toWrite, { merge: true })
        .catch(e => console.error("Error persistiendo config:", e)));
    }

    await Promise.all(jobs);
  },

  loadMore,
  ensureLoaded,
  ensureReportRange,
  startMasterSync,
  syncMasterSync,
  startTerminalSync,
  ensureReportData,
  kardex,
  getSaleById,

  uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  }
};

registerOfflineProcessor(async (operation) => {
  if (operation.type === 'VENTA') {
    await Store.createSaleTransaction({ ...(operation.payload || {}), fromOfflineQueue: true, operationId: operation.operationId });
    return;
  }
  if (operation.type === 'INVENTARIO') {
    await Store.applyInventoryMovementsTransaction({ ...(operation.payload || {}), fromOfflineQueue: true, operationId: operation.operationId });
    return;
  }
  if (operation.type === 'COMPRA') { await Store.createPurchaseTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'PAGO-DEUDA') { await Store.applyDebtPaymentTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'PAGO-CXP-GLOBAL') { await Store.applyGlobalProviderPaymentTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'REVERSAR-PAGO') { await Store.reverseDebtPaymentTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'ELIMINAR-COMPRA') { await Store.deletePurchaseTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'ELIMINAR-CLIENTE') { await Store.deleteCustomerAndDebtsTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'ELIMINAR-CXC') { await Store.deleteCustomerDebtTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'DEUDA-CXC') { await Store.createCustomerDebtTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'DEUDA-CXP') { await Store.createSupplierDebtTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  if (operation.type === 'DEVOLUCION' || operation.type === 'ANULACION') { await Store.processReturnOrCancellationTransaction({ ...(operation.payload || {}), operationId: operation.operationId }); return; }
  throw new Error('Tipo de operación offline no soportado: ' + operation.type);
});

export const Utils = {
  getVzlaDate: () => {
    const d = new Date();
    const options: Intl.DateTimeFormatOptions = {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    };
    const formatter = new Intl.DateTimeFormat('en-CA', options);
    const parts = formatter.formatToParts(d);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value;
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${getPart('year')}-${getPart('month')}-${getPart('day')}T${getPart('hour')}:${getPart('minute')}:${getPart('second')}.${ms}`;
  },
  hoy: () => Utils.getVzlaDate().slice(0, 10),
  ahora: () => Utils.getVzlaDate(),
  round: (v: any) => {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : Math.round((n + Number.EPSILON) * 100) / 100;
  },
  fmtUSD: (v: number) => '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  fmtBS: (v: number, symbol = true) => (symbol ? 'Bs. ' : '') + Number(v).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  fmtMono: (v: number, prefix = false) => (prefix ? '$' : '') + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  fmtFecha: (f: string) => {
    if (!f) return '-';
    const datePart = f.includes('T') ? f.split('T')[0] : f;
    const p = datePart.split('-');
    return p[2] + '/' + p[1] + '/' + p[0];
  },
  metodoLabel: (m: string) => {
    const map: Record<string, string> = {
      efectivo_usd: 'Efectivo USD',
      efectivo_bs: 'Efectivo Bs.',
      punto_venta: 'Punto de Venta',
      biopago: 'Biopago',
      pagomovil: 'PagoMovil',
      zelle: 'Zelle',
      credito: 'Crédito',
      mixto: 'Mixto',
      nota_credito: 'Vale / Nota Crédito',
      otros: 'Otros'
    };
    return map[m] || m;
  },

  // Prefijo de caja para la numeración de facturas. Cada caja lleva una serie
  // propia (C1-, C2-, ...) de modo que dos cajas puedan tener el mismo correlativo
  // pero queden diferenciadas en facturas, reportes y asientos.
  prefijoCaja: (t?: Terminal | null, terminals?: Terminal[]): string => {
    if (t?.prefijoCaja) return t.prefijoCaja;
    if (t?.id) {
      const idx = (terminals || []).findIndex(x => x.id === t.id);
      return 'C' + (idx >= 0 ? idx + 1 : 1);
    }
    return 'G';
  },

  // Lee el estado de caja de UN terminal concreto (apertura, fondos, corte Z,
  // historial). Fuente de verdad: el documento del terminal.
  getTerminalCash: (t?: Terminal | null) => {
    return {
      isCashOpen: !!t?.isCashOpen,
      cashData: t?.cashData ?? null,
      fondoCajaHoyUSD: t?.fondoCajaHoyUSD ?? 0,
      fondoCajaHoyBS: t?.fondoCajaHoyBS ?? 0,
      ultimoZ: t?.ultimoZ ?? 0,
      fechaUltimoZ: t?.fechaUltimoZ ?? '',
      acumuladoHistorico: t?.acumuladoHistorico ?? 0,
      cashHistory: t?.cashHistory ?? [],
      proximoRecibo: t?.proximoRecibo ?? 0,
      proximaDevolucion: t?.proximaDevolucion ?? 0,
      proximaAnulacion: t?.proximaAnulacion ?? 0,
    };
  },

  // Actualiza el estado de caja de un terminal dentro del array de terminales.
  // Devuelve el nuevo array listo para pasar a updateState({ terminales: ... }).
  patchTerminal: (terminales: Terminal[], terminalId: string | undefined, patch: Partial<Terminal>): Terminal[] => {
    if (!terminalId) return terminales;
    return terminales.map(t => t.id === terminalId ? { ...t, ...patch } : t);
  },

  // Recalcula el saldo (stockAntes/stockDespues) de TODOS los movimientos de un
  // producto en orden cronológico. Se usa al registrar una compra con fecha pasada:
  // además de asentar el movimiento en esa fecha, los movimientos posteriores deben
  // reflejar el nuevo saldo corrido hasta la fecha actual.
  // `newIds` = ids de los movimientos recién insertados; la base (saldo de apertura)
  // se toma del movimiento pre-existente más antiguo, para no perder el stock inicial.
  recalcularSaldoProducto: (movimientos: Movimiento[], productoId: string, newIds?: Set<string>): Movimiento[] => {
    const others = movimientos.filter(m => m.productoId !== productoId);
    const productMovs = movimientos
      .filter(m => m.productoId === productoId)
      .slice()
      .sort((a, b) => (a.fecha === b.fecha ? 0 : a.fecha < b.fecha ? -1 : 1));
    // Saldo de apertura: stockAntes del primer movimiento pre-existente (0 si no hay).
    let base = 0;
    for (const m of productMovs) {
      if (!newIds || !newIds.has(m.id)) { base = m.stockAntes || 0; break; }
    }
    let balance = base;
    const updated = productMovs.map(m => {
      const stockAntes = balance;
      const stockDespues = stockAntes + (m.cantidad || 0);
      balance = stockDespues;
      return { ...m, stockAntes, stockDespues };
    });
    return [...others, ...updated];
  }
};
