-- 导入暂存的搜索片段：提交时直接复制到 search_docs。
CREATE TABLE IF NOT EXISTS staged_docs (
  owner      TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, session_id, role, message_id)
);
