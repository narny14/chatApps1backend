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
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Stockage des connexions
const connectedUsers = new Map(); // userId -> socketId

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
    message: "Chat Server Ready",
    connectedUsers: connectedUsers.size
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
  pingInterval: 10000
});

// Diffuser les utilisateurs en ligne
const broadcastOnlineUsers = () => {
  try {
    const onlineUsers = Array.from(connectedUsers.keys());
    
    io.emit("active_users", {
      onlineUsers: onlineUsers,
      timestamp: Date.now()
    });
    
    console.log(`📢 ${onlineUsers.length} utilisateurs en ligne`);
  } catch (error) {
    console.error("❌ Erreur broadcastOnlineUsers:", error);
  }
};

io.on("connection", (socket) => {
  console.log(`🔌 Nouvelle connexion: ${socket.id}`);

  // ÉVÉNEMENT CORRECT : register_user
  socket.on("register_user", async (data) => {
    try {
      const { deviceId } = data;
      
      if (!deviceId) {
        socket.emit("registration_error", "Device ID requis");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // Chercher ou créer l'utilisateur
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
      
      // Stocker la connexion
      connectedUsers.set(userId.toString(), socket.id);
      socket.userId = userId.toString();
      
      console.log(`✅ User ${userId} enregistré`);
      
      // ÉVÉNEMENT CORRECT : registration_success
      socket.emit("registration_success", {
        userId,
        deviceId
      });
      
      // Envoyer la liste des utilisateurs
      setTimeout(async () => {
        await sendUserList(socket);
        broadcastOnlineUsers();
      }, 100);
      
    } catch (error) {
      console.error("❌ Erreur register_user:", error);
      socket.emit("registration_error", error.message);
    }
  });

  // Envoyer la liste des utilisateurs
  const sendUserList = async (socket) => {
    try {
      if (!socket.userId) return;
      
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
      console.log(`💬 ${senderId} → ${receiverId}: "${messageText.substring(0, 30)}..."`);
      
      const connection = await pool.getConnection();
      
      // Sauvegarder le message
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [senderId, receiverId, messageText]
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
      
      // Envoyer au destinataire en temps réel
      const receiverSocketId = connectedUsers.get(receiverId.toString());
      
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("new_message", messageData);
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

  // Récupérer une conversation
  socket.on("get_conversation", async (data) => {
    try {
      const { otherUserId, limit = 50 } = data;
      const userId = socket.userId;
      
      if (!userId) return;
      
      const connection = await pool.getConnection();
      const [messages] = await connection.execute(
        `SELECT m.* 
         FROM messages m
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
    }
  });

  // Déconnexion
  socket.on("disconnect", () => {
    console.log(`🔴 Déconnexion: ${socket.id}`);
    
    if (socket.userId) {
      connectedUsers.delete(socket.userId);
      
      // Mettre à jour la liste des utilisateurs en ligne
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
    
    // Table utilisateurs
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Table messages
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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