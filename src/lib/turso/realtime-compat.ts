'use client';
import { collection, getDocs, onSnapshot, writeBatch } from '@/lib/turso/firestore-compat';

export function ref(_database: any, path: string) { return { path }; }
export function onValue(reference: {path: string}, callback: (snapshot: {val:()=>any})=>void, error?: (e:any)=>void) {
  const read = async () => {
    try {
      const result = await getDocs(collection({}, 'productos'));
      const value: Record<string, any> = {};
      for (const item of result.docs) value[item.id] = item.data();
      callback({ val: () => value });
    } catch (e) { error?.(e); }
  };
  void read();
  const timer = window.setInterval(() => { if (navigator.onLine) void read(); }, 5000);
  const online = () => { void read(); };
  window.addEventListener('online', online);
  return () => { window.clearInterval(timer); window.removeEventListener('online', online); };
}
export async function update(reference: {path:string}, value: any) {
  if (!reference.path.includes('productos') || !value || typeof value !== 'object') return;
  const batch = writeBatch({});
  for (const [id, data] of Object.entries(value)) batch.set({kind:'doc',collection:'productos',id} as any, data);
  await batch.commit();
}
export async function get(_database: any, reference: {path:string}) {
  const result = await getDocs(collection({}, 'productos'));
  const value: Record<string, any> = {};
  for (const item of result.docs) value[item.id] = item.data();
  return { val: () => value, exists: () => Object.keys(value).length > 0 };
}
