const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

// Configuration simple de la base de données
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

// Middleware CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

// 🔥 ROUTE SIMPLE DE TEST
app.get("/", (req, res) => {
  res.send("✅ Chat Server Ready");
});

// 🔥 ROUTE POUR TESTER LA CONNEXION DB
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

// 🔥 ROUTE POUR CRÉER LES TABLES SI ELLES N'EXISTENT PAS
app.get("/setup-db", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Créer table users
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE,
        username VARCHAR(100) DEFAULT 'User',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Créer table messages
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sender (sender_id),
        INDEX idx_receiver (receiver_id),
        INDEX idx_conversation (sender_id, receiver_id)
      )
    `);
    
    connection.release();
    res.json({ success: true, message: "Tables créées ou déjà existantes" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 SOCKET.IO - SIMPLIFIÉ AU MAXIMUM
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

// Stockage simple en mémoire pour les connexions actives
const activeUsers = new Map(); // socketId -> { userId, deviceId }

io.on("connection", (socket) => {
  console.log(`🟢 Nouveau client connecté: ${socket.id}`);

  // ÉVÉNEMENT 1: ENREGISTREMENT SIMPLE
  socket.on("register", async (data) => {
    try {
      const { deviceId, username } = data;
      
      if (!deviceId) {
        socket.emit("register_error", "Device ID requis");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // Trouver ou créer l'utilisateur
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
        const [result] = await connection.execute(
          "INSERT INTO users (device_id, username) VALUES (?, ?)",
          [deviceId, username || `User_${Date.now().toString().slice(-4)}`]
        );
        userId = result.insertId;
      }
      
      connection.release();
      
      // Stocker en mémoire
      activeUsers.set(socket.id, { userId, deviceId });
      
      // Répondre au client
      socket.emit("register_success", { userId, deviceId });
      
      // Diffuser la liste mise à jour des utilisateurs
      broadcastUserList();
      
      console.log(`✅ Utilisateur enregistré: ${userId} (${deviceId})`);
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", error.message);
    }
  });

  // ÉVÉNEMENT 2: ENVOYER UN MESSAGE
  socket.on("send_message", async (data) => {
    try {
      const { receiverId, message } = data;
      const sender = activeUsers.get(socket.id);
      
      if (!sender) {
        socket.emit("message_error", "Non enregistré");
        return;
      }
      
      if (!receiverId || !message?.trim()) {
        socket.emit("message_error", "Destinataire ou message invalide");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // Sauvegarder le message
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
      
      // 1. Confirmer à l'expéditeur
      socket.emit("message_sent", messageData);
      
      // 2. Envoyer au destinataire s'il est connecté
      const receiverSocketId = findSocketIdByUserId(receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receive_message", messageData);
        console.log(`📩 Message envoyé de ${sender.userId} à ${receiverId}`);
      } else {
        console.log(`📩 Message sauvegardé (destinataire ${receiverId} hors ligne)`);
      }
      
    } catch (error) {
      console.error("❌ Erreur envoi message:", error);
      socket.emit("message_error", error.message);
    }
  });

  // ÉVÉNEMENT 3: RÉCUPÉRER LES UTILISATEURS
  socket.on("get_users", async () => {
    try {
      const connection = await pool.getConnection();
      const [users] = await connection.execute(
        "SELECT id, username, device_id, last_seen FROM users ORDER BY last_seen DESC"
      );
      connection.release();
      
      socket.emit("users_list", users);
    } catch (error) {
      console.error("❌ Erreur récupération utilisateurs:", error);
    }
  });

  // ÉVÉNEMENT 4: RÉCUPÉRER LES MESSAGES
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
      console.error("❌ Erreur récupération messages:", error);
    }
  });

  // ÉVÉNEMENT 5: PING
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    console.log(`🔴 Déconnexion: ${socket.id}`);
    activeUsers.delete(socket.id);
    broadcastUserList();
  });
});

// 🔥 FONCTIONS UTILES
function findSocketIdByUserId(userId) {
  for (const [socketId, user] of activeUsers.entries()) {
    if (user.userId === userId) {
      return socketId;
    }
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

// 🔥 DÉMARRAGE DU SERVEUR
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Serveur chat démarré sur le port ${PORT}`);
  
  // Tester la connexion DB
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log("✅ Base de données connectée");
  } catch (error) {
    console.error("❌ Erreur connexion DB:", error.message);
  }
});