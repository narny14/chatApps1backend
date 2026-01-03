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

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

app.get("/", (req, res) => res.send("✅ Chat Server Ready"));

app.get("/setup", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    connection.release();
    res.json({ success: true, message: "Tables créées" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🔥 STOCKAGE CRITIQUE : userId -> socket.id
const userToSocket = new Map();
const socketToUser = new Map();

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
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
      
      // 🔥 CRITIQUE : Associer userId et socket
      userToSocket.set(userId, socket.id);
      socketToUser.set(socket.id, userId);
      socket.userId = userId;
      
      console.log(`✅ User ${userId} ↔ Socket ${socket.id}`);
      
      // Répondre
      socket.emit("register_success", { userId, deviceId });
      
      // Envoyer la liste des utilisateurs
      broadcastUserList();
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", error.message);
    }
  });

  // 🔥 ENVOYER MESSAGE - CORRECTION CRITIQUE
  socket.on("send_message", async (data) => {
    try {
      const { receiverId, message } = data;
      const senderId = socket.userId;
      
      if (!senderId) {
        console.log("❌ Erreur: sender non enregistré");
        socket.emit("message_error", "Non enregistré");
        return;
      }
      
      if (!receiverId || !message?.trim()) {
        console.log("❌ Erreur: données invalides");
        socket.emit("message_error", "Données invalides");
        return;
      }
      
      console.log(`📤 ${senderId} → ${receiverId}: "${message.substring(0, 50)}..."`);
      
      const connection = await pool.getConnection();
      
      // Sauvegarder le message
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [senderId, receiverId, message.trim()]
      );
      
      connection.release();
      
      // Créer l'objet message
      const messageData = {
        id: result.insertId,
        sender_id: senderId,
        receiver_id: receiverId,
        message: message.trim(),
        created_at: new Date().toISOString()
      };
      
      // 1. Confirmer à l'expéditeur IMMÉDIATEMENT
      socket.emit("message_sent", messageData);
      console.log(`✅ Message ${result.insertId} sauvegardé`);
      
      // 2. 🔥 ENVOYER AU DESTINATAIRE EN TEMPS RÉEL
      const receiverSocketId = userToSocket.get(parseInt(receiverId));
      console.log(`🔍 Destinataire ${receiverId} → socket: ${receiverSocketId || 'non trouvé'}`);
      
      if (receiverSocketId) {
        // Vérifier si le socket existe toujours
        const receiverSocket = io.sockets.sockets.get(receiverSocketId);
        if (receiverSocket) {
          receiverSocket.emit("receive_message", messageData);
          console.log(`📩 Message envoyé en temps réel à ${receiverId}`);
        } else {
          console.log(`⚠️ Socket ${receiverSocketId} trouvé mais déconnecté`);
          userToSocket.delete(parseInt(receiverId));
          socketToUser.delete(receiverSocketId);
        }
      } else {
        console.log(`⚠️ Destinataire ${receiverId} hors ligne (pas de socket)`);
      }
      
    } catch (error) {
      console.error("❌ Erreur message:", error);
      socket.emit("message_error", error.message);
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
      
      // Ajouter statut en ligne
      const usersWithStatus = users.map(user => ({
        ...user,
        online: userToSocket.has(user.id)
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

  // PING
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now(), message: "pong from server" });
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    console.log(`🔴 Déconnexion: socket ${socket.id}`);
    
    if (socket.userId) {
      userToSocket.delete(socket.userId);
      socketToUser.delete(socket.id);
      broadcastUserList();
    }
  });
});

// 🔥 FONCTION POUR DIFFUSER LA LISTE
function broadcastUserList() {
  const onlineUsers = Array.from(userToSocket.keys());
  io.emit("active_users", onlineUsers);
}

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