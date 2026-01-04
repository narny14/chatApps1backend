const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

// Configuration DB
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chat_app",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Stockage des connexions
const connectedUsers = new Map(); // userId -> socketId
const userDevices = new Map(); // userId -> deviceInfo

// Middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ 
    status: "online", 
    connectedUsers: connectedUsers.size,
    timestamp: new Date().toISOString()
  });
});

// Configuration Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ["websocket", "polling"],
  pingTimeout: 30000,
  pingInterval: 15000,
  connectTimeout: 20000
});

// Fonction pour diffuser les utilisateurs en ligne
const broadcastOnlineUsers = () => {
  try {
    const onlineUserIds = Array.from(connectedUsers.keys());
    
    io.emit("active_users_update", {
      onlineUsers: onlineUserIds,
      timestamp: Date.now()
    });
    
    // Notifier chaque utilisateur individuellement
    onlineUserIds.forEach(userId => {
      const socketId = connectedUsers.get(userId);
      if (socketId) {
        io.to(socketId).emit("user_status_update", {
          userId,
          online: true
        });
      }
    });
    
    console.log(`📢 ${onlineUserIds.length} utilisateurs en ligne`);
  } catch (error) {
    console.error("❌ Erreur broadcast:", error);
  }
};

io.on("connection", (socket) => {
  console.log(`🔌 Nouvelle connexion: ${socket.id}`);

  // Enregistrement utilisateur
  socket.on("register_user", async (data) => {
    try {
      const { deviceId, userId: existingUserId } = data;
      
      if (!deviceId) {
        socket.emit("registration_error", { error: "Device ID requis" });
        return;
      }
      
      const connection = await pool.getConnection();
      
      let userId = existingUserId;
      
      if (!userId) {
        // Chercher l'utilisateur par deviceId
        const [existingUsers] = await connection.execute(
          "SELECT id FROM users WHERE device_id = ?",
          [deviceId]
        );
        
        if (existingUsers.length > 0) {
          userId = existingUsers[0].id;
          await connection.execute(
            "UPDATE users SET last_seen = NOW(), is_online = 1 WHERE id = ?",
            [userId]
          );
        } else {
          // Nouvel utilisateur
          const [result] = await connection.execute(
            "INSERT INTO users (device_id, is_online) VALUES (?, 1)",
            [deviceId]
          );
          userId = result.insertId;
        }
      } else {
        // Mettre à jour le statut
        await connection.execute(
          "UPDATE users SET last_seen = NOW(), is_online = 1 WHERE id = ?",
          [userId]
        );
      }
      
      connection.release();
      
      // Stocker les connexions
      connectedUsers.set(userId.toString(), socket.id);
      userDevices.set(userId.toString(), { deviceId, socketId: socket.id });
      socket.userId = userId.toString();
      socket.deviceId = deviceId;
      
      console.log(`✅ User ${userId} connecté (${socket.id})`);
      
      // Confirmer l'enregistrement
      socket.emit("registration_success", {
        userId,
        deviceId,
        socketId: socket.id
      });
      
      // Notifier les autres utilisateurs
      socket.broadcast.emit("user_connected", {
        userId,
        timestamp: Date.now()
      });
      
      // Envoyer la liste des utilisateurs
      setTimeout(async () => {
        await sendUserList(socket);
        broadcastOnlineUsers();
      }, 100);
      
    } catch (error) {
      console.error("❌ Erreur register_user:", error);
      socket.emit("registration_error", { error: error.message });
    }
  });

  // Envoyer la liste des utilisateurs
  const sendUserList = async (socket) => {
    try {
      if (!socket.userId) return;
      
      const connection = await pool.getConnection();
      const [users] = await connection.execute(
        "SELECT id, device_id, is_online FROM users WHERE id != ? ORDER BY last_seen DESC",
        [socket.userId]
      );
      
      connection.release();
      
      // Ajouter le statut en ligne depuis la Map
      const usersWithStatus = users.map(user => ({
        ...user,
        online: connectedUsers.has(user.id.toString()) || user.is_online === 1
      }));
      
      socket.emit("users_list", usersWithStatus);
      
    } catch (error) {
      console.error("❌ Erreur sendUserList:", error);
    }
  };

  // Demande de la liste des utilisateurs
  socket.on("get_users", async () => {
    await sendUserList(socket);
  });

  // Envoyer un message
  socket.on("send_message", async (data) => {
    try {
      const { receiverId, message, tempId } = data;
      const senderId = socket.userId;
      
      if (!senderId) {
        socket.emit("message_error", { 
          error: "Non authentifié",
          tempId 
        });
        return;
      }
      
      if (!receiverId || !message?.trim()) {
        socket.emit("message_error", {
          error: "Destinataire ou message invalide",
          tempId
        });
        return;
      }
      
      const messageText = message.trim();
      console.log(`💬 ${senderId} → ${receiverId}: "${messageText.substring(0, 50)}"`);
      
      const connection = await pool.getConnection();
      
      // Sauvegarder le message
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [senderId, receiverId, messageText]
      );
      
      const messageId = result.insertId;
      
      // Récupérer le message complet
      const [messages] = await connection.execute(
        `SELECT m.*, 
                u1.device_id as sender_device,
                u2.device_id as receiver_device
         FROM messages m
         LEFT JOIN users u1 ON m.sender_id = u1.id
         LEFT JOIN users u2 ON m.receiver_id = u2.id
         WHERE m.id = ?`,
        [messageId]
      );
      
      connection.release();
      
      const messageData = {
        ...messages[0],
        tempId,
        id: messageId
      };
      
      // 1. Confirmer à l'expéditeur IMMÉDIATEMENT
      socket.emit("message_sent", messageData);
      console.log(`✅ Message ${messageId} sauvegardé`);
      
      // 2. Envoyer au destinataire en temps réel
      const receiverSocketId = connectedUsers.get(receiverId.toString());
      
      if (receiverSocketId) {
        // Destinataire en ligne
        io.to(receiverSocketId).emit("new_message", messageData);
        console.log(`📩 Message ${messageId} envoyé en temps réel à ${receiverId}`);
        
        // Notifier l'expéditeur que le message a été délivré
        socket.emit("message_delivered", {
          messageId,
          receiverId,
          timestamp: Date.now()
        });
      } else {
        // Destinataire hors ligne
        console.log(`⚠️ Destinataire ${receiverId} hors ligne, message stocké`);
      }
      
    } catch (error) {
      console.error("❌ Erreur send_message:", error);
      socket.emit("message_error", {
        error: error.message,
        tempId: data.tempId
      });
    }
  });

  // Récupérer une conversation
  socket.on("get_conversation", async (data) => {
    try {
      const { otherUserId, limit = 50 } = data;
      const userId = socket.userId;
      
      if (!userId) return;
      
      const connection = await pool.getConnection();
      const [messages] = await connection.execute(
        `SELECT m.*, 
                u1.device_id as sender_device,
                u2.device_id as receiver_device
         FROM messages m
         LEFT JOIN users u1 ON m.sender_id = u1.id
         LEFT JOIN users u2 ON m.receiver_id = u2.id
         WHERE (m.sender_id = ? AND m.receiver_id = ?)
            OR (m.sender_id = ? AND m.receiver_id = ?)
         ORDER BY m.created_at ASC
         LIMIT ?`,
        [userId, otherUserId, otherUserId, userId, parseInt(limit)]
      );
      
      connection.release();
      
      socket.emit("conversation_history", {
        userId,
        otherUserId,
        messages,
        total: messages.length
      });
      
    } catch (error) {
      console.error("❌ Erreur get_conversation:", error);
      socket.emit("conversation_error", { error: error.message });
    }
  });

  // Marquer les messages comme lus
  socket.on("mark_as_read", async (data) => {
    try {
      const { messageIds } = data;
      
      if (!socket.userId || !messageIds?.length) return;
      
      const connection = await pool.getConnection();
      await connection.execute(
        "UPDATE messages SET is_read = 1 WHERE id IN (?)",
        [messageIds]
      );
      connection.release();
      
      socket.emit("messages_read", { messageIds });
      
    } catch (error) {
      console.error("❌ Erreur mark_as_read:", error);
    }
  });

  // Déconnexion
  socket.on("disconnect", async () => {
    console.log(`🔴 Déconnexion: ${socket.id}`);
    
    if (socket.userId) {
      const userId = socket.userId;
      
      // Retirer de la liste des connectés
      connectedUsers.delete(userId);
      userDevices.delete(userId);
      
      try {
        const connection = await pool.getConnection();
        await connection.execute(
          "UPDATE users SET is_online = 0 WHERE id = ?",
          [userId]
        );
        connection.release();
      } catch (error) {
        console.error("❌ Erreur mise à jour statut offline:", error);
      }
      
      // Notifier les autres utilisateurs
      socket.broadcast.emit("user_disconnected", {
        userId,
        timestamp: Date.now()
      });
      
      // Mettre à jour la liste des utilisateurs en ligne
      setTimeout(() => {
        broadcastOnlineUsers();
      }, 500);
    }
  });
});

// Initialiser la base de données
async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Table utilisateurs
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        is_online TINYINT DEFAULT 0,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_device (device_id),
        INDEX idx_online (is_online)
      )
    `);
    
    // Table messages
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        message TEXT NOT NULL,
        is_read TINYINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_conversation (sender_id, receiver_id, created_at),
        INDEX idx_receiver (receiver_id, is_read),
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    
    await connection.ping();
    connection.release();
    
    console.log("✅ Base de données initialisée avec succès");
    
  } catch (error) {
    console.error("❌ Erreur initialisation DB:", error);
    process.exit(1);
  }
}

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Serveur de chat démarré sur le port ${PORT}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  
  await initDatabase();
  
  // Nettoyer les connexions périodiquement
  setInterval(() => {
    console.log(`👥 Statistiques: ${connectedUsers.size} utilisateurs connectés`);
  }, 30000);
});