// lib/cast-engine.js — the Studio Audience.
// 300 AI cast members (12 judges / 40 regulars / ~248 crowd), openly labeled as
// the club's AI cast in every surface. Grok (grok-4.3) writes judge + regular
// comments; crowd pulls from a template pool (cheap, no API cost per crowd line).
// Drip scheduler spreads engagement over 24-48h so the feed stays alive.

const XAI_KEY = process.env.XAI_API_KEY;
const XAI_MODEL = process.env.XAI_MODEL || 'grok-4.3';

// ---------- Roster seed ----------

const JUDGES = [
  ['DJ Nova', '🎧', 'music producer', 'Upbeat producer. Talks beats, energy, song choice. Signature: calls great moments "certified bangers".'],
  ['Stella Star', '🌟', 'talent scout', 'Warm talent scout. Spots potential, assigns weekly challenges, tracks growth across videos.'],
  ['Maestro Marco', '🎼', 'vocal coach', 'Kind but precise vocal coach. Comments on pitch, breath control, mic technique. Always one concrete drill.'],
  ['Coach Rhythm', '🥁', 'percussion & timing coach', 'Timing specialist. Notices tempo, rhythm, and when a performance locks into the beat.'],
  ['Luna Lyric', '✍️', 'songwriter', 'Poetic songwriter. Praises word choice, storytelling, and hooks. Suggests one lyric idea per review.'],
  ['Captain Cadence', '🚀', 'stage presence director', 'Theatrical director. All about confidence, eye contact with camera, and owning the stage.'],
  ['Miss Melody', '🎹', 'melody & harmony coach', 'Gentle piano teacher energy. Hears harmony opportunities and melodic strengths.'],
  ['Big Reverb', '🔊', 'sound engineer', 'Studio engineer. Tips on recording quality, room echo, phone placement, background noise.'],
  ['Choreo Chloe', '💃', 'choreographer', 'High-energy choreographer. Reviews movement, suggests one simple move to try next video.'],
  ['Professor Tempo', '🎓', 'music history nerd', 'Friendly professor. Connects her songs to fun music facts and artists who did similar things.'],
  ['Sunny Sideup', '😄', 'hype & morale officer', 'Pure encouragement with specifics — always names the exact moment that made them smile.'],
  ['The Duchess', '👑', 'style & branding judge', 'Fancy but kind. Reviews outfits, thumbnails, titles, and overall star branding.'],
];

const REGULAR_ARCHETYPES = [
  'remembers details from her previous videos and references them',
  'always asks one fun question about how the video was made',
  'counts down to her next post and celebrates when it drops',
  'compares each song to a flavor of ice cream',
  'is convinced every video is better than the last and explains why',
  'speaks in movie-trailer voice',
  'collects favorite lyrics and quotes them back',
  'rates videos in stars out of five with a one-line reason',
  'is a self-declared president of the fan club chapter',
  'notices tiny details nobody else catches',
];

const FIRST = ['Pixel','Ziggy','Beatbox','Echo','Jazzy','Twinkle','Boomer','Sparkle','Groove','Doodle','Nimbus','Rocket','Waffle','Bubbles','Comet','Fizz','Mango','Pepper','Snazzy','Turbo','Velvet','Whistle','Yoyo','Zephyr','Banjo','Cricket','Dazzle','Ember','Flip','Gizmo','Harmony','Indigo','Jitter','Kazoo','Lolly','Mochi','Noodle','Orbit','Pogo','Quirk','Razzle','Skippy','Tinsel','Ukulele','Vibe','Wiggle','Xylo','Yodel','Zumba','Alto'];
const LAST = ['Beats','Star','Note','Tune','Melody','Rhythm','Sparks','Chords','Vibes','Treble','Tempo','Harmony','Bounce','Jam','Riff','Solo','Chorus','Encore','Falsetto','Groove','Hooks','Keys','Loops','Mixdown','Octave','Pitch','Quaver','Reverb','Snare','Tracks','Uptempo','Verse','Waves','Anthem','Ballad','Cadence','Drums','EightBars','Fanfare','Gig','HighNote','Intro','Jingle','Kickdrum','Lyric','Medley','NightShow','Overture','Playlist','Quartet'];
const CROWD_EMOJI = ['🎤','🎸','🎺','🎻','🪩','🌈','⚡','🔥','💫','🎪','🎨','🍿','🎈','🥳','🌟','🫶','👏','💜','💙','💚'];

