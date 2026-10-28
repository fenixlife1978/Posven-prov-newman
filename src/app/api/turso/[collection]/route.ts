import { NextRequest, NextResponse } from 'next/server';
import { getTurso, getSessionUser, COLLECTIONS, newId, hashPassword } from '@/lib/turso/server';

export const runtime = 'nodejs';
type Context = { params: Promise<{ collection: string }> };
const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

async function authorize(request: NextRequest) {
  const user = await getSessionUser(request.cookies.get('posven_session')?.value);
  return user;
}
function parseRow(row: Record<string, any>) {
  try { return JSON.parse(String(row.data_json ?? '{}')); } catch { return {}; }
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const user = await authorize(request);
    if (!user) return json({ error: 'Sesión no válida.' }, 401);
    const { collection } = await context.params;
    if (!COLLECTIONS.has(collection)) return json({ error: 'Colección no permitida.' }, 404);
    const id = request.nextUrl.searchParams.get('id');
    const db = await getTurso();
    if (collection === 'users') {
      if (user.rol !== 'administrador') return json({ error: 'Permisos insuficientes.' }, 403);
      const sql = id
        ? 'SELECT id,username,email,nombre,rol,acceso_bloqueado,is_seed_admin,data_json FROM users WHERE id=?'
        : 'SELECT id,username,email,nombre,rol,acceso_bloqueado,is_seed_admin,data_json FROM users ORDER BY username';
      const r = await db.execute(id ? { sql, args: [id] } : sql);
      const safe = r.rows.map((row: any) => ({ ...JSON.parse(String(row.data_json || '{}')), id: String(row.id), uid: String(row.id), username: String(row.username), email: row.email ? String(row.email) : '', nombre: String(row.nombre), rol: String(row.rol), accesoBloqueado: Number(row.acceso_bloqueado) === 1, isSeedAdmin: Number(row.is_seed_admin) === 1 }));
      return id ? (safe.length ? json(safe[0]) : json(null,404)) : json(safe);
    }
    if (collection === 'config' && id) {
      const r = await db.execute({ sql: 'SELECT data_json FROM app_config WHERE id=?', args: [id] });
      return r.rows.length ? json(parseRow(r.rows[0] as Record<string, any>)) : json(null, 404);
    }
    if (collection === 'catalogos' && id) {
      const r = await db.execute({ sql: 'SELECT lista_json FROM catalogos WHERE nombre=?', args: [id] }).catch(() => ({ rows: [] as any[] }));
      return r.rows.length ? json({ lista: JSON.parse(String((r.rows[0] as any).lista_json || '[]')) }) : json({ lista: [] }, 200);
    }
    if (id) {
      const r = await db.execute({ sql: 'SELECT data_json,revision FROM pos_records WHERE collection=? AND id=?', args: [collection, id] });
      return r.rows.length ? json({ ...parseRow(r.rows[0] as Record<string, any>), __tursoRevision: Number((r.rows[0] as any).revision || 1) }) : json(null, 404);
    }
    if (collection === 'catalogos') {
      const r = await db.execute('SELECT nombre,lista_json,data_json FROM catalogos ORDER BY nombre');
      return json(r.rows.map((row: any) => ({ id: String(row.nombre), lista: JSON.parse(String(row.lista_json || '[]')), ...JSON.parse(String(row.data_json || '{}')) })));
    }
    if (collection === 'operaciones') {
      const r = await db.execute('SELECT id,operation_id,data_json FROM operaciones ORDER BY created_at DESC LIMIT 5000');
      return json(r.rows.map((row: any) => ({ id: String(row.id), ...JSON.parse(String(row.data_json || '{}')), operationId: String(row.operation_id) })));
    }
    if (collection === 'auditoriaSistema') {
      const r = await db.execute('SELECT id,tipo,usuario_id,fecha,data_json FROM auditoria_sistema ORDER BY created_at DESC LIMIT 5000');
      return json(r.rows.map((row: any) => ({ id: String(row.id), tipo: row.tipo, usuarioId: row.usuario_id, fecha: row.fecha, ...JSON.parse(String(row.data_json || '{}')) })));
    }
    const limit = Math.min(5000, Math.max(1, Number(request.nextUrl.searchParams.get('limit') || 1000)));
    const r = await db.execute({ sql: 'SELECT id,data_json,revision FROM pos_records WHERE collection=? ORDER BY updated_at DESC LIMIT ?', args: [collection, limit] });
    return json(r.rows.map(row => ({ id: String((row as any).id), ...parseRow(row as Record<string, any>), __tursoRevision: Number((row as any).revision || 1) })));
  } catch (error) {
    console.error('[turso-data/get]', error);
    return json({ error: 'No se pudieron leer los datos de Turso.' }, 503);
  }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    const user = await authorize(request);
    if (!user) return json({ error: 'Sesión no válida.' }, 401);
    if (user.rol !== 'administrador' && !['ventas','productos','movimientos','caja'].includes((await context.params).collection)) return json({ error: 'Permisos insuficientes.' }, 403);
    const { collection } = await context.params;
    if (!COLLECTIONS.has(collection)) return json({ error: 'Colección no permitida.' }, 404);
    const body = await request.json();
    const id = String(body?.id ?? newId());
    const data = body?.data ?? body;
    const db = await getTurso();
    if (collection === 'users') {
      const username = String(data?.username || data?.email || '').trim().toLowerCase();
      const email = String(data?.email || '').trim().toLowerCase() || null;
      const nombre = String(data?.nombre || username).trim();
      const rol = String(data?.rol || 'cajero').toLowerCase();
      if (!username || !['administrador','cajero'].includes(rol)) return json({ error: 'Usuario y rol válidos son obligatorios.' },400);
      if (String(id) === 'seed-admin' && rol !== 'administrador') return json({ error: 'No se puede degradar el administrador semilla.' },403);
      let passwordHash: string | null = null;
      if (data?.password) passwordHash = await hashPassword(String(data.password));
      const existing = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id=?', args: [id] });
      if (!existing.rows.length && !passwordHash) return json({ error: 'La contraseña es obligatoria para crear un usuario.' },400);
      const hash = passwordHash || String((existing.rows[0] as any).password_hash);
      const userData = { ...data, id, uid: id, username, email, nombre, rol, accesoBloqueado: !!data?.accesoBloqueado };
      delete (userData as any).password;
      await db.execute({ sql: `INSERT INTO users(id,username,email,nombre,rol,password_hash,acceso_bloqueado,is_seed_admin,data_json,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username,email=excluded.email,nombre=excluded.nombre,rol=excluded.rol,password_hash=excluded.password_hash,acceso_bloqueado=excluded.acceso_bloqueado,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP`,
        args: [id, username, email, nombre, rol, hash, data?.accesoBloqueado ? 1 : 0, id === 'seed-admin' ? 1 : 0, JSON.stringify(userData)] });
      return json({ ok: true, id });
    }
    if (collection === 'config') {
      await db.execute({ sql: 'INSERT INTO app_config (id,data_json,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP', args: [id, JSON.stringify(data)] });
    } else if (collection === 'catalogos') {
      await db.execute('CREATE TABLE IF NOT EXISTS catalogos (nombre TEXT PRIMARY KEY, lista_json TEXT NOT NULL DEFAULT \'[]\', data_json TEXT NOT NULL DEFAULT \'{}\', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      await db.execute({ sql: 'INSERT INTO catalogos (nombre,lista_json,data_json,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(nombre) DO UPDATE SET lista_json=excluded.lista_json,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP', args: [id, JSON.stringify(Array.isArray(data) ? data : (data.lista || [])), JSON.stringify(data)] });
    } else if (collection === 'auditoriaSistema') {
      await db.execute({ sql: 'INSERT INTO auditoria_sistema(id,tipo,usuario_id,fecha,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tipo=excluded.tipo,usuario_id=excluded.usuario_id,fecha=excluded.fecha,data_json=excluded.data_json', args: [id, data?.tipo ?? null, data?.usuarioId ?? null, data?.fecha ?? new Date().toISOString(), JSON.stringify(data)] });
    } else if (collection === 'operaciones') {
      const opId = String(data?.operationId ?? id);
      await db.execute({ sql: 'INSERT INTO operaciones (id,operation_id,data_json) VALUES (?,?,?) ON CONFLICT(operation_id) DO NOTHING', args: [id, opId, JSON.stringify(data)] });
    } else {
      await db.execute({ sql: 'INSERT INTO pos_records (collection,id,data_json,revision,updated_at) VALUES (?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(collection,id) DO UPDATE SET data_json=excluded.data_json,revision=pos_records.revision+1,updated_at=CURRENT_TIMESTAMP', args: [collection, id, JSON.stringify(data)] });
    }
    return json({ ok: true, id });
  } catch (error) {
    console.error('[turso-data/put]', error);
    return json({ error: 'No se pudo guardar en Turso.' }, 503);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const user = await authorize(request);
    if (!user || user.rol !== 'administrador') return json({ error: 'Permisos insuficientes.' }, 403);
    const { collection } = await context.params;
    if (!COLLECTIONS.has(collection)) return json({ error: 'Colección no permitida.' }, 404);
    const id = request.nextUrl.searchParams.get('id');
    if (!id) return json({ error: 'Falta id.' }, 400);
    const db = await getTurso();
    if (collection === 'users') {
      if (id === 'seed-admin') return json({ error: 'No se puede eliminar el administrador semilla.' },403);
      await db.execute({ sql: 'DELETE FROM users WHERE id=?', args: [id] });
      return json({ ok: true });
    }
    if (collection === 'config') await db.execute({ sql: 'DELETE FROM app_config WHERE id=?', args: [id] });
    else if (collection === 'catalogos') await db.execute({ sql: 'DELETE FROM catalogos WHERE nombre=?', args: [id] });
    else await db.execute({ sql: 'DELETE FROM pos_records WHERE collection=? AND id=?', args: [collection, id] });
    return json({ ok: true });
  } catch (error) {
    console.error('[turso-data/delete]', error);
    return json({ error: 'No se pudo eliminar en Turso.' }, 503);
  }
}
