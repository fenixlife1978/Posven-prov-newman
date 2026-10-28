'use client';

import { db, rtdb } from '@/lib/turso/firestore-compat';
import { collection, getDocs, getDoc, setDoc, doc, writeBatch } from '@/lib/turso/firestore-compat';
import { get as rtdbGet, ref as rtdbRef } from '@/lib/turso/realtime-compat';
import { Store } from '@/lib/db-store';

// Fuentes persistentes actuales de Turso.
// IMPORTANTE: operaciones y auditoriaSistema no forman parte de AppState,
// pero sí contienen información persistida que debe sobrevivir a una migración.
const COLLECTION_KEYS = [
  'productos', 'movimientos', 'ventas', 'cxc', 'cxp', 'clientes', 'proveedores',
  'devoluciones', 'anulaciones', 'terminales', 'libroDiario', 'reportesZ',
  'cashHistory', 'compras',
] as const;

const AUXILIARY_COLLECTIONS = [
  'users',
  'operaciones',
  'auditoriaSistema',
] as const;

// Fuentes históricas/compatibilidad detectadas en el repositorio.
// Se respaldan aunque el código operativo actual ya no las use.
const LEGACY_DOCUMENTS = [
  ['pos_system_data', 'state'],
  ['data', 'state'],
] as const;

// Catálogos: catalogos/{nombre} con { lista }.
const CATALOG_KEYS = [
  'categorias', 'departamentos', 'marcas', 'presentaciones',
  'productCategories', 'productUnits', 'productColors', 'productSizes',
  'brands', 'groups', 'subgroups', 'lines', 'suppliers',
] as const;

// Configuración: config/general.
// Parte del antiguo estado de caja se conserva además en terminales.
const CONFIG_KEYS = [
  'tasa', 'pinDevolucion', 'isInitialized', 'empresa',
  'proximoRecibo', 'proximaDevolucion', 'proximaAnulacion',
  'ultimoZ', 'fechaUltimoZ', 'acumuladoHistorico',
  'fondoCajaHoyUSD', 'fondoCajaHoyBS', 'isCashOpen', 'cashData', 'config',
] as const;

// Lectura de compatibilidad de productos desde la misma tabla Turso.
const RTDB_PRODUCTS_PATH = 'pos_system_data/productos';

export interface BackupFile {
  app: 'posven-pro';
  version: number;
  createdAt: string;
  data: Record<string, unknown>;
  meta?: {
    tursoCollections: Record<string, number>;
    catalogs: Record<string, number>;
    legacyDocuments: Record<string, boolean>;
    rtdbProductsPresent: boolean;
    authentication: {
      provider: 'Turso-auth';
      credentialsIncluded: false;
      note: string;
    };
  };
}

