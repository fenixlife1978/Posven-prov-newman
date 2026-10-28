import { NextRequest, NextResponse } from 'next/server';
import { getTurso, getSessionUser } from '@/lib/turso/server';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const session = await getSessionUser(request.cookies.get('posven_session')?.value).catch(() => null);
  if (!session) return NextResponse.json({ error: 'Sesión no válida.' }, { status: 401 });
  let tx: any;
  try {
    const body = await request.json();
    const writes = Array.isArray(body?.writes) ? body.writes : [];
    if (!writes.length || writes.length > 500) return NextResponse.json({ error: 'Lote vacío o demasiado grande.' }, { status: 400 });
    const allowed = new Set(['productos','movimientos','ventas','cxc','cxp','clientes','proveedores','devoluciones','anulaciones','terminales','libroDiario','reportesZ','caja','compras','catalogos','config','operaciones','auditoriaSistema','users']);
    const db = await getTurso();
    tx = await db.transaction('write');
    const checkedRevisions = new Set<string>();
    for (const w of writes) {
      if (!allowed.has(String(w.collection)) || !w.id) throw new Error('Colección o identificador inválido.');
      const collection = String(w.collection), id = String(w.id);
      const revisionKey = collection + '/' + id;
      if (w.checkRevision === true && !checkedRevisions.has(revisionKey) && !['config','catalogos','users','operaciones','auditoriaSistema'].includes(collection)) {
        const current = await tx.execute({ sql: 'SELECT revision FROM pos_records WHERE collection=? AND id=?', args: [collection, id] });
        const currentRevision = current.rows.length ? Number((current.rows[0] as any).revision || 1) : null;
        const expectedRevision = w.expectedRevision == null ? null : Number(w.expectedRevision);
        if (currentRevision !== expectedRevision) throw new Error('Conflicto de concurrencia en ' + collection + '/' + id + '. Vuelva a cargar los datos antes de repetir la operación.');
        checkedRevisions.add(revisionKey);
      }
      if (collection === 'config') {
        if (w.op === 'delete') await tx.execute({ sql: 'DELETE FROM app_config WHERE id=?', args: [id] });
        else {
          let data = w.data ?? {};
          if (w.merge || w.op === 'update') {
            const old = await tx.execute({ sql: 'SELECT data_json FROM app_config WHERE id=?', args: [id] });
            if (w.op === 'update' && !old.rows.length) throw new Error('El documento de configuración no existe.');
            data = { ...(old.rows.length ? JSON.parse(String((old.rows[0] as any).data_json)) : {}), ...data };
          }
          await tx.execute({ sql: 'INSERT INTO app_config(id,data_json,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP', args: [id, JSON.stringify(data)] });
        }
      } else if (collection === 'catalogos') {
        if (w.op === 'delete') await tx.execute({ sql: 'DELETE FROM catalogos WHERE nombre=?', args: [id] });
        else {
          let data = w.data ?? [];
          if (w.merge || w.op === 'update') {
            const old = await tx.execute({ sql: 'SELECT data_json,lista_json FROM catalogos WHERE nombre=?', args: [id] });
            if (w.op === 'update' && !old.rows.length) throw new Error('El catálogo no existe.');
            if (old.rows.length) data = { ...JSON.parse(String((old.rows[0] as any).data_json || '{}')), ...data };
          }
          const list = Array.isArray(data) ? data : (data.lista || []);
          await tx.execute({ sql: 'INSERT INTO catalogos(nombre,lista_json,data_json,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(nombre) DO UPDATE SET lista_json=excluded.lista_json,data_json=excluded.data_json,updated_at=CURRENT_TIMESTAMP', args: [id, JSON.stringify(list), JSON.stringify(Array.isArray(data) ? { lista: data } : data)] });
        }
      } else if (collection === 'users') {
        if (session.rol !== 'administrador') throw new Error('Permisos insuficientes para modificar usuarios.');
        if (w.op === 'delete') {
          if (id === 'seed-admin') throw new Error('No se puede eliminar el administrador semilla.');
          await tx.execute({ sql: 'DELETE FROM users WHERE id=?', args: [id] });
        } else {
          const old = await tx.execute({ sql: 'SELECT password_hash,is_seed_admin FROM users WHERE id=?', args: [id] });
          if (!old.rows.length) throw new Error('No se pueden restaurar credenciales desde un respaldo. Cree los usuarios desde el módulo Personal.');
          const current = JSON.parse(String((await tx.execute({sql:'SELECT data_json FROM users WHERE id=?',args:[id]})).rows[0]?.data_json || '{}'));
          const data = { ...current, ...(w.data || {}), id, uid: id };
          const username = String(data.username || data.email || current.username || '').trim().toLowerCase();
          const email = String(data.email || '').trim().toLowerCase() || null;
          const nombre = String(data.nombre || username);
          const rol = String(data.rol || 'cajero').toLowerCase();
          if (!username || !['administrador','cajero'].includes(rol) || (id === 'seed-admin' && rol !== 'administrador')) throw new Error('Datos de usuario o rol inválidos.');
          await tx.execute({ sql: 'UPDATE users SET username=?,email=?,nombre=?,rol=?,acceso_bloqueado=?,data_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?', args: [username,email,nombre,rol,data.accesoBloqueado ? 1 : 0,JSON.stringify(data),id] });
        }
      } else if (collection === 'auditoriaSistema') {
        if (w.op === 'delete') await tx.execute({ sql: 'DELETE FROM auditoria_sistema WHERE id=?', args: [id] });
        else {
          const data = w.data ?? {};
          await tx.execute({ sql: 'INSERT INTO auditoria_sistema(id,tipo,usuario_id,fecha,data_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET tipo=excluded.tipo,usuario_id=excluded.usuario_id,fecha=excluded.fecha,data_json=excluded.data_json', args: [id, data.tipo ?? null, data.usuarioId ?? null, data.fecha ?? new Date().toISOString(), JSON.stringify(data)] });
        }
      } else if (collection === 'operaciones') {
        if (w.op === 'delete') await tx.execute({ sql: 'DELETE FROM operaciones WHERE id=?', args: [id] });
        else {
          const data = w.data ?? {};
          const opId = String(data.operationId ?? data.operation_id ?? id);
          // Las operaciones de negocio son estrictamente idempotentes; una restauración mergeada
          // puede omitir IDs ya presentes sin duplicar registros.
          if (w.merge) {
            await tx.execute({ sql: 'INSERT OR IGNORE INTO operaciones(id,operation_id,data_json) VALUES(?,?,?)', args: [id, opId, JSON.stringify(data)] });
          } else {
            await tx.execute({ sql: 'INSERT INTO operaciones(id,operation_id,data_json) VALUES(?,?,?)', args: [id, opId, JSON.stringify(data)] });
          }
        }
      } else if (w.op === 'delete') {
        await tx.execute({ sql: 'DELETE FROM pos_records WHERE collection=? AND id=?', args: [collection, id] });
      } else {
        let data = w.data ?? {};
        if (w.merge || w.op === 'update') {
          const old = await tx.execute({ sql: 'SELECT data_json FROM pos_records WHERE collection=? AND id=?', args: [collection, id] });
          if (w.op === 'update' && !old.rows.length) throw new Error('El registro no existe: ' + collection + '/' + id);
          data = { ...(old.rows.length ? JSON.parse(String((old.rows[0] as any).data_json)) : {}), ...data };
        }
        await tx.execute({ sql: 'INSERT INTO pos_records(collection,id,data_json,revision,updated_at) VALUES(?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(collection,id) DO UPDATE SET data_json=excluded.data_json,revision=pos_records.revision+1,updated_at=CURRENT_TIMESTAMP', args: [collection, id, JSON.stringify(data)] });
      }
    }
    await tx.commit();
    return NextResponse.json({ ok: true, applied: writes.length });
  } catch (error: any) {
    try { await tx?.rollback(); } catch {}
    console.error('[turso-batch]', error);
    const duplicate = /UNIQUE constraint failed.*operation_id/i.test(String(error?.message || ''));
    return NextResponse.json({ error: duplicate ? 'Esta operación ya fue procesada y no se duplicó.' : String(error?.message || 'La transacción Turso falló.') }, { status: duplicate ? 409 : 503 });
  }
}
