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

// Middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});
app.use(express.json());

// Routes
app.get("/", (req, res) => res.send("✅ Chat Server Ready"));

// Créer les tables CORRECTES
app.get("/setup", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Supprimer les anciennes tables si elles existent
    await connection.execute("DROP TABLE IF EXISTS messages");
    await connection.execute("DROP TABLE IF EXISTS users");
    
    // Créer table users CORRECTE
    await connection.execute(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Créer table messages
    await connection.execute(`
      CREATE TABLE messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT,
        receiver_id INT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    connection.release();
    res.json({ success: true, message: "Tables créées avec succès" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SOCKET.IO
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  transports: ["websocket", "polling"]
});

const activeUsers = new Map();

io.on("connection", (socket) => {
  console.log(`🟢 Client connecté: ${socket.id}`);

  // ENREGISTREMENT
  socket.on("register", async (data) => {
    try {
      const { deviceId } = data;
      
      if (!deviceId) {
        socket.emit("register_error", "Device ID requis");
        return;
      }
      
      const connection = await pool.getConnection();
      
      // Vérifier si l'utilisateur existe déjà
      const [existing] = await connection.execute(
        "SELECT id FROM users WHERE device_id = ?",
        [deviceId]
      );
      
      let userId;
      if (existing.length > 0) {
        userId = existing[0].id;
        // Mettre à jour last_seen
        await connection.execute(
          "UPDATE users SET last_seen = NOW() WHERE id = ?",
          [userId]
        );
      } else {
        // Créer nouvel utilisateur
        const [result] = await connection.execute(
          "INSERT INTO users (device_id) VALUES (?)",
          [deviceId]
        );
        userId = result.insertId;
      }
      
      connection.release();
      
      // Stocker en mémoire
      activeUsers.set(socket.id, { userId, deviceId });
      
      // Répondre au client
      socket.emit("register_success", { 
        userId, 
        deviceId 
      });
      
      // Envoyer la liste des autres utilisateurs
      sendUserList(socket, userId);
      
      console.log(`✅ User ${userId} enregistré (${deviceId.substring(0, 20)}...)`);
      
    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("register_error", error.message);
    }
  });

  // ENVOYER MESSAGE
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
      
      // Insérer le message
      const [result] = await connection.execute(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
        [sender.userId, receiverId, message.trim()]
      );
      
      connection.release();
      
      // Créer l'objet message
      const messageData = {
        id: result.insertId,
        sender_id: sender.userId,
        receiver_id: receiverId,
        message: message.trim(),
        created_at: new Date().toISOString()
      };
      
      // Confirmer à l'expéditeur
      socket.emit("message_sent", messageData);
      
      // Envoyer au destinataire s'il est connecté
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

  // DEMANDER LISTE UTILISATEURS
  socket.on("get_users", async () => {
    try {
      const sender = activeUsers.get(socket.id);
      if (!sender) return;
      
      await sendUserList(socket, sender.userId);
    } catch (error) {
      console.error("❌ Erreur get_users:", error);
    }
  });

  // DEMANDER MESSAGES
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
         ORDER BY created_at ASC`,
        [sender.userId, otherUserId, otherUserId, sender.userId]
      );
      
      connection.release();
      
      socket.emit("messages_list", {
        userId: sender.userId,
        otherUserId,
        messages
      });
      
    } catch (error) {
      console.error("❌ Erreur get_messages:", error);
    }
  });

  // DÉCONNEXION
  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      console.log(`🔴 Déconnexion: User ${user.userId}`);
      activeUsers.delete(socket.id);
      broadcastActiveUsers();
    }
  });
});

// FONCTIONS UTILITAIRES
async function sendUserList(socket, currentUserId) {
  try {
    const connection = await pool.getConnection();
    const [users] = await connection.execute(
      "SELECT id, device_id, created_at FROM users WHERE id != ? ORDER BY last_seen DESC",
      [currentUserId]
    );
    
    connection.release();
    
    // Ajouter le statut en ligne
    const usersWithStatus = users.map(user => ({
      ...user,
      online: Array.from(activeUsers.values()).some(u => u.userId === user.id)
    }));
    
    socket.emit("users_list", usersWithStatus);
  } catch (error) {
    console.error("❌ Erreur sendUserList:", error);
  }
}

function findSocketByUserId(userId) {
  for (const [socketId, user] of activeUsers.entries()) {
    if (user.userId === userId) return socketId;
  }
  return null;
}

function broadcastActiveUsers() {
  const onlineUsers = Array.from(activeUsers.values()).map(u => ({
    id: u.userId,
    deviceId: u.deviceId,
    online: true
  }));
  
  io.emit("active_users", onlineUsers);
}

// DÉMARRAGE
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 Serveur sur port ${PORT}`);
  
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log("✅ Base de données connectée");
  } catch (error) {
    console.error("❌ Erreur DB:", error.message);
  }
});