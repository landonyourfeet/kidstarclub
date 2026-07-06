// KidStarClub — server.js
// Node/Express/Postgres on Railway. Env vars (Railway → Variables):
//   DATABASE_URL, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD,
//   XAI_API_KEY, XAI_MODEL=grok-4.3,
//   BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3
// Boot: applies db/schema.sql, seeds 300-member cast, ensures admin user.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bucket = require('./lib/bucket');
const castEngine = require('./lib/cast-engine');

const app = express();
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e?.message || e));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------- Auth (signed cookie sessions, zero deps) ----------
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (v) => `${v}.${crypto.createHmac('sha256', SECRET).update(v).digest('base64url')}`;
const unsign = (s) => { if (!s) return null; const i = s.lastIndexOf('.'); if (i < 0) return null;
  const v = s.slice(0, i); return sign(v) === s ? v : null; };
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
const checkPw = (pw, stored) => { const [salt, h] = (stored || '').split(':');
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32)); } catch { return false; } };

async function auth(req, res, next) {
  const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('ksc='));
  const uid = unsign(raw?.slice(4));
  if (uid) {
    const { rows: [u] } = await pool.query('SELECT id,role,display_name,username,status FROM users WHERE id=$1', [uid]);
    if (u && u.status === 'active') req.user = u;
    else if (u) return res.status(403).json({ error: u.status === 'banned' ? 'This account has been removed from the club.' : 'This account is paused. Ask the club admin.' });
  }
  next();
}
const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in.' });
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admins only.' });
app.use(auth);

const setSession = (res, uid) =>
  res.setHeader('Set-Cookie', `ksc=${sign(String(uid))}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);

// ---------- Auth routes ----------
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const { rows: [u] } = await pool.query('SELECT * FROM users WHERE lower(username)=lower($1)', [username || '']);
  if (!u || !checkPw(password || '', u.password_hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  if (u.status !== 'active') return res.status(403).json({ error: 'This account is not active.' });
  setSession(res, u.id);
  res.json({ id: u.id, role: u.role, display_name: u.display_name });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'ksc=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => res.json(req.user || null));

app.post('/api/join', async (req, res) => {
  const { code, username, password, display_name } = req.body || {};
  if (!code || !username || !password || !display_name) return res.status(400).json({ error: 'All fields are required.' });
  const { rows: [inv] } = await pool.query('SELECT * FROM invite_codes WHERE upper(code)=upper($1) AND NOT revoked AND uses < max_uses', [code.trim()]);
  if (!inv) return res.status(400).json({ error: 'That invite code is not valid.' });
  try {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (role,display_name,username,password_hash) VALUES ($1,$2,$3,$4) RETURNING id,role,display_name`,
      [inv.role, display_name.trim().slice(0, 40), username.trim().toLowerCase().slice(0, 30), hashPw(password)]);
    await pool.query('UPDATE invite_codes SET uses=uses+1 WHERE code=$1', [inv.code]);
    if (inv.role === 'kid')
      await pool.query(`INSERT INTO channels (owner_id,name) VALUES ($1,$2)`, [u.id, `${u.display_name}'s Stage`]);
    setSession(res, u.id);
    res.json(u);
  } catch (e) {
    if (String(e.message).includes('unique')) return res.status(400).json({ error: 'That username is taken.' });
    throw e;
  }
});

