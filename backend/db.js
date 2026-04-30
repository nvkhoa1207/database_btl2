const mysql = require("mysql2/promise");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, ".env") });

const requiredEnv = ["DB_USER", "DB_NAME"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  throw new Error(
    `Missing database config: ${missingEnv.join(
      ", "
    )}. Create .env in the project root or backend/.env with your MySQL settings.`
  );
}

const sslConfig =
  process.env.DB_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
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
