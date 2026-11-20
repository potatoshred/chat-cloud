-- Cloudflare 免费版（Workers + D1）的表结构。
-- 与 deploy/auth/data-store.mjs 的语义保持一致，但去掉了 SQLite 触发器和 session_meta 派生表：
-- D1 对触发器的支持没有明确文档，摘要改为查询时用 json_extract 计算。
-- 注意：D1 单行/BLOB 上限 2MB，附件上限在 worker 里强制为 2MB。

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 初始版本号与库标识；INSERT OR IGNORE 保证重复执行不覆盖已有值。
INSERT OR IGNORE INTO meta (key, value) VALUES ('generation', lower(hex(randomblob(16))));
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');

CREATE TABLE IF NOT EXISTS sessions (
  id       TEXT PRIMARY KEY,
  json     TEXT NOT NULL,
  revision TEXT NOT NULL
);

-- 搜索索引：写入会话时按现有规则抽取文本，查询用 instr() 匹配（D1 的 LIKE 模式上限 50 字节）。
-- WITHOUT ROWID：主键即数据，每行只写一次（普通表要写"表 + 主键索引"两次）。
-- 主键以 session_id 开头，按会话删除/查询都能走前缀，不需要额外索引。
CREATE TABLE IF NOT EXISTS search_docs (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, role, message_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS files (
  id    TEXT PRIMARY KEY,
  mime  TEXT NOT NULL,
  bytes BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id       TEXT PRIMARY KEY,
  json     TEXT NOT NULL,
  revision TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key  TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id      TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staged_sessions (
  owner     TEXT NOT NULL,
  id        TEXT NOT NULL,
  json      TEXT NOT NULL,
  -- 该会话是否带附件：类型回写只处理这些会话，避免整库重写 JSON。
  has_files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, id)
);

-- 导入时就把搜索片段抽好，提交时用 INSERT ... SELECT 复制，避免在 commit 里解析大量会话。
CREATE TABLE IF NOT EXISTS staged_docs (
  owner      TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, session_id, role, message_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS staged_files (
  owner TEXT NOT NULL,
  id    TEXT NOT NULL,
  mime  TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (owner, id)
);
