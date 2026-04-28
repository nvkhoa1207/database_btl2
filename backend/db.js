const mysql = require("mysql2/promise");
require("dotenv").config();

const sslConfig =
  process.env.DB_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0,
  ssl: sslConfig,
});

module.exports = pool;