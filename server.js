const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

// Configuration DB Railway
const pool = mysql.createPool({
  host: process.env.DB_HOST || "centerbeam.proxy.rlwy.net",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "hcyWqBlfnvbihFsayzebffBaxXtNihBz",
  database: process.env.DB_NAME || "railway",
  port: process.env.DB_PORT || 44341,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: false // Important pour Railway
  }
});

// Stockage en mémoire
const userSockets = new Map(); // { userId: socketId }
const socketUsers = new Map(); // { socketId: userId }

// Middleware CORS pour production
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://chatapps1backend.onrender.com',
    'exp://*',
    'http://localhost:*',
    'http://192.168.*:*',
    'http://10.0.*:*'
  ];
  
  const origin = req.headers.origin;
  if (allowedOrigins.some(allowed => {
    if (origin) {
      return origin.includes(allowed.replace('*', '')) || 
             allowed === '*' || 
             origin === allowed;
    }
    return true;
  })) {
    res.header("Access-Control-Allow-Origin", origin || "*");
  }
  
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.header("Access-Control-Allow-Credentials", "true");
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

app.use(express.json());

// Route de santé
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "Chat Server Running on Render",
    url: "https://chatapps1backend.onrender.com",
    database: process.env.DB_NAME || "railway",
    timestamp: new Date().toISOString(),
    onlineUsers: userSockets.size
  });
});

// API de santé
app.get("/health", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    
    res.json({
      status: "healthy",
      server: "https://chatapps1backend.onrender.com",
      database: "connected",
      onlineUsers: userSockets.size,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      timestamp: Date.now()
    });
  }
});

