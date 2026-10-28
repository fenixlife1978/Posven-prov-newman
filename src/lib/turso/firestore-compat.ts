'use client';

type Ref = { kind: 'collection' | 'doc'; collection: string; id?: string; constraints?: any[] };
type Snap = { id: string; exists: () => boolean; data: () => any; ref: Ref };
const API = '/api/turso';
export const db = { kind: 'turso' };
export const rtdb = { kind: 'turso' };
export type DocumentData = Record<string, any>;
export type QueryDocumentSnapshot = Snap;

function url(ref: Ref) { return API + '/' + encodeURIComponent(ref.collection) + (ref.id ? '?id=' + encodeURIComponent(ref.id) : ''); }
async function request(ref: Ref, init?: RequestInit) {
  const response = await fetch(url(ref), { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) {
    let message = 'Error al consultar Turso (' + response.status + ')';
    try { message = (await response.json()).error || message; } catch {}
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}
function snap(ref: Ref, value: any): Snap {
  const data = value == null ? undefined : value;
  return { id: ref.id || String(data?.id || ''), exists: () => data !== undefined && data !== null, data: () => data, ref };
}
export function collection(_db: any, name: string): Ref { return { kind: 'collection', collection: name }; }
export function doc(parent: any, nameOrId: string, maybeId?: string): Ref {
  if (maybeId !== undefined) return { kind: 'doc', collection: nameOrId, id: maybeId };
  if (parent?.kind === 'collection') return { kind: 'doc', collection: parent.collection, id: nameOrId };
  return { kind: 'doc', collection: String(parent?.collection || nameOrId), id: parent?.id || nameOrId };
}
export function where(field: string, op: string, value: any) { return { type: 'where', field, op, value }; }
export function orderBy(field: string, direction = 'asc') { return { type: 'orderBy', field, direction }; }
export function limit(count: number) { return { type: 'limit', count }; }
export function startAfter(value: any) { return { type: 'startAfter', value }; }
export function query(ref: Ref, ...constraints: any[]): Ref { return { ...ref, constraints }; }
function getField(item: any, path: string) { return path.split('.').reduce((v, key) => v?.[key], item); }
function applyConstraints(items: any[], constraints: any[] = []) {
  let out = [...items];
  for (const c of constraints) {
    if (c.type === 'where') out = out.filter(item => {
      const a = getField(item, c.field), b = c.value;
      switch (c.op) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '<': return a < b;
        case '<=': return a <= b;
        case 'in': return Array.isArray(b) && b.includes(a);
        case 'array-contains': return Array.isArray(a) && a.includes(b);
        default: return false;
      }
    });
    if (c.type === 'orderBy') out.sort((a,b) => {
      const av = getField(a,c.field), bv = getField(b,c.field);
      const cmp = av === bv ? 0 : av == null ? -1 : bv == null ? 1 : av < bv ? -1 : 1;
      return c.direction === 'desc' ? -cmp : cmp;
    });
    if (c.type === 'startAfter') {
      const index = out.findIndex(x => x.id === c.value?.id);
      if (index >= 0) out = out.slice(index + 1);
    }
    if (c.type === 'limit') out = out.slice(0, Math.max(0,c.count));
  }
  return out;
}
export async function getDoc(ref: Ref) { return snap(ref, await request(ref).catch(e => { if (String(e?.message).includes('(404)')) return null; throw e; })); }
export async function getDocs(ref: Ref) {
  const data = await request({ ...ref, id: undefined });
  const items = applyConstraints(Array.isArray(data) ? data : [], ref.constraints);
  const docs = items.map(item => snap({ kind: 'doc', collection: ref.collection, id: String(item.id) }, item));
  return { docs, empty: docs.length === 0, size: docs.length, forEach: (fn: (s: Snap) => void) => docs.forEach(fn) };
}
export async function setDoc(ref: Ref, data: any, options?: { merge?: boolean }) {
  let payload = data;
  if (options?.merge) {
    const current = await getDoc(ref);
    payload = { ...(current.exists() ? current.data() : {}), ...data };
  }
  return request(ref, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: ref.id, data: payload }) });
}
export async function updateDoc(ref: Ref, data: any) {
  const current = await getDoc(ref);
  if (!current.exists()) throw new Error('El registro no existe.');
  return setDoc(ref, { ...current.data(), ...data });
}
export async function deleteDoc(ref: Ref) {
  return request(ref, { method: 'DELETE' });
}
export function onSnapshot(ref: Ref, next: (snapshot: any) => void, error?: (error: any) => void) {
  let stopped = false;
  const read = async () => {
    try {
      if (stopped) return;
      if (ref.kind === 'doc') next(await getDoc(ref));
      else next(await getDocs(ref));
    } catch (e) { error?.(e); }
  };
  void read();
  const timer = window.setInterval(() => { if (navigator.onLine) void read(); }, 5000);
  const online = () => { void read(); };
  window.addEventListener('online', online);
  return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('online', online); };
}
export function writeBatch(_db: any) {
  const writes: any[] = [];
  return {
    set(ref: Ref, data: any, options?: { merge?: boolean }) { writes.push({ op: 'set', collection: ref.collection, id: ref.id, data, merge: !!options?.merge }); return this; },
    update(ref: Ref, data: any) { writes.push({ op: 'update', collection: ref.collection, id: ref.id, data }); return this; },
    delete(ref: Ref) { writes.push({ op: 'delete', collection: ref.collection, id: ref.id }); return this; },
    async commit() { const response = await fetch('/api/turso/batch', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writes }) }); const data = await response.json().catch(()=>({})); if (!response.ok) throw new Error(data.error || 'No se pudo aplicar el lote en Turso.'); return data; }
  };
}
export async function runTransaction<T>(_db: any, callback: (tx: any) => Promise<T>): Promise<T> {
  const writes: any[] = [];
  const tx = {
    async get(ref: Ref) { return getDoc(ref); },
    set(ref: Ref, data: any, options?: { merge?: boolean }) { writes.push({ op: 'set', collection: ref.collection, id: ref.id, data, merge: !!options?.merge }); return tx; },
    update(ref: Ref, data: any) { writes.push({ op: 'update', collection: ref.collection, id: ref.id, data }); return tx; },
    delete(ref: Ref) { writes.push({ op: 'delete', collection: ref.collection, id: ref.id }); return tx; }
  };
  const result = await callback(tx);
  if (writes.length) {
    const response = await fetch('/api/turso/batch', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ writes }) });
    const data = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(data.error || 'La transacción Turso falló.');
  }
  return result;
}
