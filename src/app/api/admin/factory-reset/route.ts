import { NextRequest, NextResponse } from 'next/server';
import { getTurso, getSessionUser, hashPassword } from '@/lib/turso/server';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const sessionId = request.cookies.get('posven_session')?.value;
  const user = await getSessionUser(sessionId).catch(() => null);
  if (!user || user.rol !== 'administrador') {
    return NextResponse.json({ error: 'Solo un administrador puede reiniciar el sistema.' }, { status: 403 });
  }

  let tx: any;
  try {
    const body = await request.json().catch(() => ({}));
    const rate = Number(body?.tasa);
    const tasa = Number.isFinite(rate) && rate > 0 ? rate : 36.5;
    const empresa = {
      nombre: 'NOMBRE DE SU NEGOCIO',
      rif: 'J-00000000-0',
      direccion: 'DIRECCIÓN FISCAL',
      telefono: '0000-0000000'
    };
    const defaultConfig = {
      isInitialized: false,
      ultimoZ: 0,
      proximoRecibo: 1,
      proximaDevolucion: 1,
      proximaAnulacion: 1,
      acumuladoHistorico: 0,
      fechaUltimoZ: '',
      fondoCajaHoyUSD: 0,
      fondoCajaHoyBS: 0,
      tasa,
      pinDevolucion: '000000',
      empresa,
      config: { exchangeRate: tasa, ivaRate: 16, igtfRate: 3 }
    };

    const db = await getTurso();
    const passwordHash = await hashPassword('admin123');
    const seedData = { id: 'seed-admin', uid: 'seed-admin', username: 'admin', nombre: 'ADMINISTRADOR', rol: 'administrador', is_seed_admin: true, accesoBloqueado: false };

    tx = await db.transaction('write');
    await tx.execute('DELETE FROM pos_records');
    await tx.execute('DELETE FROM catalogos');
    await tx.execute('DELETE FROM operaciones');
    await tx.execute('DELETE FROM auditoria_sistema');
    await tx.execute('DELETE FROM app_config');
    await tx.execute({ sql: 'DELETE FROM users WHERE id <> ?', args: ['seed-admin'] });
    await tx.execute('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE revoked_at IS NULL');
    await tx.execute({
      sql: `INSERT INTO users(id,username,email,nombre,rol,password_hash,acceso_bloqueado,is_seed_admin,data_json,updated_at)
            VALUES('seed-admin','admin',NULL,'ADMINISTRADOR','administrador',?,0,1,?,CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET username='admin',email=NULL,nombre='ADMINISTRADOR',rol='administrador',password_hash=excluded.password_hash,acceso_bloqueado=0,is_seed_admin=1,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP`,
      args: [passwordHash, JSON.stringify(seedData)]
    });
    await tx.execute({ sql: 'INSERT INTO app_config(id,data_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)', args: ['general', JSON.stringify(defaultConfig)] });
    await tx.commit();

    const response = NextResponse.json({ ok: true, message: 'Sistema reiniciado en Turso. Se conservó el administrador semilla.' });
    response.cookies.set('posven_session', '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
    return response;
  } catch (error) {
    try { await tx?.rollback(); } catch {}
    console.error('[turso-factory-reset]', error);
    return NextResponse.json({ error: 'No se pudo completar el reinicio de fábrica en Turso.' }, { status: 503 });
  }
}
