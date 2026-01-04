const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

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

// Stockage des utilisateurs connectés
const userToSocket = new Map();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

app.get("/", (req, res) => res.send("✅ Chat Server Ready"));

// 🔥 CONFIGURATION SOCKET.IO AMÉLIORÉE
const io = new Server(server, {
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 30000, // Augmenté à 30s
  allowEIO3: true
});

io.on("connection", (socket) => {
  console.log(`🟢 Socket connecté: ${socket.id}`);

  // ENREGISTREMENT
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data;
      
      if (!deviceId) {
        socket.emit("register_error", "Device ID requis");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // Trouver ou créer l'utilisateur
      const [existing] = await connection.execute(
        "SELECT id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      if (existing.length > 0) {
        userId = existing[0].id;
        await connection.execute(
          "UPDATE users SET last_seen = NOW() WHERE id = ?",
          [userId]
        );
      } else {
        const [result] = await connection.execute(
          "INSERT INTO users (device_id) VALUES (?)",
          [deviceId]
        );
        userId = result.insertId;
      }
      
      connection.release();
      
      // Associer userId et socket
      userToSocket.set(userId.toString(), socket.id);
      socket.userId = userId.toString();
      
      console.log(`✅ User ${userId} ↔ Socket ${socket.id}`);
      
      // Répondre
      socket.emit("register_success", { userId, deviceId });
      
      // 🔥 ENVOYER LA LISTE DES UTILISATEURS DIRECTEMENT
      setTimeout(() => {
        broadcastUserList();
      }, 500);
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", error.message);
    }
  });

  // ENVOYER MESSAGE
  socket.on("send_message", async (data) => {
    try {
      const { receiverId, message, tempId } = data;
      const senderId = socket.userId;
      
      if (!senderId) {
        socket.emit("message_error", { 
          error: "Non enregistré",
          tempId 
        });
        return;
      }
      
      if (!receiverId || !message?.trim()) {
        socket.emit("message_error", {
          error: "Données invalides",
          tempId
        });
        return;
      }
      
      console.log(`📤 User ${senderId} → ${receiverId}: "${message.substring(0, 50)}..."`);
      
      const connection = await pool.getConnection();
      
      // Sauvegarder le message
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [senderId, receiverId, message.trim()]
      );
      
      // Récupérer le message complet
      const [messages] = await connection.execute(
        "SELECT * FROM messages WHERE id = ?",
        [result.insertId]
      );
      
      connection.release();
      
      const messageData = {
        ...messages[0],
        tempId // Retourner le tempId pour matching côté client
      };
      
      // 1. Confirmer à l'expéditeur
      socket.emit("message_sent", messageData);
      console.log(`✅ Message ${result.insertId} sauvegardé`);
      
      // 2. Envoyer au destinataire
      const receiverSocketId = userToSocket.get(receiverId.toString());
      
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receive_message", messageData);
        console.log(`📩 Message envoyé en temps réel à ${receiverId} (socket: ${receiverSocketId})`);
      } else {
        console.log(`⚠️ Destinataire ${receiverId} hors ligne`);
      }
      
    } catch (error) {
      console.error("❌ Erreur message:", error);
      socket.emit("message_error", {
        error: error.message,
        tempId: data.tempId
      });
    }
  });

  // LISTE UTILISATEURS
  socket.on("get_users", async () => {
    try {
      if (!socket.userId) return;
      
      const connection = await pool.getConnection();
      const [users] = await connection.execute(
        "SELECT id, device_id FROM users WHERE id != ? ORDER BY last_seen DESC",
        [socket.userId]
      );
      
      connection.release();
      
      // 🔥 CORRECTION : AJOUTER LE STATUT ONLINE
      const usersWithStatus = users.map(user => ({
        ...user,
        online: userToSocket.has(user.id.toString())
      }));
      
      socket.emit("users_list", usersWithStatus);
      
    } catch (error) {
      console.error("❌ Erreur get_users:", error);
    }
  });

  // MESSAGES
  socket.on("get_messages", async (data) => {
    try {
      const { otherUserId } = data;
      const senderId = socket.userId;
      
      if (!senderId) return;
      
      const connection = await pool.getConnection();
      const [messages] = await connection.execute(
        `SELECT * FROM messages 
         WHERE (sender_id = ? AND receiver_id = ?) 
         OR (sender_id = ? AND receiver_id = ?) 
         ORDER BY created_at ASC`,
        [senderId, otherUserId, otherUserId, senderId]
      );
      
      connection.release();
      
      socket.emit("messages_list", {
        userId: senderId,
        otherUserId,
        messages
      });
      
    } catch (error) {
      console.error("❌ Erreur get_messages:", error);
    }
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    console.log(`🔴 Déconnexion: socket ${socket.id}`);
    
    if (socket.userId) {
      userToSocket.delete(socket.userId);
      broadcastUserList();
    }
  });
});

// 🔥 CORRECTION : FONCTION POUR DIFFUSER LA LISTE DES UTILISATEURS
function broadcastUserList() {
  try {
    const onlineUsers = Array.from(userToSocket.keys());
    
    console.log(`🌐 Broadcast users: ${onlineUsers.length} en ligne`);
    
    // 🔥 GARANTIR QUE onlineUsers EST TOUJOURS UN TABLEAU
    const onlineUserIds = Array.isArray(onlineUsers) ? onlineUsers : [];
    
    io.emit("active_users", {
      onlineUsers: onlineUserIds,
      timestamp: Date.now(),
      total: onlineUserIds.length
    });
    
  } catch (error) {
    console.error("❌ Erreur broadcastUserList:", error);
    // En cas d'erreur, envoyer un tableau vide
    io.emit("active_users", {
      onlineUsers: [],
      timestamp: Date.now(),
      total: 0
    });
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Serveur sur port ${PORT}`);
  
  try {
    const connection = await pool.getConnection();
    
    // Vérifier/créer les tables
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_sender_receiver (sender_id, receiver_id),
        INDEX idx_timestamp (created_at)
      )
    `);
    
    await connection.ping();
    connection.release();
    console.log("✅ DB connectée et tables vérifiées");
  } catch (error) {
    console.error("❌ Erreur DB:", error.message);
  }
});