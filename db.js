import "dotenv/config";
import mysql from "mysql2/promise";

const {
  DB_HOST = "localhost",
  DB_PORT = "3306",
  DB_USER = "root",
  DB_PASSWORD = "0123456789",
  DB_NAME = "vie_content_planner",
  DB_SSL = "false",
  DB_SSL_CA = "",
} = process.env;

const sslOptions =
  DB_SSL === "true"
    ? DB_SSL_CA
      ? { ca: DB_SSL_CA, rejectUnauthorized: true }
      : { rejectUnauthorized: false }
    : undefined;

export async function initDb() {
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    ssl: sslOptions,
  });
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();

  const pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT),
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    ssl: sslOptions,
    waitForConnections: true,
    connectionLimit: 10,
    charset: "utf8mb4",
    dateStrings: true,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      post_date DATE NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT '',
      content TEXT,
      asset_note TEXT,
      time_fb VARCHAR(10) NOT NULL DEFAULT '',
      time_ig VARCHAR(10) NOT NULL DEFAULT '',
      time_threads VARCHAR(10) NOT NULL DEFAULT '',
      status ENUM('idea','scheduled','posted') NOT NULL DEFAULT 'idea',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [detailCol] = await pool.query(`SHOW COLUMNS FROM ideas LIKE 'detail_content'`);
  if (detailCol.length === 0) {
    await pool.query(`ALTER TABLE ideas ADD COLUMN detail_content TEXT AFTER content`);
  }

  const [formatCol] = await pool.query(`SHOW COLUMNS FROM ideas LIKE 'post_format'`);
  if (formatCol.length === 0) {
    await pool.query(
      `ALTER TABLE ideas ADD COLUMN post_format ENUM('image','carousel','video','reel','story_image','story_video') NOT NULL DEFAULT 'image' AFTER category`
    );
  }

  for (const col of ["fb_post_id", "ig_post_id", "threads_post_id"]) {
    const [c] = await pool.query(`SHOW COLUMNS FROM ideas LIKE '${col}'`);
    if (c.length === 0) {
      await pool.query(`ALTER TABLE ideas ADD COLUMN ${col} VARCHAR(191) NULL`);
    }
  }

  // Migrate dữ liệu cũ (in_progress/done) sang trạng thái mới (scheduled/posted) nếu có
  const [statusCol] = await pool.query(`SHOW COLUMNS FROM ideas LIKE 'status'`);
  if (statusCol.length > 0 && /in_progress|done/.test(statusCol[0].Type)) {
    await pool.query(
      `ALTER TABLE ideas MODIFY status ENUM('idea','in_progress','done','scheduled','posted') NOT NULL DEFAULT 'idea'`
    );
    await pool.query(`UPDATE ideas SET status = 'scheduled' WHERE status = 'in_progress'`);
    await pool.query(`UPDATE ideas SET status = 'posted' WHERE status = 'done'`);
    await pool.query(
      `ALTER TABLE ideas MODIFY status ENUM('idea','scheduled','posted') NOT NULL DEFAULT 'idea'`
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS assets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      idea_id INT NOT NULL,
      file_path VARCHAR(255) NOT NULL,
      original_name VARCHAR(255) NOT NULL DEFAULT '',
      kind ENUM('image','demo') NOT NULL DEFAULT 'image',
      platform ENUM('fb','ig_threads','general') NOT NULL DEFAULT 'general',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_assets_idea FOREIGN KEY (idea_id) REFERENCES ideas(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [platformCol] = await pool.query(`SHOW COLUMNS FROM assets LIKE 'platform'`);
  if (platformCol.length === 0) {
    await pool.query(
      `ALTER TABLE assets ADD COLUMN platform ENUM('fb','ig_threads','general') NOT NULL DEFAULT 'general' AFTER kind`
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      zoho_id VARCHAR(64) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL,
      display_name VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_login_ip VARCHAR(64) DEFAULT NULL,
      last_login_device VARCHAR(255) DEFAULT NULL,
      last_login_location VARCHAR(255) DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  for (const col of ["last_login_ip", "last_login_device", "last_login_location"]) {
    const [existing] = await pool.query(`SHOW COLUMNS FROM users LIKE ?`, [col]);
    if (existing.length === 0) {
      await pool.query(`ALTER TABLE users ADD COLUMN ${col} VARCHAR(255) DEFAULT NULL`);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      sort_order INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const DEFAULT_CATEGORIES = [
    "Thương hiệu/Mascot",
    "Ứng dụng AI",
    "Chuyên môn",
    "Outsource",
    "Sản phẩm Vienify",
    "Tuyển dụng",
  ];
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    await pool.query(
      `INSERT IGNORE INTO categories (name, sort_order) VALUES (?, ?)`,
      [DEFAULT_CATEGORIES[i], i]
    );
  }

  return pool;
}