async function leerColeccion(nombre: string): Promise<any[]> {
  const snap = await getDocs(collection(db, nombre));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Fuerza la carga completa de las colecciones operativas administradas por Store.
async function hidratarTodo(): Promise<void> {
  const jobs = COLLECTION_KEYS.map((k) => Store.ensureLoaded(k).catch(() => {}));
  await Promise.all(jobs);
}

export async function crearRespaldo(): Promise<BackupFile> {
  await hidratarTodo();
  const state = Store.get() as Record<string, any>;
  const data: Record<string, unknown> = {};
  const tursoCollections: Record<string, number> = {};
  const catalogs: Record<string, number> = {};
  const legacyDocuments: Record<string, boolean> = {};

  // Colecciones operativas completas.
  for (const k of COLLECTION_KEYS) {
    data[k] = state[k] ?? [];
    TursoCollections[k] = Array.isArray(data[k]) ? (data[k] as any[]).length : 0;
  }

  // Catálogos completos, directamente desde Turso para no depender de la caché.
  for (const k of CATALOG_KEYS) {
    try {
      const snap = await getDoc(doc(db, 'catalogos', k));
      const lista = snap.exists() ? (snap.data().lista || []) : [];
      data[k] = lista;
      catalogs[k] = Array.isArray(lista) ? lista.length : 0;
    } catch (e) {
      console.error('backup: no se pudo leer catálogo', k, e);
      data[k] = state[k] ?? [];
      catalogs[k] = Array.isArray(data[k]) ? (data[k] as any[]).length : 0;
    }
  }

  for (const k of CONFIG_KEYS) data[k] = state[k];

  // Fuentes auxiliares que no forman parte de AppState.
  for (const k of AUXILIARY_COLLECTIONS) {
    try {
      const rows = await leerColeccion(k);
      data[k] = rows;
      if (k !== 'users') TursoCollections[k] = rows.length;
      else TursoCollections.users = rows.length;
    } catch (e) {
      console.error('backup: no se pudo leer colección auxiliar', k, e);
      data[k] = [];
      TursoCollections[k] = 0;
    }
  }

  // Rutas legacy: se consultan únicamente si existieran en el repositorio Turso.
  for (const [collectionName, docId] of LEGACY_DOCUMENTS) {
    const key = `${collectionName}/${docId}`;
    try {
      const snap = await getDoc(doc(db, collectionName, docId));
      legacyDocuments[key] = snap.exists();
      if (snap.exists()) data[key] = { id: snap.id, ...snap.data() };
    } catch (e) {
      legacyDocuments[key] = false;
      console.error('backup: no se pudo leer documento legacy', key, e);
    }
  }

  // Compatibilidad histórica: las lecturas de productos apuntan a la colección Turso,
  // sin mantener una segunda base de datos.
  let rtdbProductsPresent = false;
  try {
    const snap = await rtdbGet(rtdbRef(rtdb, RTDB_PRODUCTS_PATH));
    if (snap.exists()) {
      rtdbProductsPresent = true;
      data.rtdb_productos = snap.val();
    }
  } catch (e) {
    console.error('backup: no se pudo leer rtdb productos', e);
  }

  return {
    app: 'posven-pro',
    version: 2,
    createdAt: new Date().toISOString(),
    data,
    meta: {
      tursoCollections,
      catalogs,
      legacyDocuments,
      rtdbProductsPresent,
      authentication: {
        provider: 'turso-sessions',
        credentialsIncluded: false,
        note: 'El respaldo contiene perfiles de usuarios desde Turso; las contraseñas no se exportan. La autenticación usa sesiones de servidor y contraseñas con hash.',
      },
    },
  };
}

export function descargarRespaldo(backup: BackupFile) {
  const nombre = `Respaldo_POSVEN_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function leerArchivoRespaldo(file: File): Promise<BackupFile | null> {
  if (!file) return null;
  const text = await file.text();
  const parsed = JSON.parse(text) as BackupFile;
  if (!parsed || parsed.app !== 'posven-pro' || typeof parsed.data !== 'object') {
    throw new Error('El archivo no es un respaldo válido de POSVEN-Pro.');
  }
  return parsed;
}

export async function restaurarRespaldo(backup: BackupFile): Promise<void> {
  const d = backup.data || {};
  const patch: Record<string, any> = {};

  for (const k of COLLECTION_KEYS) patch[k] = (d[k] as any[]) ?? [];
  for (const k of CATALOG_KEYS) patch[k] = (d[k] as any[]) ?? [];
  for (const k of CONFIG_KEYS) patch[k] = d[k];

  await Store.set(patch as any);

  // Auxiliares Turso.
  for (const k of ['users', 'operaciones', 'auditoriaSistema'] as const) {
    const rows = (d[k] as any[]) || [];
    if (!rows.length) continue;
    const batch = writeBatch(db);
    for (const row of rows) {
      const { id, ...payload } = row;
      const rowId = String(id || payload.uid || '');
      if (rowId) batch.set(doc(db, k, rowId), payload, { merge: true });
    }
    await batch.commit();
  }
}

export async function cargarRespaldoDesdeArchivo(file: File): Promise<void> {
  const backup = await leerArchivoRespaldo(file);
  if (!backup) return;
  await restaurarRespaldo(backup);
}