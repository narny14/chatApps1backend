const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

const pool = mysql.createPool({
  host: "centerbeam.proxy.rlwy.net",
  user: "root",
  password: "hcyWqBlfnvbihFsayzebffBaxXtNihBz",
  database: "railway",
  port: 44341,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: { rejectUnauthorized: false }
});

const userSockets = new Map();
const socketUsers = new Map();

// CORS simple
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "OK", online: userSockets.size });
});

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

io.on("connection", (socket) => {
  console.log(`🔌 Connecté: ${socket.id}`);

  // 1. ENREGISTREMENT
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data;
      
      if (!deviceId) {
        socket.emit("register_error", { error: "Device ID requis" });
        return;
      }

      console.log(`📱 Register: ${deviceId.substring(0, 20)}...`);

      const connection = await pool.getConnection();
      
      // Chercher ou créer l'utilisateur
      let [users] = await connection.execute(
        "SELECT id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      
      if (users.length > 0) {
        userId = users[0].id;
        await connection.execute(
          "UPDATE users SET online = 1, last_seen = NOW() WHERE id = ?",
          [userId]
        );
      } else {
        const [result] = await connection.execute(
          "INSERT INTO users (device_id, online) VALUES (?, 1)",
          [deviceId]
        );
        userId = result.insertId;
      }
      
      connection.release();

      // Stocker en mémoire
      socket.userId = userId;
      userSockets.set(userId, socket.id);
      socketUsers.set(socket.id, userId);

      console.log(`✅ User ${userId} enregistré (${socket.id})`);

      // Réponse au client
      socket.emit("registered", {
        success: true,
        userId: userId,
        deviceId: deviceId
      });

      // Mettre à jour tout le monde
      broadcastUsers();

    } catch (error) {
      console.error("❌ Register error:", error);
      socket.emit("register_error", { error: "Erreur serveur" });
    }
  });

  // 2. LISTE UTILISATEURS
  socket.on("get_users", async () => {
    try {
      if (!socket.userId) return;

      const connection = await pool.getConnection();
      const [users] = await connection.execute(
        `SELECT id, device_id, online, 
                DATE_FORMAT(last_seen, '%H:%i') as last_seen
         FROM users 
         WHERE id != ? 
         ORDER BY online DESC, last_seen DESC`,
        [socket.userId]
      );
      
      connection.release();

      // Marquer comme en ligne ceux qui ont une connexion socket
      const usersWithStatus = users.map(user => ({
        ...user,
        online: userSockets.has(user.id) || user.online === 1
      }));

      socket.emit("users", {
        success: true,
        users: usersWithStatus
      });

    } catch (error) {
      console.error("❌ Get users error:", error);
    }
  });

  // 3. ENVOYER MESSAGE
  socket.on("send_message", async (data) => {
    try {
      const { to, text } = data;
      const from = socket.userId;
      
      if (!from || !to || !text) {
        socket.emit("message_error", { error: "Données invalides" });
        return;
      }

      console.log(`💬 ${from} → ${to}: ${text.substring(0, 30)}...`);

      const connection = await pool.getConnection();
      
      // Insérer en base
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
        created_at: message.created_at
      };

      console.log(`📊 Message ${message.id} sauvegardé`);

      // 1. Confirmer à l'expéditeur
      socket.emit("message_sent", {
        success: true,
        message: formattedMessage
      });

      // 2. Envoyer au destinataire SI connecté
      const receiverSocketId = userSockets.get(parseInt(to));
      
      if (receiverSocketId) {
        console.log(`📤 Envoi réel à ${to} (${receiverSocketId})`);
        
        io.to(receiverSocketId).emit("new_message", {
          success: true,
          message: formattedMessage
        });
      }

    } catch (error) {
      console.error("❌ Send message error:", error);
      socket.emit("message_error", { error: "Erreur envoi" });
    }
  });

  // 4. CHARGER HISTORIQUE
  socket.on("get_messages", async (data) => {
    try {
      const { with: otherUserId } = data;
      const userId = socket.userId;
      
      if (!userId || !otherUserId) return;

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
         LIMIT 50`,
        [userId, otherUserId, otherUserId, userId]
      );
      
      connection.release();

      console.log(`📜 Historique: ${messages.length} messages entre ${userId} et ${otherUserId}`);

      socket.emit("messages", {
        success: true,
        with: otherUserId,
        messages: messages
      });

    } catch (error) {
      console.error("❌ Get messages error:", error);
    }
  });

  // DÉCONNEXION
  socket.on("disconnect", async () => {
    console.log(`🔴 Déconnecté: ${socket.id}`);
    
    const userId = socketUsers.get(socket.id);
    
    if (userId) {
      try {
        const connection = await pool.getConnection();
        await connection.execute(
          "UPDATE users SET online = 0 WHERE id = ?",
          [userId]
        );
        connection.release();
      } catch (error) {
        console.error("❌ Update disconnect error:", error);
      }
      
      userSockets.delete(userId);
      socketUsers.delete(socket.id);
      
      broadcastUsers();
    }
  });
});

// Diffuser la liste des utilisateurs à tout le monde
async function broadcastUsers() {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.execute(
      "SELECT id, online FROM users"
    );
    connection.release();

    const onlineUsers = Array.from(userSockets.keys());
    
    io.emit("online_users_update", {
      onlineUsers: onlineUsers,
      count: onlineUsers.length
    });

  } catch (error) {
    console.error("❌ Broadcast error:", error);
  }
}

// Vérifier la base de données
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
    
    connection.release();
    console.log("✅ Base de données OK");
    
  } catch (error) {
    console.error("❌ DB init error:", error);
  }
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur sur port ${PORT}`);
  console.log(`🔗 https://chatapps1backend.onrender.com`);
  initDB();
});