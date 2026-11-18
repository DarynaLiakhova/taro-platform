// Подменённый Supabase для тестов: вход, таблица docs, хранилище файлов (TUS),
// подписанные ссылки на видео и функция расшифровки. Всё живёт в памяти одного теста,
// поэтому ученица и Лена в двух окнах видят одну и ту же «базу», а настоящая база не трогается.
const crypto = require('crypto');
const { makeDb } = require('../db/harness');

const SB = 'https://gdkxyjlarmwigxfsggni.supabase.co';

class SupabaseMock {
  constructor(db) {
    this.db = db;                // PGlite со всеми правилами доступа (docs, masters)
    this.users = new Map();      // email -> user
    this.tokens = new Map();     // token -> user id
    this.files = new Map();      // bucket/path -> { type, data }
    this.uploads = new Map();    // id -> TUS upload in progress
    this.transcript = 'Тестовая расшифровка голосового';
    this.log = [];
  }

  static async create({ migrate = true } = {}) {
    return new SupabaseMock(await makeDb({ migrate }));
  }

  async close() { await this.db.close(); }

  async addUser(email, password, name = '', master = false) {
    const id = crypto.randomUUID();
    await this.db.addUser(email, id);
    if (master) await this.db.makeMaster(id);
    this.users.set(email, { id, email, password, name });
    return id;
  }

  /** Подключить подмену к окну браузера (context) */
  async attach(context) {
    await context.route(SB + '/**', (route) => this.handle(route));
    await context.route('https://fonts.googleapis.com/**', (r) => r.abort());
    await context.route('https://fonts.gstatic.com/**', (r) => r.abort());
  }

