'use client';

export const browserSessionPersistence = 'session';
export const auth: { currentUser: any } = { currentUser: null };
export async function setPersistence(_auth: any, _persistence: any) { return; }

export function onAuthStateChanged(_auth: any, callback: (user: any) => void, error?: (e:any)=>void) {
  let active = true;
  fetch('/api/auth/login', { credentials: 'same-origin', cache: 'no-store' })
    .then(async response => response.ok ? response.json() : { user: null })
    .then(data => { if (active) { auth.currentUser = data.user ? { ...data.user, uid: data.user.id, email: data.user.email } : null; callback(auth.currentUser); } })
    .catch(e => { if (active) { auth.currentUser = null; error?.(e); callback(null); } });
  return () => { active = false; };
}

export async function signInWithEmailAndPassword(_auth: any, username: string, password: string) {
  const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(data.error || 'No se pudo iniciar sesión.');
    error.code = response.status === 401 ? 'auth/invalid-credential' : 'auth/network-request-failed';
    throw error;
  }
  auth.currentUser = { ...data.user, uid: data.user.id, email: data.user.email };
  return { user: auth.currentUser };
}

export async function signOut(_auth: any) {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  auth.currentUser = null;
}

export async function createUserWithEmailAndPassword() {
  throw new Error('El alta de usuarios debe realizarla un administrador desde el módulo Personal, con persistencia en Turso.');
}
