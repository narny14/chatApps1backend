const mysql = require("mysql2/promise");
require("dotenv").config();

async function initDatabase() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || "centerbeam.proxy.rlwy.net",
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "hcyWqBlfnvbihFsayzebffBaxXtNihBz",
      database: process.env.DB_NAME || "railway",
      port: process.env.DB_PORT || 44341,
      ssl: { rejectUnauthorized: false }
    });

    console.log("🔗 Connexion à Railway MySQL établie");

    // Table users
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        online TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_online (online),
        INDEX idx_device_id (device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("✅ Table 'users' créée/vérifiée");

    // Table messages
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sender (sender_id),
        INDEX idx_receiver (receiver_id),
        INDEX idx_conversation (sender_id, receiver_id),
        INDEX idx_created (created_at),
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("✅ Table 'messages' créée/vérifiée");

    // Vérifier les colonnes
    const [userColumns] = await connection.execute("DESCRIBE users");
    console.log("📋 Colonnes de la table 'users':");
    userColumns.forEach(col => console.log(`  - ${col.Field} (${col.Type})`));

    const [messageColumns] = await connection.execute("DESCRIBE messages");
    console.log("📋 Colonnes de la table 'messages':");
    messageColumns.forEach(col => console.log(`  - ${col.Field} (${col.Type})`));

    await connection.end();
    console.log("🎉 Base de données initialisée avec succès !");
    
  } catch (error) {
    console.error("❌ Erreur d'initialisation:", error);
  }
}

initDatabase();