import 'server-only';
import { createClient, type Client } from '@libsql/client';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
let client: Client | null = null;
let schemaReady: Promise<void> | null = null;

function getClient(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error('Falta TURSO_DATABASE_URL o TURSO_AUTH_TOKEN en el entorno del servidor.');
  client = createClient({ url, authToken });
  return client;
}

const schema = [
  `CREATE TABLE IF NOT EXISTS app_config (id TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS pos_records (collection TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(collection,id))`,
  `CREATE TABLE IF NOT EXISTS catalogos (nombre TEXT PRIMARY KEY, lista_json TEXT NOT NULL DEFAULT '[]', data_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE INDEX IF NOT EXISTS idx_pos_records_collection_updated ON pos_records(collection,updated_at)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT, nombre TEXT NOT NULL, rol TEXT NOT NULL CHECK (rol IN ('administrador','cajero')), password_hash TEXT NOT NULL, acceso_bloqueado INTEGER NOT NULL DEFAULT 0, is_seed_admin INTEGER NOT NULL DEFAULT 0, data_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT, revoked_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS operaciones (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS auditoria_sistema (id TEXT PRIMARY KEY, tipo TEXT, usuario_id TEXT, fecha TEXT, data_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`
];

export async function getTurso(): Promise<Client> {
  const db = getClient();
  if (!schemaReady) {
    schemaReady = (async () => {
      for (const sql of schema) await db.execute(sql);
      const seed = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: ['admin'] });
      if (seed.rows.length === 0) {
        const salt = randomBytes(16).toString('hex');
        const derived = (await scrypt('admin123', salt, 64)) as Buffer;
        const hash = `scrypt$${salt}$${derived.toString('hex')}`;
        await db.execute({
          sql: 'INSERT INTO users (id,username,email,nombre,rol,password_hash,is_seed_admin,data_json) VALUES (?,?,?,?,?,?,1,?)',
          args: ['seed-admin', 'admin', null, 'ADMINISTRADOR', 'administrador', hash, JSON.stringify({ username: 'admin', nombre: 'ADMINISTRADOR', rol: 'administrador', is_seed_admin: true })]
        });
      }
    })().catch(error => { schemaReady = null; throw error; });
  }
  await schemaReady;
  return db;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [kind, salt, expectedHex] = String(encoded || '').split('$');
  if (kind !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function newId(): string { return randomBytes(24).toString('hex'); }

export async function getSessionUser(sessionId: string | undefined) {
  if (!sessionId) return null;
  const db = await getTurso();
  const result = await db.execute({
    sql: `SELECT u.id,u.username,u.email,u.nombre,u.rol,u.acceso_bloqueado,u.data_json
          FROM sessions s JOIN users u ON u.id=s.user_id
          WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP`,
    args: [sessionId]
  });
  if (!result.rows.length) return null;
  const row = result.rows[0] as Record<string, any>;
  if (Number(row.acceso_bloqueado)) return null;
  await db.execute({ sql: 'UPDATE sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?', args: [sessionId] });
  return { id: String(row.id), username: String(row.username), email: row.email ? String(row.email) : null, nombre: String(row.nombre), rol: String(row.rol), ...(JSON.parse(String(row.data_json || '{}'))) };
}

export const COLLECTIONS = new Set([
  'productos','movimientos','ventas','cxc','cxp','clientes','proveedores','devoluciones','anulaciones',
  'terminales','libroDiario','reportesZ','caja','compras','catalogos','config','operaciones','auditoriaSistema','users'
]);
