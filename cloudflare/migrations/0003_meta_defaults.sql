-- 补上 meta 的初始行（0001 只建表，老库可能缺 generation/version）。
INSERT OR IGNORE INTO meta (key, value) VALUES ('generation', lower(hex(randomblob(16))));
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', '0');
