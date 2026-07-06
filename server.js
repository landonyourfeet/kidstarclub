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
    const { rows: [u] } = await pool.query('SELECT id,role,display_name,username,status,theme,(avatar_key IS NOT NULL) AS has_avatar FROM users WHERE id=$1', [uid]);
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
  const { rows: [inv] } = await pool.query('SELECT * FROM invite_codes WHERE upper(code)=upper($1) AND NOT revoked AND (max_uses=0 OR uses < max_uses)', [code.trim()]);
  if (!inv) return res.status(400).json({ error: 'That invite code is not valid.' });
  try {
    const { rows: [u] } = await pool.query(
      `INSERT INTO users (role,display_name,username,password_hash,joined_code) VALUES ($1,$2,$3,$4,$5) RETURNING id,role,display_name`,
      [inv.role, display_name.trim().slice(0, 40), username.trim().toLowerCase().slice(0, 30), hashPw(password), inv.code.toUpperCase()]);
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
  const { rows } = await pool.query(
    `SELECT v.id, v.title, v.description, v.created_at, v.channel_id, v.kind, v.views,
       (v.thumb_key IS NOT NULL) AS has_thumb,
       COALESCE((SELECT AVG(score) FROM judge_scores js WHERE js.video_id=v.id),0)::float AS avg_score,
       FLOOR(v.views * GREATEST(1, POWER(COALESCE((SELECT AVG(score) FROM judge_scores js WHERE js.video_id=v.id),0),2)))::int AS chart_score,
       c.name AS channel_name, u.display_name AS owner_name, u.avatar_emoji,
       (SELECT count(*)::int FROM reactions r WHERE r.video_id=v.id) AS reaction_count,
       (SELECT json_object_agg(kind,n) FROM (SELECT kind, count(*)::int AS n FROM reactions WHERE video_id=v.id GROUP BY kind) t) AS rx,
       (SELECT count(*)::int FROM comments cm WHERE cm.video_id=v.id AND cm.status='visible') AS comment_count
     FROM videos v JOIN channels c ON c.id=v.channel_id JOIN users u ON u.id=c.owner_id
     WHERE v.status='live' ORDER BY v.created_at DESC LIMIT 50`);
  res.json(rows);
});

// ---- Direct-to-bucket upload (long videos, YouTube-style) ----
// 1) POST /api/videos/presign {title,description,kind} -> {video_id, put_url}
// 2) Browser PUTs the file straight to put_url (up to 5GB)
// 3) POST /api/videos/:id/complete -> goes live, cast wave fires
app.post('/api/videos/presign', requireUser, async (req, res) => {
  if (!process.env.BUCKET_NAME || !process.env.AWS_ACCESS_KEY_ID)
    return res.status(500).json({ error: 'Video storage is not configured yet. (Admin: bucket env vars missing.)' });
  let { rows: [channel] } = await pool.query('SELECT * FROM channels WHERE owner_id=$1', [req.user.id]);
  if (!channel) // everyone in the club gets a stage on first post
    ({ rows: [channel] } = await pool.query(
      `INSERT INTO channels (owner_id,name) VALUES ($1,$2) RETURNING *`,
      [req.user.id, req.user.role === 'admin' ? 'Club HQ 🎪' : `${req.user.display_name}'s Stage`]));
  if (!channel) return res.status(400).json({ error: 'No channel found for this account.' });
  const title = (req.body?.title || 'Untitled').toString().slice(0, 120);
  const description = (req.body?.description || '').toString().slice(0, 500);
  const kind = req.body?.kind === 'short' ? 'short' : 'video';
  const key = `videos/${channel.id}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`;
  const thumbKey = key.replace(/\.mp4$/, '-thumb.jpg');
  const { rows: [video] } = await pool.query(
    `INSERT INTO videos (channel_id,title,description,bucket_key,thumb_key,kind,status) VALUES ($1,$2,$3,$4,$5,$6,'uploading') RETURNING id`,
    [channel.id, title, description, key, thumbKey, kind]);
  res.json({ video_id: video.id, put_url: bucket.presignPut(key), thumb_put_url: bucket.presignPut(thumbKey) });
});

