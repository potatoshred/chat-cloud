-- 减少写入放大：D1 的 rows written 把「表行」和「索引行」分开计。
-- 普通表插入一行 = 表 + 主键索引 两次写；search_docs 之前还多一个 (session_id) 索引，共三次。
-- 改成 WITHOUT ROWID 后主键就是数据，每行只写一次。
--
-- staged_* 是导入期间的临时数据，直接重建；search_docs 是正式索引，需要先复制。

CREATE TABLE search_docs_v2 (
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, role, message_id)
) WITHOUT ROWID;

INSERT INTO search_docs_v2 (session_id, message_id, role, text, updated_at)
SELECT session_id, message_id, role, text, updated_at FROM search_docs;

-- 主键以 session_id 开头，这个索引完全冗余；DROP TABLE 也会带走它，这里显式清一次。
DROP INDEX IF EXISTS search_docs_session;
DROP TABLE search_docs;
ALTER TABLE search_docs_v2 RENAME TO search_docs;

-- 暂存表由导入流程在每次导入时重新写入，重建不会丢正式数据。
DROP TABLE IF EXISTS staged_docs;
CREATE TABLE staged_docs (
  owner      TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, session_id, role, message_id)
) WITHOUT ROWID;

-- 增加 has_files：类型回写（types）只更新带附件的会话，而不是整库重写。
DROP TABLE IF EXISTS staged_sessions;
CREATE TABLE staged_sessions (
  owner     TEXT NOT NULL,
  id        TEXT NOT NULL,
  json      TEXT NOT NULL,
  has_files INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, id)
);
