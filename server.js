const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

// Configuration DB simple
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "chat_app",
  waitForConnections: true,
  connectionLimit: 10
});

// Stockage en mémoire (simplifié)
const onlineUsers = {}; // { socketId: userId }
const userSockets = {}; // { userId: socketId }

app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ Chat Server OK");
});

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"]
});

// Événements Socket.IO
io.on("connection", (socket) => {
  console.log(`🔌 Nouveau client: ${socket.id}`);

  // 1. ENREGISTREMENT
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data;
      console.log(`📱 Tentative d'enregistrement: ${deviceId}`);

      const connection = await pool.getConnection();
      
      // Chercher ou créer l'utilisateur
      const [users] = await connection.execute(
        "SELECT id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      
      if (users.length > 0) {
        userId = users[0].id;
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
      
      // Stocker les connexions
      onlineUsers[socket.id] = userId;
      userSockets[userId] = socket.id;
      socket.userId = userId;
      
      console.log(`✅ User ${userId} enregistré (socket: ${socket.id})`);
      
      // Répondre au client
      socket.emit("registered", { 
        userId, 
        deviceId 
      });
      
      // Envoyer la liste des utilisateurs après un court délai
      setTimeout(() => {
        broadcastUserList();
      }, 300);
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", error.message);
    }
  });

  // 2. DEMANDER LA LISTE DES UTILISATEURS
  socket.on("get_users", async () => {
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
        online: userSockets[user.id] ? true : false
      }));
      
      socket.emit("users", usersWithStatus);
      
    } catch (error) {
      console.error("❌ Erreur get_users:", error);
    }
  });

  // 3. ENVOYER UN MESSAGE (SIMPLIFIÉ)
  socket.on("send_message", async (data) => {
    try {
      const { to, text } = data;
      const from = socket.userId;
      
      if (!from || !to || !text) {
        socket.emit("message_error", "Données manquantes");
        return;
      }
      
      console.log(`💬 ${from} → ${to}: ${text.substring(0, 30)}`);
      
      // Sauvegarder en DB
      const connection = await pool.getConnection();
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [from, to, text]
      );
      
      // Récupérer le message complet
      const [messages] = await connection.execute(
        "SELECT * FROM messages WHERE id = ?",
        [result.insertId]
      );
      connection.release();
      
      const message = messages[0];
      
      // 1. Confirmer à l'expéditeur
      socket.emit("message_sent", {
        ...message,
        sent: true
      });
      
      // 2. Envoyer au destinataire EN TEMPS RÉEL
      const receiverSocketId = userSockets[to];
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("new_message", {
          ...message,
          incoming: true
        });
        console.log(`📩 Message envoyé en temps réel à ${to}`);
      } else {
        console.log(`⚠️ Destinataire ${to} hors ligne`);
      }
      
    } catch (error) {
      console.error("❌ Erreur send_message:", error);
      socket.emit("message_error", error.message);
    }
  });

  // 4. CHARGER LES MESSAGES
  socket.on("get_messages", async (data) => {
    try {
      const { with: otherUserId } = data;
      const userId = socket.userId;
      
      if (!userId || !otherUserId) return;
      
      const connection = await pool.getConnection();
      const [messages] = await connection.execute(
        `SELECT * FROM messages 
         WHERE (sender_id = ? AND receiver_id = ?) 
         OR (sender_id = ? AND receiver_id = ?) 
         ORDER BY created_at ASC`,
        [userId, otherUserId, otherUserId, userId]
      );
      connection.release();
      
      socket.emit("messages", {
        with: otherUserId,
        messages
      });
      
    } catch (error) {
      console.error("❌ Erreur get_messages:", error);
    }
  });

  // 5. DÉCONNEXION
  socket.on("disconnect", () => {
    console.log(`🔴 Déconnexion: ${socket.id}`);
    
    if (socket.userId) {
      delete userSockets[socket.userId];
      delete onlineUsers[socket.id];
      
      // Mettre à jour la liste
      setTimeout(() => {
        broadcastUserList();
      }, 500);
    }
  });
});

// Diffuser la liste des utilisateurs
function broadcastUserList() {
  const onlineUserIds = Object.values(userSockets).map(socketId => onlineUsers[socketId]);
  
  io.emit("online_users", {
    users: onlineUserIds,
    count: onlineUserIds.length
  });
  
  // Envoyer aussi à chaque socket individuellement
  io.emit("users_updated");
}

// Initialiser la DB
async function initDB() {
  try {
    const connection = await pool.getConnection();
    
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    connection.release();
    console.log("✅ Base de données prête");
    
  } catch (error) {
    console.error("❌ Erreur DB:", error);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur sur port ${PORT}`);
  initDB();
});