// ---------- Channels / feed ----------
app.get('/api/channels', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, u.display_name AS owner_name, u.avatar_emoji,
       (SELECT count(*)::int FROM videos v WHERE v.channel_id=c.id AND v.status='live') AS video_count
     FROM channels c JOIN users u ON u.id=c.owner_id WHERE u.status='active' ORDER BY c.id`);
  res.json(rows);
});

app.get('/api/feed', requireUser, async (req, res) => {
  const kind = req.query.kind === 'short' ? 'short' : 'video';
  const { rows } = await pool.query(
    `SELECT v.id, v.title, v.description, v.created_at, v.channel_id, v.kind,
       c.name AS channel_name, u.display_name AS owner_name, u.avatar_emoji,
       (SELECT count(*)::int FROM reactions r WHERE r.video_id=v.id) AS reaction_count,
       (SELECT count(*)::int FROM comments cm WHERE cm.video_id=v.id AND cm.status='visible') AS comment_count
     FROM videos v JOIN channels c ON c.id=v.channel_id JOIN users u ON u.id=c.owner_id
     WHERE v.status='live' AND v.kind=$1 ORDER BY v.created_at DESC LIMIT 50`, [kind]);
  res.json(rows);
});

// ---------- Video upload (raw body -> bucket) ----------
app.post('/api/videos', requireUser, express.raw({ type: ['video/*'], limit: '500mb' }), async (req, res) => {
  if (!['kid', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Only club stars can post videos.' });
  const title = (req.query.title || 'Untitled').toString().slice(0, 120);
  const description = (req.query.description || '').toString().slice(0, 500);
  let { rows: [channel] } = await pool.query('SELECT * FROM channels WHERE owner_id=$1', [req.user.id]);
  if (!channel && req.user.role === 'admin')
    ({ rows: [channel] } = await pool.query(`INSERT INTO channels (owner_id,name) VALUES ($1,'Club HQ 🎪') RETURNING *`, [req.user.id]));
  if (!channel) return res.status(400).json({ error: 'No channel found for this account.' });
  if (!req.body?.length) return res.status(400).json({ error: 'No video data received.' });
  if (!process.env.BUCKET_NAME || !process.env.AWS_ACCESS_KEY_ID)
    return res.status(500).json({ error: 'Video storage is not configured yet. (Admin: bucket env vars missing.)' });
  const key = `videos/${channel.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
  const kind = req.query.kind === 'short' ? 'short' : 'video';
  try {
    await bucket.put(key, req.body, req.headers['content-type'] || 'video/mp4');
  } catch (e) {
    console.error('[upload] bucket PUT failed:', e.message);
    return res.status(502).json({ error: 'Upload to storage failed. Try again in a minute.' });
  }
  const { rows: [video] } = await pool.query(
    `INSERT INTO videos (channel_id,title,description,bucket_key,kind) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [channel.id, title, description, key, kind]);
  await castEngine.scheduleWave(pool, video.id);           // the Studio Audience arrives
  await bumpStars(channel.id, 10);                          // posting itself earns stars
  await awardBadges(channel.id);
  res.json(video);
});

app.get('/api/videos/:id/stream', requireUser, async (req, res) => {
  const { rows: [v] } = await pool.query(`SELECT * FROM videos WHERE id=$1 AND status='live'`, [req.params.id]);
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  res.redirect(bucket.presignGet(v.bucket_key, 3600));
});

app.get('/api/videos/:id', requireUser, async (req, res) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.*, c.name AS channel_name, c.star_meter, u.display_name AS owner_name
     FROM videos v JOIN channels c ON c.id=v.channel_id JOIN users u ON u.id=c.owner_id
     WHERE v.id=$1 AND v.status='live'`, [req.params.id]);
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const { rows: reactions } = await pool.query(
    `SELECT kind, count(*)::int AS n FROM reactions WHERE video_id=$1 GROUP BY kind`, [req.params.id]);
  res.json({ ...v, bucket_key: undefined, reactions });
});

// ---------- Comments ----------
app.get('/api/videos/:id/comments', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cm.id, cm.body, cm.parent_id, cm.created_at, cm.status,
       u.display_name AS user_name, u.avatar_emoji AS user_emoji, u.id AS user_id,
       cs.name AS cast_name, cs.emoji AS cast_emoji, cs.tier AS cast_tier, cs.specialty, cs.id AS cast_id
     FROM comments cm LEFT JOIN users u ON u.id=cm.user_id LEFT JOIN cast_members cs ON cs.id=cm.cast_id
     WHERE cm.video_id=$1 AND (cm.status='visible' OR (cm.status='pending' AND cm.user_id=$2))
     ORDER BY cm.created_at`, [req.params.id, req.user.id]);
  res.json(rows);
});

app.post('/api/videos/:id/comments', requireUser, async (req, res) => {
  const body = (req.body?.body || '').trim().slice(0, 500);
  const parentId = req.body?.parent_id || null;
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const { rows: [v] } = await pool.query(
    `SELECT v.*, c.moderation, c.owner_id, c.id AS cid FROM videos v JOIN channels c ON c.id=v.channel_id WHERE v.id=$1 AND v.status='live'`,
    [req.params.id]);
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  // Pre-moderation: member comments wait for approval; kid + admin comments post live.
  const needsReview = v.moderation === 'pre' && req.user.role === 'member';
  const { rows: [cm] } = await pool.query(
    `INSERT INTO comments (video_id,user_id,parent_id,body,status) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [v.id, req.user.id, parentId, body, needsReview ? 'pending' : 'visible']);
  // Kid replying to a cast member? Cast replies back.
  if (parentId && req.user.id === v.owner_id) {
    const { rows: [parent] } = await pool.query('SELECT cast_id FROM comments WHERE id=$1', [parentId]);
    if (parent?.cast_id) await castEngine.scheduleReply(pool, v.id, parent.cast_id, cm.id);
  }
  res.json({ ...cm, needsReview });
});

