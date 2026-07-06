-- KidStarClub schema. Idempotent — safe to run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('admin','kid','member')), -- member = family/classmate
  display_name  TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_emoji  TEXT DEFAULT '⭐',
  invited_by    INT REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  status_reason TEXT,
  status_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code       TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('kid','member')),
  note       TEXT,                -- e.g. "Grandma", "Ms. Rivera's class"
  max_uses   INT NOT NULL DEFAULT 1,
  uses       INT NOT NULL DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked    BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  owner_id   INT NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,               -- "Nova's Stage"
  tagline    TEXT DEFAULT '',
  star_meter INT NOT NULL DEFAULT 0,
  moderation TEXT NOT NULL DEFAULT 'pre' CHECK (moderation IN ('pre','post')), -- per-channel toggle
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
  id          SERIAL PRIMARY KEY,
  channel_id  INT NOT NULL REFERENCES channels(id),
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  bucket_key  TEXT NOT NULL,              -- object key in Tigris bucket
  thumb_key   TEXT,
  duration_s  INT,
  status      TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','hidden','removed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cast members: AI characters, openly labeled. Never presented as humans.
CREATE TABLE IF NOT EXISTS cast_members (
  id         SERIAL PRIMARY KEY,
  tier       TEXT NOT NULL CHECK (tier IN ('judge','regular','crowd')),
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '🤖',
  persona    TEXT NOT NULL,               -- system-prompt personality blurb
  specialty  TEXT,                        -- judges: "vocal coach", "producer"...
  active     BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS comments (
  id          SERIAL PRIMARY KEY,
  video_id    INT NOT NULL REFERENCES videos(id),
  -- exactly one author type
  user_id     INT REFERENCES users(id),
  cast_id     INT REFERENCES cast_members(id),
  parent_id   INT REFERENCES comments(id),
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'visible'
              CHECK (status IN ('pending','visible','removed','flagged')),
  removed_by  INT REFERENCES users(id),
  remove_note TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ( (user_id IS NULL) <> (cast_id IS NULL) )
);

CREATE TABLE IF NOT EXISTS reactions (
  id         SERIAL PRIMARY KEY,
  video_id   INT NOT NULL REFERENCES videos(id),
  user_id    INT REFERENCES users(id),
  cast_id    INT REFERENCES cast_members(id),
  kind       TEXT NOT NULL DEFAULT 'star' CHECK (kind IN ('star','fire','clap','heart','wow')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ( (user_id IS NULL) <> (cast_id IS NULL) ),
  UNIQUE (video_id, user_id, kind),
  UNIQUE (video_id, cast_id, kind)
);

-- Drip scheduler: cast engagement queued over 24-48h after a post.
CREATE TABLE IF NOT EXISTS cast_queue (
  id        SERIAL PRIMARY KEY,
  video_id  INT NOT NULL REFERENCES videos(id),
  cast_id   INT NOT NULL REFERENCES cast_members(id),
  action    TEXT NOT NULL CHECK (action IN ('comment','reaction','reply')),
  reply_to  INT REFERENCES comments(id),
  run_at    TIMESTAMPTZ NOT NULL,
  done      BOOLEAN NOT NULL DEFAULT false,
  attempts  INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS badges (
  id         SERIAL PRIMARY KEY,
  channel_id INT NOT NULL REFERENCES channels(id),
  key        TEXT NOT NULL,               -- 'first_post','gold_record_10','challenge_summer'
  label      TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '🏅',
  earned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, key)
);

CREATE TABLE IF NOT EXISTS mod_log (
  id         SERIAL PRIMARY KEY,
  admin_id   INT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,   -- 'remove_comment','approve_comment','suspend_user','ban_user','restore_user','hide_video','revoke_invite'
  target     TEXT NOT NULL,   -- 'comment:123','user:4','video:9'
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_comments_video   ON comments(video_id, status);
CREATE INDEX IF NOT EXISTS idx_comments_pending ON comments(status) WHERE status IN ('pending','flagged');
CREATE INDEX IF NOT EXISTS idx_queue_due        ON cast_queue(run_at) WHERE done = false;
CREATE INDEX IF NOT EXISTS idx_reactions_video  ON reactions(video_id);

-- v2: shorts
ALTER TABLE videos ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'video';

-- v3: direct-to-bucket uploads
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_status_check;
ALTER TABLE videos ADD CONSTRAINT videos_status_check CHECK (status IN ('uploading','live','hidden','removed'));

-- v4: subscriptions (real members only — the cast never subscribes)
CREATE TABLE IF NOT EXISTS subscriptions (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id),
  channel_id INT NOT NULL REFERENCES channels(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel_id)
);

-- v5: Studio song library (admin-curated backing tracks)
CREATE TABLE IF NOT EXISTS tracks (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  added_by   INT REFERENCES users(id),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