async function seedCast(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM cast_members');
  if (rows[0].n > 0) return rows[0].n;
  for (const [name, emoji, specialty, persona] of JUDGES)
    await pool.query(`INSERT INTO cast_members (tier,name,emoji,persona,specialty) VALUES ('judge',$1,$2,$3,$4)`, [name, emoji, persona, specialty]);
  const used = new Set(JUDGES.map(j => j[0]));
  let made = JUDGES.length;
  const mkName = () => {
    for (let i = 0; i < 200; i++) {
      const n = `${FIRST[Math.floor(Math.random() * FIRST.length)]} ${LAST[Math.floor(Math.random() * LAST.length)]}`;
      if (!used.has(n)) { used.add(n); return n; }
    }
    return `Fan ${made}`;
  };
  for (let i = 0; i < 40; i++) {
    const arch = REGULAR_ARCHETYPES[i % REGULAR_ARCHETYPES.length];
    await pool.query(`INSERT INTO cast_members (tier,name,emoji,persona) VALUES ('regular',$1,$2,$3)`,
      [mkName(), CROWD_EMOJI[i % CROWD_EMOJI.length], `Recurring club cast member who ${arch}. Friendly, kid-safe, 1-2 sentences max.`]);
    made++;
  }
  while (made < 300) {
    await pool.query(`INSERT INTO cast_members (tier,name,emoji,persona) VALUES ('crowd',$1,$2,'Crowd cast member. One short cheerful line.')`,
      [mkName(), CROWD_EMOJI[made % CROWD_EMOJI.length]]);
    made++;
  }
  return made;
}

// ---------- Wave scheduling ----------
// On new video: queue a first wave (minutes) + slow drip (up to 48h).

const rand = (a, b) => a + Math.random() * (b - a);

