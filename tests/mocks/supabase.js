// Подменённый Supabase для тестов: вход, таблица docs, хранилище файлов (TUS),
// подписанные ссылки на видео и функция расшифровки. Всё живёт в памяти одного теста,
// поэтому ученица и Лена в двух окнах видят одну и ту же «базу», а настоящая база не трогается.
const crypto = require('crypto');

const SB = 'https://gdkxyjlarmwigxfsggni.supabase.co';

class SupabaseMock {
  constructor() {
    this.users = new Map();      // email -> user
    this.tokens = new Map();     // token -> user id
    this.masters = new Set();
    this.docs = new Map();       // path -> row
    this.files = new Map();      // bucket/path -> { type, data }
    this.uploads = new Map();    // id -> TUS upload in progress
    this.seq = 0;
    this.transcript = 'Тестовая расшифровка голосового';
    this.log = [];
  }

  addUser(email, password, name = '', master = false) {
    const id = crypto.randomUUID();
    this.users.set(email, { id, email, password, name });
    if (master) this.masters.add(id);
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

  stamp() { return new Date().toISOString().replace('Z', String(++this.seq).padStart(6, '0') + '+00:00'); }

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
      this.addUser(b.email, b.password, (b.data || {}).name || '');
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
    const master = this.masters.has(uid);

    // --- хранилище: загрузка кусками (TUS)
    if (path === '/storage/v1/upload/resumable' && m === 'POST') {
      const h = req.headers();
      const meta = Object.fromEntries((h['upload-metadata'] || '').split(',').map((p) => {
        const [k, v] = p.trim().split(' '); return [k, Buffer.from(v || '', 'base64').toString()];
      }));
      if (!master && !meta.objectName.startsWith(uid + '/')) return json(403, { error: 'Unauthorized', message: 'new row violates row-level security policy' });
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

    // --- база: таблица docs
    if (path === '/rest/v1/rpc/is_master') return json(200, master);
    if (path === '/rest/v1/docs') {
      const visible = (d) => master || d.owner === uid || d.owner === null;
      const can = (owner) => master || owner === uid;
      if (m === 'GET') {
        let rows = [...this.docs.values()].filter(visible);
        const f = q.get('path');
        if (f && f.startsWith('eq.')) rows = rows.filter((d) => d.path === f.slice(3));
        if (f && f.startsWith('in.(')) { const want = f.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, '')); rows = rows.filter((d) => want.includes(d.path)); }
        rows.sort((a, b) => a.path.localeCompare(b.path));
        const off = +(q.get('offset') || 0), lim = +(q.get('limit') || 1e6);
        const cols = (q.get('select') || 'path,owner,data,updated_at').split(',');
        return json(200, rows.slice(off, off + lim).map((d) => Object.fromEntries(cols.map((c) => [c, d[c]]))));
      }
      if (m === 'POST') {
        const b = body(), ex = this.docs.get(b.path);
        if (!can(b.owner) || (ex && !can(ex.owner))) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
        const ts = this.stamp();
        this.docs.set(b.path, { path: b.path, owner: b.owner, data: b.data, updated_at: ts });
        return json(201, [{ updated_at: ts }]);
      }
      if (m === 'PATCH') {
        const p = (q.get('path') || '').slice(3), ver = q.get('updated_at'), d = this.docs.get(p);
        if (!d || !can(d.owner) || (ver && d.updated_at !== ver.slice(3))) return json(200, []);
        d.data = body().data; d.updated_at = this.stamp();
        return json(200, [{ updated_at: d.updated_at }]);
      }
      if (m === 'DELETE') {
        const p = (q.get('path') || '').slice(3), d = this.docs.get(p);
        if (d && can(d.owner)) this.docs.delete(p);
        return json(204);
      }
    }
    return json(404, { message: 'mock: unknown ' + m + ' ' + path });
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
