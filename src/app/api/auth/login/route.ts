import { NextRequest, NextResponse } from 'next/server';
import { getTurso, getSessionUser, newId, verifyPassword } from '@/lib/turso/server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const username = String(body?.username ?? body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    if (!username || !password) return NextResponse.json({ error: 'Indique usuario y contraseña.' }, { status: 400 });
    const db = await getTurso();
    const result = await db.execute({
      sql: 'SELECT id,username,email,nombre,rol,password_hash,acceso_bloqueado,data_json FROM users WHERE lower(username)=? OR lower(email)=? LIMIT 1',
      args: [username, username]
    });
    if (!result.rows.length) return NextResponse.json({ error: 'Usuario o contraseña incorrectos.' }, { status: 401 });
    const user = result.rows[0] as Record<string, any>;
    if (Number(user.acceso_bloqueado) || !(await verifyPassword(password, String(user.password_hash)))) {
      return NextResponse.json({ error: 'Usuario o contraseña incorrectos.' }, { status: 401 });
    }
    const sessionId = newId();
    await db.execute({ sql: `INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,datetime('now','+7 days'))`, args: [sessionId, String(user.id)] });
    const response = NextResponse.json({
      user: { id: String(user.id), username: String(user.username), email: user.email ? String(user.email) : null, nombre: String(user.nombre), rol: String(user.rol), ...JSON.parse(String(user.data_json || '{}')) }
    });
    response.cookies.set('posven_session', sessionId, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
    return response;
  } catch (error) {
    console.error('[turso-auth/login]', error);
    return NextResponse.json({ error: 'No se pudo conectar con la base de datos Turso.' }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request.cookies.get('posven_session')?.value);
    return user ? NextResponse.json({ user }) : NextResponse.json({ user: null }, { status: 401 });
  } catch {
    return NextResponse.json({ error: 'No se pudo validar la sesión Turso.' }, { status: 503 });
  }
}
