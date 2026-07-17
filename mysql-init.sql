-- GMS 本地数据库初始化
-- MySQL 8.0 Docker entrypoint 会自动创建 gms 库和 Wuzhenyu 用户（由 MYSQL_DATABASE/MYSQL_USER 环境变量驱动）
-- server.js 的 initDB() / migrateDB() 负责创建表结构和索引
-- 此文件仅做编码校验

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