app.post('/api/videos/:id/complete', requireUser, async (req, res) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.*, c.owner_id, c.id AS cid FROM videos v JOIN channels c ON c.id=v.channel_id
     WHERE v.id=$1 AND v.status='uploading'`, [req.params.id]);
  if (!v || (v.owner_id !== req.user.id && req.user.role !== 'admin'))
    return res.status(404).json({ error: 'Upload not found.' });
  await pool.query(`UPDATE videos SET status='live' WHERE id=$1`, [v.id]);
  await castEngine.scheduleWave(pool, v.id);
  await bumpStars(v.cid, 10);
  await awardBadges(v.cid);
  res.json({ ok: true, id: v.id });
});


app.post('/api/videos', requireUser, express.raw({ type: ['video/*'], limit: '500mb' }), async (req, res) => {
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

app.get('/api/videos/:id/thumb', requireUser, async (req, res) => {
  const { rows: [v] } = await pool.query(`SELECT thumb_key FROM videos WHERE id=$1 AND status='live'`, [req.params.id]);
  if (!v?.thumb_key) return res.status(404).json({ error: 'No thumbnail.' });
  res.redirect(bucket.presignGet(v.thumb_key, 3600));
});

// A view = a play event. Counting logic lives in lib/views.js (Cap's zone —
// never overwritten by updates).
const { countView } = require('./lib/views');
app.post('/api/videos/:id/view', requireUser, async (req, res) => {
  res.json({ views: await countView(pool, req.params.id) });
});

app.get('/api/videos/:id', requireUser, async (req, res) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.*, c.name AS channel_name, c.star_meter, c.id AS channel_id, c.owner_id, u.display_name AS owner_name
     FROM videos v JOIN channels c ON c.id=v.channel_id JOIN users u ON u.id=c.owner_id
     WHERE v.id=$1 AND v.status='live'`, [req.params.id]);
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  const { rows: reactions } = await pool.query(
    `SELECT kind, count(*)::int AS n FROM reactions WHERE video_id=$1 GROUP BY kind`, [req.params.id]);
  const { rows: [sub] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM subscriptions WHERE channel_id=$1) AS n,
            EXISTS(SELECT 1 FROM subscriptions WHERE channel_id=$1 AND user_id=$2) AS mine`,
    [v.channel_id, req.user.id]);
  const { rows: [jury] } = await pool.query(
    `SELECT COALESCE(AVG(score),0)::float AS avg, count(*)::int AS n FROM judge_scores WHERE video_id=$1`,
    [req.params.id]);
  const chart = Math.floor(v.views * Math.max(1, jury.avg * jury.avg));
  res.json({ ...v, bucket_key: undefined, reactions,
    subscriber_count: sub.n, i_subscribe: sub.mine, is_own: v.owner_id === req.user.id,
    avg_score: jury.avg, judge_count: jury.n, chart_score: chart });
});

// ---------- Comments ----------
app.get('/api/videos/:id/comments', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cm.id, cm.body, cm.parent_id, cm.created_at, cm.status,
       u.display_name AS user_name, u.avatar_emoji AS user_emoji, (u.avatar_key IS NOT NULL) AS user_has_avatar, u.id AS user_id, u.role AS user_role, u.joined_code,
       CASE WHEN u.id IS NOT NULL THEN
         (SELECT count(*)::int FROM comments c2 WHERE c2.user_id=u.id AND c2.status='visible')
         + (SELECT count(*)::int FROM reactions r2 WHERE r2.user_id=u.id)
         + 5*(SELECT count(*)::int FROM subscriptions s2 WHERE s2.user_id=u.id)
       END AS activity_n,
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

// ---------- Subscriptions (real members only) ----------
app.post('/api/channels/:id/subscribe', requireUser, async (req, res) => {
  const { rows: [c] } = await pool.query('SELECT owner_id FROM channels WHERE id=$1', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Channel not found.' });
  if (c.owner_id === req.user.id) return res.status(400).json({ error: "You can't subscribe to your own stage!" });
  await pool.query(`INSERT INTO subscriptions (user_id,channel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [req.user.id, req.params.id]);
  await bumpStars(req.params.id, 3);
  res.json({ ok: true });
});
app.post('/api/channels/:id/unsubscribe', requireUser, async (req, res) => {
  await pool.query(`DELETE FROM subscriptions WHERE user_id=$1 AND channel_id=$2`, [req.user.id, req.params.id]);
  res.json({ ok: true });
});
app.get('/api/channels/:id/subscribers', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.display_name, u.avatar_emoji, u.joined_code, s.created_at FROM subscriptions s
     JOIN users u ON u.id=s.user_id WHERE s.channel_id=$1 AND u.status='active' ORDER BY s.created_at`,
    [req.params.id]);
  res.json(rows);
});

// ---------- Studio track library ----------
app.get('/api/tracks', requireUser, async (req, res) => {
  const { rows } = await pool.query(`SELECT id,title,created_at FROM tracks WHERE active ORDER BY title`);
  res.json(rows);
});
app.get('/api/tracks/:id/stream', requireUser, async (req, res) => {
  const { rows: [t] } = await pool.query(`SELECT bucket_key FROM tracks WHERE id=$1 AND active`, [req.params.id]);
  if (!t) return res.status(404).json({ error: 'Track not found.' });
  res.redirect(bucket.presignGet(t.bucket_key, 3600));
});
// Admin adds a song: presign, PUT the audio file, then confirm.
app.post('/api/tracks/presign', requireAdmin, async (req, res) => {
  const title = (req.body?.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Track needs a title.' });
  const key = `tracks/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp3`;
  const { rows: [t] } = await pool.query(
    `INSERT INTO tracks (title,bucket_key,added_by,active) VALUES ($1,$2,$3,false) RETURNING id`,
    [title, key, req.user.id]);
  res.json({ track_id: t.id, put_url: bucket.presignPut(key) });
});
app.post('/api/tracks/:id/complete', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE tracks SET active=true WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/tracks/:id/remove', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE tracks SET active=false WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ---------- Profile ----------
app.post('/api/profile', requireUser, async (req, res) => {
  const name = (req.body?.display_name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  const theme = ['punk', 'court'].includes(req.body?.theme) ? req.body.theme : null;
  await pool.query('UPDATE users SET display_name=$2' + (theme ? ', theme=$3' : '') + ' WHERE id=$1',
    theme ? [req.user.id, name, theme] : [req.user.id, name]);
  res.json({ ok: true, display_name: name, theme });
});
app.post('/api/profile/theme', requireUser, async (req, res) => {
  const theme = ['punk', 'court'].includes(req.body?.theme) ? req.body.theme : 'punk';
  await pool.query('UPDATE users SET theme=$2 WHERE id=$1', [req.user.id, theme]);
  res.json({ ok: true, theme });
});
app.post('/api/profile/avatar-presign', requireUser, async (req, res) => {
  if (!process.env.BUCKET_NAME) return res.status(500).json({ error: 'Storage not configured.' });
  const key = `avatars/${req.user.id}-${Date.now()}.jpg`;
  res.json({ image_key: key, put_url: bucket.presignPut(key) });
});
app.post('/api/profile/avatar-complete', requireUser, async (req, res) => {
  const key = (req.body?.image_key || '');
  if (!key.startsWith(`avatars/${req.user.id}-`)) return res.status(400).json({ error: 'Bad avatar key.' });
  await pool.query('UPDATE users SET avatar_key=$2 WHERE id=$1', [req.user.id, key]);
  res.json({ ok: true });
});
app.get('/api/users/:id/avatar', requireUser, async (req, res) => {
  const { rows: [u] } = await pool.query('SELECT avatar_key FROM users WHERE id=$1', [req.params.id]);
  if (!u?.avatar_key) return res.status(404).json({ error: 'No avatar.' });
  res.redirect(bucket.presignGet(u.avatar_key, 3600));
});

// ---------- Club Chat ----------
app.get('/api/chat', requireUser, async (req, res) => {
  const after = parseInt(req.query.after) || 0;
  const { rows } = await pool.query(
    `SELECT cm.id, cm.body, cm.created_at, (cm.image_key IS NOT NULL) AS has_image,
       u.display_name AS user_name, u.avatar_emoji AS user_emoji, (u.avatar_key IS NOT NULL) AS user_has_avatar, u.id AS user_id, u.role AS user_role, u.joined_code,
       cs.name AS cast_name, cs.emoji AS cast_emoji, cs.tier AS cast_tier, cs.specialty
     FROM chat_messages cm LEFT JOIN users u ON u.id=cm.user_id LEFT JOIN cast_members cs ON cs.id=cm.cast_id
     WHERE cm.status='visible' AND cm.id > $1
     ORDER BY cm.id ${after ? 'ASC' : 'DESC'} LIMIT 60`, [after]);
  res.json(after ? rows : rows.reverse());
});

// Names available for @mentions: active humans + judges/regulars.
app.get('/api/chat/mentionables', requireUser, async (req, res) => {
  const { rows: users } = await pool.query(
    `SELECT display_name AS name, avatar_emoji AS emoji, 'user' AS kind FROM users WHERE status='active' ORDER BY display_name`);
  const { rows: cast } = await pool.query(
    `SELECT name, emoji, 'cast' AS kind FROM cast_members WHERE active AND tier IN ('judge','regular') ORDER BY name`);
  res.json([...users, ...cast]);
});

// Cheap poll target for the chat notification badge.
app.get('/api/chat/latest', requireUser, async (req, res) => {
  const { rows: [m] } = await pool.query(
    `SELECT COALESCE(MAX(id),0)::int AS id FROM chat_messages WHERE status='visible'`);
  res.json({ id: m.id });
});

app.post('/api/chat', requireUser, async (req, res) => {
  const body = (req.body?.body || '').trim().slice(0, 500);
  const imageKey = (req.body?.image_key || '').trim() || null;
  if (!body && !imageKey) return res.status(400).json({ error: 'Say something or add a photo!' });
  if (imageKey && !imageKey.startsWith('chat/')) return res.status(400).json({ error: 'Bad image.' });
  const { rows: [m] } = await pool.query(
    `INSERT INTO chat_messages (user_id,body,image_key) VALUES ($1,$2,$3) RETURNING id`,
    [req.user.id, body, imageKey]);
  castEngine.maybeChatReply(pool, { body, image_key: imageKey });
  res.json({ ok: true, id: m.id });
});

app.post('/api/chat/presign-image', requireUser, async (req, res) => {
  if (!process.env.BUCKET_NAME) return res.status(500).json({ error: 'Storage not configured.' });
  const key = `chat/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  res.json({ image_key: key, put_url: bucket.presignPut(key) });
});

