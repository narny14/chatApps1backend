const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

// Configuration de la base de données
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chat_app",
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Stockage des connexions
const connectedUsers = new Map(); // userId -> socketId
const userSockets = new Map(); // socketId -> {userId, deviceId}

// Middleware CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "online",
    users: connectedUsers.size,
    message: "Chat Server Running"
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
  pingTimeout: 20000,
  pingInterval: 10000,
  connectTimeout: 30000
});

// Diffuser les utilisateurs en ligne
const broadcastOnlineUsers = () => {
  try {
    const onlineUsers = Array.from(connectedUsers.keys());
    
    io.emit("active_users", {
      onlineUsers: onlineUsers,
      timestamp: Date.now(),
      total: onlineUsers.length
    });
    
    console.log(`📢 Diffusé: ${onlineUsers.length} utilisateurs en ligne`);
  } catch (error) {
    console.error("❌ Erreur broadcastOnlineUsers:", error);
  }
};

io.on("connection", (socket) => {
  console.log(`🔌 Nouvelle connexion: ${socket.id}`);

  // Enregistrement d'un utilisateur
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data;
      
      if (!deviceId) {
        socket.emit("register_error", "Device ID requis");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // Rechercher ou créer l'utilisateur
      const [existingUsers] = await connection.execute(
        "SELECT id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      
      if (existingUsers.length > 0) {
        // Utilisateur existant
        userId = existingUsers[0].id;
        await connection.execute(
          "UPDATE users SET last_seen = NOW() WHERE id = ?",
          [userId]
        );
      } else {
        // Nouvel utilisateur
        const [result] = await connection.execute(
          "INSERT INTO users (device_id) VALUES (?)",
          [deviceId]
        );
        userId = result.insertId;
      }
      
      connection.release();
      
      // Stocker les associations
      connectedUsers.set(userId.toString(), socket.id);
      userSockets.set(socket.id, {
        userId: userId.toString(),
        deviceId: deviceId
      });
      socket.userId = userId.toString();
      
      console.log(`✅ User ${userId} enregistré (${socket.id})`);
      
      // Confirmer l'enregistrement
      socket.emit("register_success", {
        userId,
        deviceId
      });
      
      // Envoyer la liste des utilisateurs après un court délai
      setTimeout(() => {
        emitUserList(socket);
      }, 500);
      
      // Diffuser la mise à jour des utilisateurs en ligne
      setTimeout(() => {
        broadcastOnlineUsers();
      }, 1000);
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", error.message);
    }
  });

  // Demande de la liste des utilisateurs
  socket.on("get_users", async () => {
    if (!socket.userId) return;
    await emitUserList(socket);
  });

  // Envoyer la liste des utilisateurs
  const emitUserList = async (socket) => {
    try {
      const connection = await pool.getConnection();
      const [users] = await connection.execute(
        "SELECT id, device_id FROM users WHERE id != ? ORDER BY last_seen DESC",
        [socket.userId]
      );
      
      connection.release();
      
      // Ajouter le statut en ligne
      const usersWithStatus = users.map(user => ({
        ...user,
        online: connectedUsers.has(user.id.toString())
      }));
      
      socket.emit("users_list", usersWithStatus);
      
      console.log(`📋 Liste utilisateurs envoyée à ${socket.userId}`);
      
    } catch (error) {
      console.error("❌ Erreur emitUserList:", error);
    }
  };

  // Envoi de message
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
      
      console.log(`📤 ${senderId} → ${receiverId}: "${message.substring(0, 30)}..."`);
      
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
        tempId
      };
      
      // Confirmer à l'expéditeur
      socket.emit("message_sent", messageData);
      console.log(`✅ Message ${result.insertId} sauvegardé`);
      
      // Envoyer au destinataire s'il est en ligne
      const receiverSocketId = connectedUsers.get(receiverId.toString());
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("receive_message", messageData);
        console.log(`📩 Message envoyé en temps réel à ${receiverId}`);
      }
      
    } catch (error) {
      console.error("❌ Erreur send_message:", error);
      socket.emit("message_error", {
        error: error.message,
        tempId: data.tempId
      });
    }
  });

  // Récupération des messages
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

  // Déconnexion
  socket.on("disconnect", () => {
    console.log(`🔴 Déconnexion: ${socket.id}`);
    
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      connectedUsers.delete(userInfo.userId);
      userSockets.delete(socket.id);
      
      // Diffuser la mise à jour
      setTimeout(() => {
        broadcastOnlineUsers();
      }, 500);
    }
  });
});

// Initialiser la base de données
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Table des utilisateurs
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_device_id (device_id),
        INDEX idx_last_seen (last_seen)
      )
    `);
    
    // Table des messages
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_conversation (sender_id, receiver_id, created_at),
        INDEX idx_created_at (created_at)
      )
    `);
    
    await connection.ping();
    connection.release();
    
    console.log("✅ Base de données initialisée");
    
  } catch (error) {
    console.error("❌ Erreur initialisation DB:", error);
  }
}

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  
  await initializeDatabase();
});