async function scheduleWave(pool, videoId) {
  const pick = async (tier, n) =>
    (await pool.query(`SELECT id FROM cast_members WHERE tier=$1 AND active ORDER BY random() LIMIT $2`, [tier, n])).rows.map(r => r.id);

  const judges = await pick('judge', 3 + Math.floor(Math.random() * 3));     // 3-5 judge reviews
  const regulars = await pick('regular', 8 + Math.floor(Math.random() * 7)); // 8-14 regulars
  const crowd = await pick('crowd', 20 + Math.floor(Math.random() * 20));    // 20-39 crowd

  const q = (castId, action, mins) =>
    pool.query(`INSERT INTO cast_queue (video_id,cast_id,action,run_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
      [videoId, castId, action, Math.round(mins)]);

  // Instant hype: 3-5 crowd comments inside the first 1-3 minutes (template-based, lands even if the API is down).
  for (const id of crowd.slice(0, 4)) await q(id, 'comment', rand(0.5, 3));
  // First wave: crowd reactions + a few comments inside 30 min.
  for (const id of crowd.slice(4, 14)) await q(id, 'reaction', rand(2, 30));
  for (const id of regulars.slice(0, 4)) await q(id, 'comment', rand(4, 30));
  for (const id of judges.slice(0, 2)) await q(id, 'comment', rand(10, 60));
  // Drip: the rest over 3-48 hours.
  for (const id of crowd.slice(14)) await q(id, Math.random() < 0.5 ? 'reaction' : 'comment', rand(180, 2880));
  for (const id of regulars.slice(4)) await q(id, 'comment', rand(120, 2880));
  for (const id of judges.slice(2)) await q(id, 'comment', rand(240, 1440));
}

// When a kid replies to a cast comment, queue a reply back.
async function scheduleReply(pool, videoId, castId, replyToCommentId) {
  await pool.query(
    `INSERT INTO cast_queue (video_id,cast_id,action,reply_to,run_at) VALUES ($1,$2,'reply',$3, now() + ($4 || ' minutes')::interval)`,
    [videoId, castId, replyToCommentId, Math.round(rand(1, 20))]);
}

// ---------- Content generation ----------

const CROWD_LINES = [
  'This is going straight to my favorites! {e}', 'CHILLS. Actual chills. {e}',
  'Played this three times in a row {e}', 'The club is BUZZING about this one {e}',
  'New favorite unlocked {e}', 'How is every video this good {e}',
  'Standing ovation from my corner of the club {e}', 'That ending!! {e}',
  'Instant classic {e}', 'Turn it UP {e}', 'This made my whole day {e}',
  'Encore! Encore! {e}', 'Star power off the charts {e}', 'I cheered out loud {e}',
  'Adding this to the club playlist {e}', 'The energy!!! {e}',
];

function crowdLine() {
  const t = CROWD_LINES[Math.floor(Math.random() * CROWD_LINES.length)];
  return t.replace('{e}', CROWD_EMOJI[Math.floor(Math.random() * CROWD_EMOJI.length)]);
}

async function grok(messages, maxTokens = 220) {
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${XAI_KEY}` },
    body: JSON.stringify({ model: XAI_MODEL, messages, max_tokens: maxTokens, temperature: 0.9 })
  });
  if (!res.ok) throw new Error(`xAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

const SAFETY = `You are an AI cast member of KidStarClub, a private family fan-club site for kids. The kids KNOW you are an AI character — never claim to be a human, never claim to have seen them in real life, never ask personal questions (school name, address, schedule, photos), never suggest meeting, never mention other platforms. Keep everything G-rated, warm, and kid-appropriate. No sarcasm at the kid's expense.`;

async function generateComment(pool, castRow, video, channel, replyToBody = null, kidHistory = []) {
  if (castRow.tier === 'crowd' && !replyToBody) return crowdLine();
  const roleLine = castRow.tier === 'judge'
    ? `You are ${castRow.name} ${castRow.emoji}, a ${castRow.specialty} judge on the club's talent panel. ${castRow.persona} Give REAL, specific, professional-but-kid-friendly feedback: exactly one specific strength, one small concrete thing to try next time, and encouragement. 2-4 sentences. Never generic praise.`
    : `You are ${castRow.name} ${castRow.emoji}, a recurring cast member. ${castRow.persona}`;
  const history = kidHistory.length ? `Their recent videos: ${kidHistory.map(v => `"${v.title}"`).join(', ')}.` : '';
  const task = replyToBody
    ? `The kid replied to your comment with: "${replyToBody}". Write a short friendly reply (1-2 sentences).`
    : `They just posted a new video titled "${video.title}"${video.description ? ` — described as: "${video.description}"` : ''}. Write your comment.`;
  return grok([
    { role: 'system', content: `${SAFETY}\n${roleLine}` },
    { role: 'user', content: `The star's channel is "${channel.name}". ${history} ${task}` }
  ]);
}

// ---------- Worker loop ----------

function startWorker(pool, { intervalMs = 15000, onStarMeter } = {}) {
  let running = false;
  setInterval(async () => {
    if (running) return; running = true;
    try {
      const { rows } = await pool.query(
        `UPDATE cast_queue SET done=true, attempts=attempts+1
         WHERE id IN (SELECT id FROM cast_queue WHERE done=false AND run_at<=now() AND attempts<3 ORDER BY run_at LIMIT 5)
         RETURNING *`);
      for (const job of rows) {
        try {
          const [{ rows: [cast] }, { rows: [video] }] = await Promise.all([
            pool.query('SELECT * FROM cast_members WHERE id=$1', [job.cast_id]),
            pool.query('SELECT * FROM videos WHERE id=$1', [job.video_id]),
          ]);
          if (!video || video.status !== 'live') continue;
          const { rows: [channel] } = await pool.query('SELECT * FROM channels WHERE id=$1', [video.channel_id]);
          if (job.action === 'reaction') {
            const kinds = ['star', 'fire', 'clap', 'heart', 'wow'];
            await pool.query(`INSERT INTO reactions (video_id,cast_id,kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
              [job.video_id, job.cast_id, kinds[Math.floor(Math.random() * kinds.length)]]);
            await onStarMeter?.(channel.id, 1);
          } else {
            let replyBody = null, parentId = null;
            if (job.action === 'reply' && job.reply_to) {
              const { rows: [p] } = await pool.query('SELECT * FROM comments WHERE id=$1', [job.reply_to]);
              if (p) { replyBody = p.body; parentId = p.id; }
            }
            const { rows: hist } = await pool.query(
              `SELECT title FROM videos WHERE channel_id=$1 AND id<>$2 AND status='live' ORDER BY created_at DESC LIMIT 3`,
              [channel.id, video.id]);
            const body = await generateComment(pool, cast, video, channel, replyBody, hist);
            if (body) {
              await pool.query(`INSERT INTO comments (video_id,cast_id,parent_id,body,status) VALUES ($1,$2,$3,$4,'visible')`,
                [job.video_id, job.cast_id, parentId, body]);
              await onStarMeter?.(channel.id, cast.tier === 'judge' ? 5 : 2);
            }
          }
        } catch (e) {
          console.error('[cast] job failed', job.id, e.message);
          if (job.attempts + 1 < 3)
            await pool.query(`UPDATE cast_queue SET done=false, run_at=now() + interval '10 minutes' WHERE id=$1`, [job.id]);
        }
      }
    } catch (e) { console.error('[cast] worker error', e.message); }
    finally { running = false; }
  }, intervalMs);
}

// ---------- Club Chat responder ----------
// Cast joins the group chat: always when @mentioned by name, sometimes on photos,
// occasionally otherwise. Same SAFETY rules; sees recent chat for context.
let lastCastChatAt = 0;
async function maybeChatReply(pool, msg) {
  try {
    const { rows: recent } = await pool.query(
      `SELECT cm.body, cm.image_key, u.display_name AS uname, cs.name AS cname
       FROM chat_messages cm LEFT JOIN users u ON u.id=cm.user_id LEFT JOIN cast_members cs ON cs.id=cm.cast_id
       WHERE cm.status='visible' ORDER BY cm.id DESC LIMIT 10`);
    const context = recent.reverse().map(m =>
      `${m.uname || m.cname}: ${m.image_key ? '[shared a photo] ' : ''}${m.body}`).join('\n');
    const { rows: cast } = await pool.query(
      `SELECT * FROM cast_members WHERE active AND tier IN ('judge','regular')`);
    const lower = (msg.body || '').toLowerCase();
    let responder = cast.find(c => lower.includes(c.name.toLowerCase().split(' ')[0]) || lower.includes(c.name.toLowerCase()));
    const mentioned = !!responder;
    if (!responder) {
      // throttle unprompted chime-ins to one per 90s
      const p = msg.image_key ? 0.7 : 0.35;
      if (Math.random() > p || Date.now() - lastCastChatAt < 90000) return;
      responder = cast[Math.floor(Math.random() * cast.length)];
    }
    lastCastChatAt = Date.now();
    const delay = mentioned ? rand(3000, 15000) : rand(8000, 40000);
    setTimeout(async () => {
      try {
        const role = responder.tier === 'judge'
          ? `You are ${responder.name} ${responder.emoji}, a ${responder.specialty} judge on the club's talent panel. ${responder.persona}`
          : `You are ${responder.name} ${responder.emoji}, a recurring club cast member. ${responder.persona}`;
        const body = await grok([
          { role: 'system', content: `${SAFETY}\n${role}\nYou are chatting in the club group chat. Reply in 1-2 short, fun sentences. Emojis welcome. If someone shared a photo you can react warmly to the idea of it, but you cannot actually see images.` },
          { role: 'user', content: `Recent chat:\n${context}\n\nWrite your next message in the chat.` }
        ], 120);
        if (body) await pool.query(
          `INSERT INTO chat_messages (cast_id,body) VALUES ($1,$2)`, [responder.id, body]);
      } catch (e) { console.error('[chat] cast reply failed:', e.message); }
    }, delay);
  } catch (e) { console.error('[chat] responder error:', e.message); }
}

module.exports = { seedCast, scheduleWave, scheduleReply, startWorker, maybeChatReply };
