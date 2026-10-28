import { NextRequest, NextResponse } from 'next/server';
import { getTurso } from '@/lib/turso/server';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const id = request.cookies.get('posven_session')?.value;
    if (id) {
      const db = await getTurso();
      await db.execute({ sql: 'UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND revoked_at IS NULL', args: [id] });
    }
  } catch (error) {
    console.error('[turso-auth/logout]', error);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set('posven_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