  session(u) {
    const t = 'tok-' + crypto.randomUUID(), r = 'ref-' + crypto.randomUUID();
    this.tokens.set(t, u.id); this.tokens.set(r, u.id);
    return { access_token: t, refresh_token: r, expires_in: 3600, token_type: 'bearer',
      user: { id: u.id, email: u.email, user_metadata: { name: u.name } } };
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname, q = url.searchParams, m = req.method();
    const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*',
      'access-control-expose-headers': 'Location, Upload-Offset, Tus-Resumable' };
    const json = (status, body) => route.fulfill({ status, headers: { ...H, 'content-type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: H });
    this.log.push(m + ' ' + path);

    const auth = req.headers()['authorization'] || '';
    const uid = auth.startsWith('Bearer ') ? this.tokens.get(auth.slice(7)) : undefined;
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch { return {}; } };

    // --- вход и регистрация
    if (path === '/auth/v1/signup') {
      const b = body();
      if (this.users.has(b.email)) return json(422, { code: 'user_already_exists', msg: 'User already registered' });
      await this.addUser(b.email, b.password, (b.data || {}).name || '');
      return json(200, this.session(this.users.get(b.email)));
    }
    if (path === '/auth/v1/token') {
      const b = body();
      if (q.get('grant_type') === 'password') {
        const u = this.users.get(b.email);
        if (!u || u.password !== b.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return json(200, this.session(u));
      }
      const id = this.tokens.get(b.refresh_token);
      const u = [...this.users.values()].find((x) => x.id === id);
      return u ? json(200, this.session(u)) : json(400, { error: 'invalid_grant' });
    }
    if (path === '/auth/v1/user') {
      const u = [...this.users.values()].find((x) => x.id === uid);
      if (!u) return json(401, { msg: 'bad jwt' });
      return json(200, { id: u.id, email: u.email, user_metadata: { name: u.name } });
    }
    if (path === '/auth/v1/logout') return json(204);
    if (path === '/auth/v1/recover') return json(200, {});

    // --- хранилище: публичные файлы чата и подписанные ссылки на видео (без входа)
    if (path.startsWith('/storage/v1/object/public/')) return this.serve(route, decodeURIComponent(path.slice('/storage/v1/object/public/'.length)), H);
    if (path.startsWith('/storage/v1/object/sign/') && m === 'GET') return this.serve(route, decodeURIComponent(path.slice('/storage/v1/object/sign/'.length)), H);

    if (!uid) return json(401, { code: 'PGRST301', message: 'JWT required' });

    // --- хранилище: загрузка кусками (TUS)
    if (path === '/storage/v1/upload/resumable' && m === 'POST') {
      const h = req.headers();
      const meta = Object.fromEntries((h['upload-metadata'] || '').split(',').map((p) => {
        const [k, v] = p.trim().split(' '); return [k, Buffer.from(v || '', 'base64').toString()];
      }));
      if (!(await this.isMaster(uid)) && !meta.objectName.startsWith(uid + '/')) return json(403, { error: 'Unauthorized', message: 'new row violates row-level security policy' });
      const id = String(this.uploads.size + 1);
      this.uploads.set(id, { bucket: meta.bucketName, name: meta.objectName, type: meta.contentType, length: +h['upload-length'], data: Buffer.alloc(0) });
      return route.fulfill({ status: 201, headers: { ...H, Location: SB + '/storage/v1/upload/resumable/' + id } });
    }
    if (path.startsWith('/storage/v1/upload/resumable/')) {
      const up = this.uploads.get(path.split('/').pop());
      if (!up) return json(404, { error: 'not found' });
      if (m === 'PATCH') {
        up.data = Buffer.concat([up.data, req.postDataBuffer() || Buffer.alloc(0)]);
        if (up.data.length >= up.length) this.files.set(up.bucket + '/' + up.name, { type: up.type, data: up.data });
      }
      return route.fulfill({ status: m === 'PATCH' ? 204 : 200, headers: { ...H, 'Upload-Offset': String(up.data.length) } });
    }
    if (path.startsWith('/storage/v1/object/sign/') && m === 'POST') {
      const key = decodeURIComponent(path.slice('/storage/v1/object/sign/'.length));
      return json(200, { signedURL: '/object/sign/' + key + '?token=test' });
    }

    // --- функция расшифровки голосовых
    if (path === '/functions/v1/transcribe') return json(200, { text: this.transcript });

    // --- база: таблица docs (настоящий Postgres с боевыми правилами доступа)
    if (path === '/rest/v1/rpc/is_master') return json(200, await this.isMaster(uid));
    if (path === '/rest/v1/docs') {
      const r = await this.docsRequest(m, q, body(), req.headers()['prefer'] || '', uid);
      return json(r.status, r.body);
    }
    return json(404, { message: 'mock: unknown ' + m + ' ' + path });
  }

  async isMaster(uid) {
    const { rows } = await this.db.as(uid, 'select public.is_master() as m');
    return !!(rows[0] && rows[0].m);
  }

  // Перевод запроса PostgREST к таблице docs в SQL от имени пользователя
  async docsRequest(m, q, b, prefer, uid) {
    const ver = "to_json(updated_at)#>>'{}'";
    const COLS = ['path', 'owner', 'data', 'updated_at'];
    const colSql = (c) => (c === 'updated_at' ? `${ver} as updated_at` : `"${c}"`);
    const cols = (q.get('select') || COLS.join(',')).split(',').map((c) => c.trim()).filter((c) => COLS.includes(c));
    const sel = (cols.length ? cols : COLS).map(colSql).join(', ');
    const params = [];
    const where = [];
    const add = (v) => { params.push(v); return '$' + params.length; };
    const f = q.get('path');
    if (f && f.startsWith('eq.')) where.push(`path = ${add(f.slice(3))}`);
    else if (f && f.startsWith('in.(')) {
      const list = [...f.slice(4, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\(.)/g, '$1'));
      where.push(`path = any(${add(list)}::text[])`);
    }
    const u = q.get('updated_at');
    if (u && u.startsWith('eq.')) where.push(`updated_at = ${add(u.slice(3))}::timestamptz`);
    const w = where.length ? ' where ' + where.join(' and ') : '';
    let r;
    if (m === 'GET') {
      const off = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
      const lim = Math.max(0, parseInt(q.get('limit') || '1000000', 10) || 0);
      r = await this.db.as(uid, `select ${sel} from public.docs${w} order by path limit ${lim} offset ${off}`, params);
    } else if (m === 'POST') {
      const rows = Array.isArray(b) ? b : [b];
      const out = [];
      for (const x of rows) {
        r = await this.db.as(uid,
          `insert into public.docs(path, owner, data) values ($1, $2, $3::jsonb)
           on conflict (path) do update set owner = excluded.owner, data = excluded.data returning ${sel}`,
          [x.path, x.owner ?? null, JSON.stringify(x.data)]);
        if (r.error) break;
        out.push(...r.rows);
      }
      if (!r.error) r = { rows: out, error: null };
    } else if (m === 'PATCH') {
      const sets = [];
      if ('data' in b) sets.push(`data = ${add(JSON.stringify(b.data))}::jsonb`);
      if ('owner' in b) sets.push(`owner = ${add(b.owner ?? null)}`);
      if (!sets.length) return { status: 200, body: [] };
      r = await this.db.as(uid, `update public.docs set ${sets.join(', ')}${w} returning ${sel}`, params);
    } else if (m === 'DELETE') {
      r = await this.db.as(uid, `delete from public.docs${w}`, params);
      return r.error ? this.pgError(r.error) : { status: 204 };
    } else return { status: 405, body: { message: 'mock: method ' + m } };
    if (r.error) return this.pgError(r.error);
    return { status: m === 'POST' ? 201 : 200, body: r.rows };
  }

  pgError(e) {
    return { status: e.code === '42501' ? 403 : 400, body: { code: e.code || 'XX000', message: e.message } };
  }

  serve(route, key, H) {
    const f = this.files.get(key);
    if (!f) return route.fulfill({ status: 404, headers: H });
    return route.fulfill({ status: 200, headers: { ...H, 'content-type': f.type }, body: f.data });
  }

  /** Файлы, которые загрузил пользователь, в нужном хранилище */
  filesOf(bucket, userId) { return [...this.files.keys()].filter((k) => k.startsWith(bucket + '/' + userId + '/')); }
}

module.exports = { SupabaseMock };