app.get('/api/chat/:id/image', requireUser, async (req, res) => {
  const { rows: [m] } = await pool.query(
    `SELECT image_key FROM chat_messages WHERE id=$1 AND status='visible'`, [req.params.id]);
  if (!m?.image_key) return res.status(404).json({ error: 'No image.' });
  res.redirect(bucket.presignGet(m.image_key, 3600));
});

app.post('/api/admin/chat/:id/remove', requireAdmin, async (req, res) => {
  await pool.query(`UPDATE chat_messages SET status='removed' WHERE id=$1`, [req.params.id]);
  await modLog(req.user.id, 'remove_chat', `chat:${req.params.id}`, req.body?.note);
  res.json({ ok: true });
});

// ---------- My videos (owner management) ----------
app.get('/api/my/videos', requireUser, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.title, v.description, v.created_at, v.kind, (v.thumb_key IS NOT NULL) AS has_thumb,
       (SELECT count(*)::int FROM comments c WHERE c.video_id=v.id AND c.status='visible') AS comment_count
     FROM videos v JOIN channels ch ON ch.id=v.channel_id
     WHERE ch.owner_id=$1 AND v.status='live' ORDER BY v.created_at DESC`, [req.user.id]);
  res.json(rows);
});
async function ownsVideo(userId, videoId) {
  const { rows: [v] } = await pool.query(
    `SELECT ch.owner_id FROM videos v JOIN channels ch ON ch.id=v.channel_id WHERE v.id=$1`, [videoId]);
  return v && v.owner_id === userId;
}
app.post('/api/videos/:id/update', requireUser, async (req, res) => {
  if (!(await ownsVideo(req.user.id, req.params.id)) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your video.' });
  const title = (req.body?.title || '').trim().slice(0, 120);
  const description = (req.body?.description || '').trim().slice(0, 500);
  if (!title) return res.status(400).json({ error: 'Title cannot be empty.' });
  await pool.query('UPDATE videos SET title=$2, description=$3 WHERE id=$1', [req.params.id, title, description]);
  res.json({ ok: true });
});
app.post('/api/videos/:id/remove', requireUser, async (req, res) => {
  if (!(await ownsVideo(req.user.id, req.params.id)) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your video.' });
  await pool.query(`UPDATE videos SET status='removed' WHERE id=$1`, [req.params.id]);
  await pool.query(`UPDATE cast_queue SET done=true WHERE video_id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ---------- Sharing: watch-only public links ----------
app.post('/api/videos/:id/share', requireUser, async (req, res) => {
  if (!(await ownsVideo(req.user.id, req.params.id)) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your video.' });
  const token = crypto.randomBytes(9).toString('base64url');
  const { rows: [v] } = await pool.query(
    `UPDATE videos SET share_token=COALESCE(share_token,$2) WHERE id=$1 AND status='live' RETURNING share_token`,
    [req.params.id, token]);
  if (!v) return res.status(404).json({ error: 'Video not found.' });
  res.json({ url: `https://kidstarclub.com/watch/${v.share_token}` });
});
app.post('/api/videos/:id/unshare', requireUser, async (req, res) => {
  if (!(await ownsVideo(req.user.id, req.params.id)) && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Not your video.' });
  await pool.query(`UPDATE videos SET share_token=NULL WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

async function shareVideo(token) {
  const { rows: [v] } = await pool.query(
    `SELECT v.*, c.name AS channel_name, u.display_name AS owner_name
     FROM videos v JOIN channels c ON c.id=v.channel_id JOIN users u ON u.id=c.owner_id
     WHERE v.share_token=$1 AND v.status='live'`, [token]);
  return v;
}
app.get('/api/share/:token/stream', async (req, res) => {
  const v = await shareVideo(req.params.token);
  if (!v) return res.status(404).send('Not found');
  res.redirect(bucket.presignGet(v.bucket_key, 3600));
});
app.get('/api/share/:token/thumb', async (req, res) => {
  const v = await shareVideo(req.params.token);
  if (!v?.thumb_key) return res.redirect('/share-card.png'); // brand card fallback
  try {
    const obj = await bucket.get(v.thumb_key);
    res.set('content-type', 'image/jpeg');
    res.set('cache-control', 'public, max-age=3600');
    res.send(obj.body);
  } catch (e) { res.redirect('/share-card.png'); }
});
app.get('/api/share/:token/data', async (req, res) => {
  const v = await shareVideo(req.params.token);
  if (!v) return res.status(404).json({ error: 'Not found' });
  const { rows: comments } = await pool.query(
    `SELECT cm.body, cm.parent_id, cm.created_at,
       u.display_name AS user_name, u.avatar_emoji AS user_emoji, u.role AS user_role,
       cs.name AS cast_name, cs.emoji AS cast_emoji, cs.tier AS cast_tier, cs.specialty
     FROM comments cm LEFT JOIN users u ON u.id=cm.user_id LEFT JOIN cast_members cs ON cs.id=cm.cast_id
     WHERE cm.video_id=$1 AND cm.status='visible' ORDER BY cm.created_at`, [v.id]);
  const { rows: reactions } = await pool.query(
    `SELECT kind, count(*)::int AS n FROM reactions WHERE video_id=$1 GROUP BY kind`, [v.id]);
  const { rows: [jury] } = await pool.query(
    `SELECT COALESCE(AVG(score),0)::float AS avg, count(*)::int AS n FROM judge_scores WHERE video_id=$1`, [v.id]);
  res.json({ title: v.title, description: v.description, owner: v.owner_name, channel: v.channel_name,
    created_at: v.created_at, reactions, comments, avg_score: jury.avg, judge_count: jury.n,
    chart_score: Math.floor(v.views * Math.max(1, jury.avg * jury.avg)) });
});

const WATCH_CSS = `
:root{--pink:#ff2ec4;--magenta:#c4108f;--deep:#3d0330;--cyan:#45d8ff;--black:#0d0210;--yellow:#ffe14d}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Nunito,sans-serif;color:#fff;min-height:100vh;
  background:radial-gradient(circle at 20% 10%,rgba(255,255,255,.14) 0 1.5px,transparent 2px),
  linear-gradient(160deg,#ff2ec4,#c4108f 45%,#5a0645);background-size:22px 22px,cover}
main{max-width:560px;margin:0 auto;padding:16px 14px 60px}
.logo{text-align:center;font-family:Anton;letter-spacing:.06em;font-size:26px;padding:12px;text-shadow:2px 2px 0 var(--black)}
.card{background:var(--black);border:3px solid #fff;border-radius:14px;box-shadow:6px 6px 0 rgba(13,2,16,.55),0 0 0 3px var(--pink) inset;padding:14px;margin-bottom:14px}
video{width:100%;max-height:70vh;object-fit:contain;border-radius:10px;border:3px solid var(--pink);background:#000}
h1{font-family:Anton;font-size:20px;letter-spacing:.03em}
.meta{color:var(--cyan);font-weight:800;font-size:13px;margin:2px 0 8px}
.chart{font-family:Anton;color:var(--yellow);font-size:16px;margin:6px 0}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.chip{background:var(--magenta);border:2px solid #fff;border-radius:999px;padding:4px 12px;font-weight:800;font-size:13px}
.jbar{position:relative;height:18px;background:#14061a;border:2px solid #fff;border-radius:999px;overflow:hidden;margin:8px 0}
.jfill{position:absolute;inset:0;background:linear-gradient(90deg,#45d8ff,#ff2ec4 55%,#ffe14d)}
.jlabel{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:Anton;font-size:11px;letter-spacing:.12em}
.cta{display:block;text-align:center;font-family:Anton;font-size:17px;letter-spacing:.06em;background:var(--cyan);
  color:var(--black);border:3px solid #fff;border-radius:12px;padding:14px;text-decoration:none;box-shadow:4px 4px 0 rgba(13,2,16,.6)}
.cta small{display:block;font-family:Nunito;font-weight:800;font-size:12px;letter-spacing:0}
h2{font-family:'Permanent Marker';color:var(--yellow);font-size:18px;margin-bottom:8px}
.cm{display:flex;gap:9px;border-left:4px solid var(--cyan);padding:7px 9px;margin-bottom:9px;background:rgba(255,255,255,.05);border-radius:0 10px 10px 0}
.cm.judge{border-left-color:var(--yellow)}
.cm .av{flex:0 0 32px;width:32px;height:32px;border-radius:50%;background:var(--deep);border:2px solid var(--cyan);display:flex;align-items:center;justify-content:center;font-size:15px}
.cm.judge .av{border-color:var(--yellow);background:#2e2408}
.who{font-weight:800;font-size:12px;color:var(--cyan)}
.cm.judge .who{color:var(--yellow)}
.pill{font-size:9px;border-radius:5px;padding:1px 6px;margin-left:5px;font-weight:800;letter-spacing:.08em;border:1px solid;vertical-align:middle}
.pj{background:#2e2408;border-color:#ffe14d;color:#ffe14d}
.pc{background:#241a3a;border-color:#a78bfa;color:#a78bfa}
.pf{background:#3d0330;border-color:#45d8ff;color:#45d8ff}
.body{font-size:13px;margin-top:2px;word-break:break-word}`;

app.get('/watch/:token', async (req, res) => {
  const v = await shareVideo(req.params.token);
  if (!v) return res.status(404).send('<h1 style="font-family:sans-serif;padding:40px">This link has expired. Ask your friend for a new one! ⭐</h1>');
  const t = req.params.token;
  const safeTitle = v.title.replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const { rows: rxs } = await pool.query(
    `SELECT kind, count(*)::int AS n FROM reactions WHERE video_id=$1 GROUP BY kind`, [v.id]);
  const { rows: [{ n: cmn }] } = await pool.query(
    `SELECT count(*)::int AS n FROM comments WHERE video_id=$1 AND status='visible'`, [v.id]);
  const { rows: [jury2] } = await pool.query(
    `SELECT COALESCE(AVG(score),0)::float AS avg, count(*)::int AS n FROM judge_scores WHERE video_id=$1`, [v.id]);
  const RXE = { star: '⭐', fire: '🔥', clap: '👏', heart: '💜', wow: '🤩' };
  const rxLine = rxs.filter(r => r.n > 0).map(r => `${RXE[r.kind] || '⭐'}${r.n}`).join(' ') || '⭐ new!';
  const chart2 = Math.floor(v.views * Math.max(1, jury2.avg * jury2.avg));
  const desc = `${rxLine} · 💬 ${cmn} comments · 📈 Chart ${chart2}` +
    (jury2.n ? ` · Judges ${jury2.avg.toFixed(1)}/10` : '') + ` — ${v.owner_name} on KidStarClub`;
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} — KidStarClub ⭐</title>
<meta property="og:title" content="${safeTitle} ⭐ KidStarClub">
<meta property="og:description" content="${desc.replace(/"/g, '&quot;')}">
<meta property="og:image" content="https://kidstarclub.com/api/share/${t}/thumb">
<meta property="og:image:width" content="640">
<meta name="twitter:card" content="summary_large_image">
<meta property="og:type" content="video.other">
<link rel="icon" href="/favicon.png">
<link href="https://fonts.googleapis.com/css2?family=Permanent+Marker&family=Anton&family=Nunito:wght@600;800&display=swap" rel="stylesheet">
<style>${WATCH_CSS}</style></head><body><main>
<div class="logo">KID⭐STAR⭐CLUB</div>
<div class="card">
  <h1 id="ti"></h1><div class="meta" id="me"></div>
  <div class="chart">📈 CHART SCORE <span id="cs">0</span></div>
  <div class="jbar"><div class="jfill" id="jf" style="width:0"></div><div class="jlabel" id="jl">JUDGES VOTING…</div></div>
  <video controls playsinline autoplay muted src="/api/share/${t}/stream"></video>
  <div class="chips" id="rx"></div>
</div>
<a class="cta" href="https://kidstarclub.com/">⭐ Join the club to cheer &amp; comment!<small>Ask your friend for their club invite code 🎟️</small></a>
<div class="card" style="margin-top:14px"><h2>The club says…</h2><div id="cm"></div></div>
</main>
<script src="/watch-page.js" data-token="${t}"></script>
</body></html>`);
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
     FROM users u WHERE u.id<>$1 ORDER BY u.created_at DESC`, [req.user.id]);
  res.json(rows);
});
// Promote/demote moderators. You can't change your own role.
app.post('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  const role = ['admin', 'member', 'kid'].includes(req.body?.role) ? req.body.role : null;
  if (!role) return res.status(400).json({ error: 'role must be admin | kid | member' });
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't change your own role." });
  await pool.query('UPDATE users SET role=$2 WHERE id=$1', [req.params.id, role]);
  await modLog(req.user.id, 'set_role_' + role, `user:${req.params.id}`);
  res.json({ ok: true });
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
    [code, role, req.body?.note || null, Math.max(0, parseInt(req.body?.max_uses) || 0), req.user.id]);
  res.json(inv);
});
app.post('/api/admin/invites/:code/revoke', requireAdmin, async (req, res) => {
  await pool.query('UPDATE invite_codes SET revoked=true WHERE code=$1', [req.params.code]);
  await modLog(req.user.id, 'revoke_invite', `invite:${req.params.code}`);
  res.json({ ok: true });
});
app.post('/api/admin/invites/:code/unlimited', requireAdmin, async (req, res) => {
  await pool.query('UPDATE invite_codes SET max_uses=0, revoked=false WHERE code=$1', [req.params.code]);
  await modLog(req.user.id, 'unlimited_invite', `invite:${req.params.code}`);
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
  if (process.env.BUCKET_NAME && process.env.AWS_ACCESS_KEY_ID)
    bucket.setCors(['*']).then(() => console.log('[boot] bucket CORS set'))
      .catch(e => console.error('[boot] bucket CORS failed (direct uploads may not work):', e.message));
  castEngine.startWorker(pool, { onStarMeter: bumpStars });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[boot] KidStarClub live on :${port}`));
})().catch(e => { console.error('[boot] fatal', e); process.exit(1); });