// API REST pour messages (fallback)
app.get("/api/messages/:userId/:otherUserId", async (req, res) => {
  try {
    const { userId, otherUserId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const connection = await pool.getConnection();
    const [messages] = await connection.execute(
      `SELECT m.*, 
              u1.device_id as sender_device_id,
              u2.device_id as receiver_device_id
       FROM messages m
       LEFT JOIN users u1 ON m.sender_id = u1.id
       LEFT JOIN users u2 ON m.receiver_id = u2.id
       WHERE (m.sender_id = ? AND m.receiver_id = ?) 
          OR (m.sender_id = ? AND m.receiver_id = ?)
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [userId, otherUserId, otherUserId, userId, limit]
    );
    
    connection.release();
    
    res.json({
      success: true,
      messages: messages.reverse(),
      count: messages.length,
      server: "https://chatapps1backend.onrender.com"
    });
    
  } catch (error) {
    console.error("❌ Erreur API messages:", error);
    res.status(500).json({ 
      error: error.message,
      server: "https://chatapps1backend.onrender.com"
    });
  }
});

// Configuration Socket.IO pour production
const io = new Server(server, {
  cors: {
    origin: [
      "https://chatapps1backend.onrender.com",
      "exp://*",
      "http://localhost:*",
      "http://192.168.*:*",
      "http://10.0.*:*"
    ],
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
  allowEIO3: true,
  path: "/socket.io/"
});

// Gestion des connexions Socket.IO
io.on("connection", (socket) => {
  console.log(`🔌 Nouvelle connexion: ${socket.id} depuis ${socket.handshake.address}`);
  
  // Ping/pong pour garder la connexion active sur Render
  socket.on("ping", (data) => {
    socket.emit("pong", { 
      ...data, 
      timestamp: Date.now(),
      server: "https://chatapps1backend.onrender.com"
    });
  });

  // 1. ENREGISTREMENT DE L'UTILISATEUR
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data;
      
      if (!deviceId) {
        socket.emit("register_error", { 
          error: "deviceId est requis",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }

      console.log(`📱 Enregistrement pour device: ${deviceId.substring(0, 20)}...`);

      const connection = await pool.getConnection();
      
      let [users] = await connection.execute(
        "SELECT id, device_id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      let userData;
      
      if (users.length > 0) {
        userId = users[0].id;
        userData = users[0];
        
        await connection.execute(
          "UPDATE users SET last_seen = NOW(), online = 1 WHERE id = ?",
          [userId]
        );
      } else {
        const [result] = await connection.execute(
          "INSERT INTO users (device_id, online) VALUES (?, 1)",
          [deviceId]
        );
        userId = result.insertId;
        
        [users] = await connection.execute(
          "SELECT id, device_id FROM users WHERE id = ?",
          [userId]
        );
        userData = users[0];
      }
      
      connection.release();

      // Associer l'utilisateur au socket
      socket.userId = userId;
      userSockets.set(userId, socket.id);
      socketUsers.set(socket.id, userId);

      // Joindre une room pour l'utilisateur
      socket.join(`user:${userId}`);
      
      console.log(`✅ Utilisateur ${userId} enregistré sur Render (socket: ${socket.id})`);

      // Envoyer confirmation
      socket.emit("registered", {
        success: true,
        userId,
        deviceId: userData.device_id,
        server: "https://chatapps1backend.onrender.com",
        timestamp: Date.now()
      });

      // Diffuser la mise à jour
      broadcastOnlineUsers();
      sendUsersList(socket);

    } catch (error) {
      console.error("❌ Erreur d'enregistrement:", error);
      socket.emit("register_error", { 
        error: "Erreur serveur",
        details: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // 2. DEMANDER LA LISTE DES UTILISATEURS
  socket.on("get_users", async () => {
    try {
      if (!socket.userId) {
        socket.emit("users_error", { 
          error: "Utilisateur non authentifié",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }
      
      sendUsersList(socket);
      
    } catch (error) {
      console.error("❌ Erreur get_users:", error);
      socket.emit("users_error", { 
        error: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // 3. ENVOYER UN MESSAGE
  socket.on("send_message", async (data) => {
    try {
      const { to, text } = data;
      const from = socket.userId;
      
      // Validation
      if (!from || !to || !text || text.trim() === "") {
        socket.emit("message_error", { 
          error: "Données manquantes ou invalides",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }
      
      if (from.toString() === to.toString()) {
        socket.emit("message_error", { 
          error: "Impossible de s'envoyer un message à soi-même",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }

      console.log(`💬 ${from} → ${to}: ${text.substring(0, 50)}...`);

      // Sauvegarder en base
      const connection = await pool.getConnection();
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [from, to, text.trim()]
      );
      
      // Récupérer le message complet
      const [messages] = await connection.execute(
        `SELECT m.*, 
                u1.device_id as sender_device_id,
                u2.device_id as receiver_device_id
         FROM messages m
         LEFT JOIN users u1 ON m.sender_id = u1.id
         LEFT JOIN users u2 ON m.receiver_id = u2.id
         WHERE m.id = ?`,
        [result.insertId]
      );
      
      connection.release();
      
      const message = messages[0];
      const formattedMessage = {
        id: message.id,
        sender_id: parseInt(message.sender_id),
        receiver_id: parseInt(message.receiver_id),
        message: message.message,
        created_at: message.created_at,
        sender_device_id: message.sender_device_id,
        receiver_device_id: message.receiver_device_id,
        server: "https://chatapps1backend.onrender.com"
      };

      console.log(`📊 Message ${message.id} sauvegardé sur Railway`);

      // 1. Confirmer à l'expéditeur
      socket.emit("message_sent", {
        success: true,
        message: formattedMessage,
        timestamp: Date.now(),
        server: "https://chatapps1backend.onrender.com"
      });

      // 2. Envoyer au destinataire
      const receiverSocketId = userSockets.get(parseInt(to));
      
      if (receiverSocketId) {
        console.log(`📤 Envoi en temps réel à ${to} (socket: ${receiverSocketId})`);
        
        io.to(receiverSocketId).emit("new_message", {
          success: true,
          message: formattedMessage,
          type: "incoming",
          timestamp: Date.now(),
          server: "https://chatapps1backend.onrender.com"
        });
      } else {
        console.log(`📭 Destinataire ${to} hors ligne - Message sauvegardé`);
      }

    } catch (error) {
      console.error("❌ Erreur send_message:", error);
      socket.emit("message_error", { 
        error: "Erreur d'envoi du message",
        details: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // 4. CHARGER L'HISTORIQUE
  socket.on("get_messages", async (data) => {
    try {
      const { with: otherUserId, limit = 50 } = data;
      const userId = socket.userId;
      
      if (!userId || !otherUserId) {
        socket.emit("messages_error", { 
          error: "Paramètres manquants",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }
      
      const connection = await pool.getConnection();
      const [messages] = await connection.execute(
        `SELECT m.*, 
                u1.device_id as sender_device_id,
                u2.device_id as receiver_device_id
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
      
      socket.emit("messages", {
        success: true,
        with: otherUserId,
        messages: messages,
        count: messages.length,
        server: "https://chatapps1backend.onrender.com"
      });
      
      console.log(`📜 Historique chargé depuis Railway: ${messages.length} messages entre ${userId} et ${otherUserId}`);
      
    } catch (error) {
      console.error("❌ Erreur get_messages:", error);
      socket.emit("messages_error", { 
        error: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // 5. HEARTBEAT
  socket.on("heartbeat", () => {
    if (socket.userId) {
      socket.emit("heartbeat_response", {
        timestamp: Date.now(),
        userId: socket.userId,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // 6. DÉCONNEXION
  socket.on("disconnect", async () => {
    console.log(`🔴 Déconnexion: ${socket.id}`);
    
    const userId = socketUsers.get(socket.id);
    
    if (userId) {
      try {
        const connection = await pool.getConnection();
        await connection.execute(
          "UPDATE users SET online = 0, last_seen = NOW() WHERE id = ?",
          [userId]
        );
        connection.release();
      } catch (error) {
        console.error("❌ Erreur mise à jour déconnexion:", error);
      }
      
      userSockets.delete(userId);
      socketUsers.delete(socket.id);
      
      broadcastOnlineUsers();
      console.log(`👤 Utilisateur ${userId} déconnecté de Render`);
    }
  });
});

// Fonction pour envoyer la liste des utilisateurs
async function sendUsersList(socket) {
  try {
    const connection = await pool.getConnection();
    
    const [users] = await connection.execute(
      `SELECT id, device_id, online, 
              DATE_FORMAT(last_seen, '%Y-%m-%d %H:%i:%s') as last_seen
       FROM users 
       WHERE id != ? 
       ORDER BY online DESC, last_seen DESC`,
      [socket.userId]
    );
    
    connection.release();
    
    const usersWithStatus = users.map(user => ({
      ...user,
      online: userSockets.has(user.id) || user.online === 1
    }));
    
    socket.emit("users", {
      success: true,
      users: usersWithStatus,
      count: usersWithStatus.length,
      server: "https://chatapps1backend.onrender.com",
      timestamp: Date.now()
    });
    
  } catch (error) {
    console.error("❌ Erreur sendUsersList:", error);
    socket.emit("users_error", { 
      error: error.message,
      server: "https://chatapps1backend.onrender.com"
    });
  }
}

// Fonction pour diffuser les utilisateurs en ligne
function broadcastOnlineUsers() {
  const onlineUsers = Array.from(userSockets.keys());
  
  io.emit("online_users_update", {
    onlineUsers,
    count: onlineUsers.length,
    timestamp: Date.now(),
    server: "https://chatapps1backend.onrender.com"
  });
}

// Initialiser la base de données
async function initDB() {
  try {
    const connection = await pool.getConnection();
    
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
    
    connection.release();
    console.log("✅ Base de données Railway initialisée avec succès");
    
  } catch (error) {
    console.error("❌ Erreur d'initialisation DB Railway:", error);
  }
}

// Gestion des erreurs
process.on("uncaughtException", (error) => {
  console.error("⚠️ Exception non capturée:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️ Rejet non géré:", reason);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur Render, port ${PORT}`);
  console.log(`🔗 URL HTTPS: https://chatapps1backend.onrender.com`);
  console.log(`📡 URL WebSocket: wss://chatapps1backend.onrender.com`);
  console.log(`🗄️  Database: ${process.env.DB_HOST}:${process.env.DB_PORT}`);
  initDB();
});