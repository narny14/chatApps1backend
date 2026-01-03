const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

// Configuration DB
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

// 🔥 ROUTES DE BASE
app.get("/", (req, res) => res.send("✅ Chat Server Ready"));

app.get("/test-db", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.json({ success: true, message: "DB connected" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 ROUTE POUR CRÉER LES TABLES (SANS username)
app.get("/setup", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Table users SANS username
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Table messages
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sender (sender_id),
        INDEX idx_receiver (receiver_id)
      )
    `);
    
    connection.release();
    res.json({ success: true, message: "Tables créées (sans username)" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 SOCKET.IO
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

const activeUsers = new Map();

io.on("connection", (socket) => {
  console.log(`🟢 Nouveau client: ${socket.id}`);

  // ÉVÉNEMENT 1: ENREGISTREMENT (SIMPLE, SANS username)
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data; // SEULEMENT deviceId, pas de username
      
      if (!deviceId) {
        socket.emit("register_error", "Device ID requis");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // 1. Vérifier si la table a la colonne username
      const [columns] = await connection.execute(`
        SHOW COLUMNS FROM users LIKE 'username'
      `);
      
      const hasUsername = columns.length > 0;
      
      // 2. Trouver ou créer l'utilisateur
      const [existingUsers] = await connection.execute(
        "SELECT id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      if (existingUsers.length > 0) {
        userId = existingUsers[0].id;
        await connection.execute(
          "UPDATE users SET last_seen = NOW() WHERE id = ?",
          [userId]
        );
      } else {
        // Insertion selon la structure de la table
        if (hasUsername) {
          const [result] = await connection.execute(
            "INSERT INTO users (device_id, username) VALUES (?, ?)",
            [deviceId, `User_${Date.now().toString().slice(-4)}`]
          );
          userId = result.insertId;
        } else {
          const [result] = await connection.execute(
            "INSERT INTO users (device_id) VALUES (?)",
            [deviceId]
          );
          userId = result.insertId;
        }
      }
      
      connection.release();
      
      // Stocker en mémoire
      activeUsers.set(socket.id, { userId, deviceId });
      
      // Répondre
      socket.emit("register_success", { 
        userId, 
        deviceId,
        message: "Enregistrement réussi" 
      });
      
      // Diffuser liste utilisateurs
      broadcastUserList();
      
      console.log(`✅ Enregistré: User ${userId} (${deviceId.substring(0, 20)}...)`);
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", { 
        error: error.message,
        code: error.code 
      });
    }
  });

  // ÉVÉNEMENT 2: ENVOYER MESSAGE
  socket.on("send_message", async (data) => {
    try {
      const { receiverId, message } = data;
      const sender = activeUsers.get(socket.id);
      
      if (!sender) {
        socket.emit("message_error", "Non enregistré");
        return;
      }
      
      if (!receiverId || !message?.trim()) {
        socket.emit("message_error", "Données invalides");
        return;
      }
      
      const connection = await pool.getConnection();
      
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [sender.userId, receiverId, message.trim()]
      );
      
      connection.release();
      
      const messageData = {
        id: result.insertId,
        sender_id: sender.userId,
        receiver_id: receiverId,
        message: message.trim(),
        created_at: new Date().toISOString()
      };
      
      // Confirmer à l'expéditeur
      socket.emit("message_sent", messageData);
      
      // Envoyer au destinataire
      const receiverSocket = findSocketByUserId(receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit("receive_message", messageData);
        console.log(`📩 ${sender.userId} → ${receiverId}: "${message.substring(0, 30)}..."`);
      }
      
    } catch (error) {
      console.error("❌ Erreur message:", error);
      socket.emit("message_error", error.message);
    }
  });

  // ÉVÉNEMENT 3: LISTE UTILISATEURS
  socket.on("get_users", async () => {
    try {
      const connection = await pool.getConnection();
      
      // Vérifier si la colonne username existe
      const [columns] = await connection.execute(`
        SHOW COLUMNS FROM users LIKE 'username'
      `);
      
      let query;
      if (columns.length > 0) {
        query = "SELECT id, device_id, username, last_seen FROM users ORDER BY last_seen DESC";
      } else {
        query = "SELECT id, device_id, last_seen FROM users ORDER BY last_seen DESC";
      }
      
      const [users] = await connection.execute(query);
      connection.release();
      
      socket.emit("users_list", users);
      
    } catch (error) {
      console.error("❌ Erreur liste users:", error);
    }
  });

  // ÉVÉNEMENT 4: MESSAGES
  socket.on("get_messages", async (data) => {
    try {
      const { otherUserId } = data;
      const sender = activeUsers.get(socket.id);
      
      if (!sender) return;
      
      const connection = await pool.getConnection();
      const [messages] = await connection.execute(
        `SELECT * FROM messages 
         WHERE (sender_id = ? AND receiver_id = ?) 
         OR (sender_id = ? AND receiver_id = ?) 
         ORDER BY created_at ASC 
         LIMIT 100`,
        [sender.userId, otherUserId, otherUserId, sender.userId]
      );
      
      connection.release();
      
      socket.emit("messages_list", {
        userId: sender.userId,
        otherUserId,
        messages
      });
      
    } catch (error) {
      console.error("❌ Erreur messages:", error);
    }
  });

  // ÉVÉNEMENT 5: PING
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      console.log(`🔴 Déconnexion: User ${user.userId}`);
      activeUsers.delete(socket.id);
      broadcastUserList();
    }
  });
});

// FONCTIONS UTILES
function findSocketByUserId(userId) {
  for (const [socketId, user] of activeUsers.entries()) {
    if (user.userId === userId) return socketId;
  }
  return null;
}

function broadcastUserList() {
  const users = Array.from(activeUsers.values()).map(u => ({
    id: u.userId,
    deviceId: u.deviceId,
    online: true
  }));
  io.emit("active_users", users);
}

// DÉMARRAGE
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Serveur sur port ${PORT}`);
  
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log("✅ DB connectée");
  } catch (error) {
    console.error("❌ Erreur DB:", error.message);
  }
});