"use client";

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, LockKeyhole, UserRound, LogIn } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
      router.replace('/');
      router.refresh();
    } catch (e: any) {
      setError(e?.message || 'No se pudo conectar con Turso. Verifique internet y configuración del servidor.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border bg-card p-7 shadow-xl">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <LockKeyhole className="h-8 w-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">PosVEN Pro</h1>
          <p className="mt-2 text-sm text-muted-foreground">Acceso seguro · Base de datos Turso</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <label htmlFor="username" className="text-sm font-medium">Usuario o correo</label>
            <div className="flex items-center gap-2 rounded-lg border px-3">
              <UserRound className="h-4 w-4 text-muted-foreground" />
              <input id="username" name="username" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} className="h-11 w-full bg-transparent outline-none" placeholder="Ingrese su usuario" />
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium">Contraseña</label>
            <div className="flex items-center gap-2 rounded-lg border px-3">
              <LockKeyhole className="h-4 w-4 text-muted-foreground" />
              <input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="h-11 w-full bg-transparent outline-none" placeholder="Ingrese su contraseña" />
              <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} className="rounded p-1 text-muted-foreground">
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
          <button type="submit" disabled={loading} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">
            <LogIn className="h-4 w-4" />
            {loading ? 'Validando acceso…' : 'Iniciar sesión'}
          </button>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">La autenticación y los datos operativos se validan en el servidor contra Turso.</p>
      </section>
    </main>
  );
}