app.post('/api/videos/:id/react', requireUser, async (req, res) => {
  const kind = ['star', 'fire', 'clap', 'heart', 'wow'].includes(req.body?.kind) ? req.body.kind : 'star';
  await pool.query(`INSERT INTO reactions (video_id,user_id,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [req.params.id, req.user.id, kind]);
  const { rows: [v] } = await pool.query('SELECT channel_id FROM videos WHERE id=$1', [req.params.id]);
  if (v) await bumpStars(v.channel_id, 1);
  res.json({ ok: true });
});

// ---------- Star meter + badges ----------
async function bumpStars(channelId, n) {
  await pool.query('UPDATE channels SET star_meter=star_meter+$2 WHERE id=$1', [channelId, n]);
}
async function awardBadges(channelId) {
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM videos WHERE channel_id=$1 AND status='live'`, [channelId]);
  const tiers = [[1, 'first_post', 'First Post!', '🎬'], [5, 'rising_star_5', 'Rising Star — 5 Videos', '🌠'],
    [10, 'gold_record_10', 'Gold Record — 10 Videos', '🏆'], [25, 'platinum_25', 'Platinum — 25 Videos', '💿']];
  for (const [need, key, label, emoji] of tiers)
    if (n >= need)
      await pool.query(`INSERT INTO badges (channel_id,key,label,emoji) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [channelId, key, label, emoji]);
}
app.get('/api/channels/:id/badges', requireUser, async (req, res) => {
  const { rows } = await pool.query('SELECT key,label,emoji,earned_at FROM badges WHERE channel_id=$1 ORDER BY earned_at', [req.params.id]);
  res.json(rows);
});

// =====================================================================
// ADMIN CONTROL PANEL API  (UI at /admin.html)
// =====================================================================
const modLog = (adminId, action, target, note) =>
  pool.query('INSERT INTO mod_log (admin_id,action,target,note) VALUES ($1,$2,$3,$4)', [adminId, action, target, note || null]);

// Dashboard stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const q = async (sql) => (await pool.query(sql)).rows[0].n;
  res.json({
    users: await q(`SELECT count(*)::int n FROM users WHERE role<>'admin'`),
    pending: await q(`SELECT count(*)::int n FROM comments WHERE status='pending'`),
    flagged: await q(`SELECT count(*)::int n FROM comments WHERE status='flagged'`),
    videos: await q(`SELECT count(*)::int n FROM videos WHERE status='live'`),
    queue: await q(`SELECT count(*)::int n FROM cast_queue WHERE done=false`),
    suspended: await q(`SELECT count(*)::int n FROM users WHERE status<>'active'`),
  });
});

// Moderation queue: pending + flagged + recent visible member comments
app.get('/api/admin/comments', requireAdmin, async (req, res) => {
  const filter = req.query.filter || 'review'; // review | recent | removed
  const where = filter === 'review' ? `cm.status IN ('pending','flagged')`
    : filter === 'removed' ? `cm.status='removed'`
    : `cm.status='visible' AND cm.user_id IS NOT NULL`;
  const { rows } = await pool.query(
    `SELECT cm.*, u.display_name AS user_name, u.role AS user_role, u.status AS user_status,
       cs.name AS cast_name, v.title AS video_title, v.id AS video_id
     FROM comments cm LEFT JOIN users u ON u.id=cm.user_id LEFT JOIN cast_members cs ON cs.id=cm.cast_id
     JOIN videos v ON v.id=cm.video_id
     WHERE ${where} ORDER BY cm.created_at DESC LIMIT 100`);
  res.json(rows);
});

app.post('/api/admin/comments/:id/approve', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE comments SET status='visible' WHERE id=$1`, [req.params.id]);
  await modLog(req.user.id, 'approve_comment', `comment:${req.params.id}`);
  res.json({ ok: true });
});
app.post('/api/admin/comments/:id/remove', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE comments SET status='removed', removed_by=$2, remove_note=$3 WHERE id=$1`,
    [req.params.id, req.user.id, req.body?.note || null]);
  await modLog(req.user.id, 'remove_comment', `comment:${req.params.id}`, req.body?.note);
  res.json({ ok: true });
});
app.post('/api/admin/comments/:id/flag', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE comments SET status='flagged' WHERE id=$1`, [req.params.id]);
  await modLog(req.user.id, 'flag_comment', `comment:${req.params.id}`);
  res.json({ ok: true });
});

