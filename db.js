const mysql = require("mysql2");
require("dotenv").config();

const db = mysql.createPool({
  host: process.env.DB_HOST,  // ✅ CORRECT
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,  // ✅ CORRECT
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10,
});

db.getConnection((err, connection) => {
  if (err) {
    console.error("❌ Erreur détaillée MySQL :", {
      message: err.message,
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState,
      sqlMessage: err.sqlMessage,
      address: err.address,
      port: err.port,
      stack: err.stack
    });
    
    console.log("🔍 Configuration utilisée :", {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      database: process.env.DB_NAME
    });
  } else {
    console.log("✅ Connexion MySQL réussie à:", process.env.DB_HOST);
    connection.release();
  }
});

module.exports = db;