// User management: suspend / ban / restore / role visibility
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id,u.role,u.display_name,u.username,u.status,u.status_reason,u.created_at,
       (SELECT count(*)::int FROM comments c WHERE c.user_id=u.id) AS comment_count,
       (SELECT count(*)::int FROM comments c WHERE c.user_id=u.id AND c.status='removed') AS removed_count
     FROM users u WHERE u.role<>'admin' ORDER BY u.created_at DESC`);
  res.json(rows);
});
app.post('/api/admin/users/:id/status', requireAdmin, async (req, res) => {
  const status = ['active', 'suspended', 'banned'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status must be active | suspended | banned' });
  await pool.query(`UPDATE users SET status=$2, status_reason=$3, status_at=now() WHERE id=$1 AND role<>'admin'`,
    [req.params.id, status, req.body?.reason || null]);
  if (status === 'banned') // banned users' visible comments come down too
    await pool.query(`UPDATE comments SET status='removed', removed_by=$2, remove_note='author banned' WHERE user_id=$1 AND status IN ('visible','pending')`,
      [req.params.id, req.user.id]);
  await modLog(req.user.id, `${status}_user`, `user:${req.params.id}`, req.body?.reason);
  res.json({ ok: true });
});

// Invite codes
app.get('/api/admin/invites', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM invite_codes ORDER BY created_at DESC');
  res.json(rows);
});
app.post('/api/admin/invites', requireAdmin, async (req, res) => {
  const code = (req.body?.code || crypto.randomBytes(3).toString('hex').toUpperCase());
  const role = req.body?.role === 'kid' ? 'kid' : 'member';
  const { rows: [inv] } = await pool.query(
    `INSERT INTO invite_codes (code,role,note,max_uses,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [code, role, req.body?.note || null, Math.max(1, parseInt(req.body?.max_uses) || 1), req.user.id]);
  res.json(inv);
});
app.post('/api/admin/invites/:code/revoke', requireAdmin, async (req, res) => {
  await pool.query('UPDATE invite_codes SET revoked=true WHERE code=$1', [req.params.code]);
  await modLog(req.user.id, 'revoke_invite', `invite:${req.params.code}`);
  res.json({ ok: true });
});

// Channel moderation mode + video hide
app.post('/api/admin/channels/:id/moderation', requireAdmin, async (req, res) => {
  const mode = req.body?.mode === 'post' ? 'post' : 'pre';
  await pool.query('UPDATE channels SET moderation=$2 WHERE id=$1', [req.params.id, mode]);
  res.json({ ok: true, mode });
});
app.post('/api/admin/videos/:id/status', requireAdmin, async (req, res) => {
  const status = ['live', 'hidden', 'removed'].includes(req.body?.status) ? req.body.status : 'hidden';
  await pool.query('UPDATE videos SET status=$2 WHERE id=$1', [req.params.id, status]);
  await modLog(req.user.id, 'video_status_' + status, `video:${req.params.id}`);
  res.json({ ok: true });
});

// Mod log
app.get('/api/admin/log', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.*, u.display_name AS admin_name FROM mod_log m JOIN users u ON u.id=m.admin_id ORDER BY m.created_at DESC LIMIT 200`);
  res.json(rows);
});

// Cast controls: pause/resume a cast member, view roster
app.get('/api/admin/cast', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM cast_members ORDER BY tier, id');
  res.json(rows);
});
app.post('/api/admin/cast/:id/active', requireAdmin, async (req, res) => {
  await pool.query('UPDATE cast_members SET active=$2 WHERE id=$1', [req.params.id, !!req.body?.active]);
  res.json({ ok: true });
});

// ---------- Boot ----------
(async () => {
  await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));
  // Ensure admin account from env
  const au = process.env.ADMIN_USERNAME || 'cap';
  const { rows: [existing] } = await pool.query('SELECT id FROM users WHERE username=$1', [au]);
  if (!existing) {
    await pool.query(`INSERT INTO users (role,display_name,username,password_hash,avatar_emoji) VALUES ('admin','Cap',$1,$2,'🛡️')`,
      [au, hashPw(process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex'))]);
    console.log('[boot] admin user created:', au);
  }
  const castCount = await castEngine.seedCast(pool);
  console.log(`[boot] cast roster: ${castCount} members`);
  castEngine.startWorker(pool, { onStarMeter: bumpStars });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[boot] KidStarClub live on :${port}`));
})().catch(e => { console.error('[boot] fatal', e); process.exit(1); });
