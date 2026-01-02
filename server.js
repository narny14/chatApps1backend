const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./db");
const User = require("./models/User");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());

// 🔹 Route test
app.get("/", (req, res) => {
  res.send("✅ Backend chat fonctionne (Render)");
});

// 🔹 Route pour voir les utilisateurs connectés et leurs rooms
app.get("/socket-debug", (req, res) => {
  const rooms = {};
  const connectedUsers = [];
  
  // Parcourir toutes les sockets connectées
  io.sockets.sockets.forEach(socket => {
    connectedUsers.push({
      id: socket.id,
      userId: socket.userId || "non enregistré",
      deviceId: socket.deviceId || "inconnu",
      rooms: Array.from(socket.rooms)
    });
    
    // Compter par room
    socket.rooms.forEach(room => {
      if (!rooms[room]) rooms[room] = 0;
      rooms[room]++;
    });
  });
  
  res.json({
    totalSockets: io.sockets.sockets.size,
    rooms: rooms,
    connectedUsers: connectedUsers,
    timestamp: new Date().toISOString()
  });
});

// 🔹 Route pour tester la connexion DB
app.get("/test-db", (req, res) => {
  console.log("🔍 Test DB - Variables d'environnement :", {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_NAME: process.env.DB_NAME,
    DB_PASSWORD_SET: !!process.env.DB_PASSWORD
  });

  const mysql = require("mysql2");
  
  const testConnection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 10000,
    debug: false
  });

  testConnection.connect((err) => {
    if (err) {
      console.error("❌ ERREUR CONNEXION COMPLÈTE :", {
        code: err.code,
        message: err.message,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT
      });
      
      return res.status(500).json({
        error: "Connexion refusée",
        details: {
          code: err.code,
          message: err.message,
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          attemptedAt: new Date().toISOString()
        }
      });
    }
    
    console.log("✅ CONNEXION RÉUSSIE !");
    testConnection.end();
    
    res.json({
      success: true,
      message: "Connexion à la base de données réussie",
      database: process.env.DB_NAME,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      timestamp: new Date().toISOString()
    });
  });
});

// 🔹 Routes REST
app.use("/messages", require("./routes/messages"));
app.use("/users", require("./routes/users"));

// 🔹 Route de santé
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "chatapps1backend"
  });
});

// 🔹 Route de debug environnement
app.get("/debug-env", (req, res) => {
  res.json({
    DB_HOST: process.env.DB_HOST || "NON DÉFINI",
    DB_PORT: process.env.DB_PORT || "NON DÉFINI", 
    DB_USER: process.env.DB_USER || "NON DÉFINI",
    DB_NAME: process.env.DB_NAME || "NON DÉFINI",
    DB_PASSWORD_SET: !!process.env.DB_PASSWORD,
    PORT: process.env.PORT || "NON DÉFINI",
    NODE_ENV: process.env.NODE_ENV || "NON DÉFINI"
  });
});

// 🔹 Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true
  }
});

io.on("connection", (socket) => {
  console.log("🟢 Nouvelle connexion Socket.IO:", socket.id);

  // ========== ENREGISTREMENT DU DEVICE ==========
  socket.on("registerDevice", async (deviceData) => {
    try {
      const { device_id } = deviceData;
      
      if (!device_id) {
        socket.emit("registrationError", { error: "device_id requis" });
        return;
      }

      const user = await User.findOrCreate(deviceData);
      
      console.log(`📱 Téléphone ${device_id.substring(0, 20)}... -> User ID: ${user.id}`);
      
      // Stocker les infos dans la socket
      socket.userId = user.id;
      socket.deviceId = device_id;
      
      // Rejoindre la room PERSONNELLE
      socket.join(`user_${user.id}`);
      console.log(`   ✅ Rejoint room: user_${user.id}`);
      
      // Notifier le client
      socket.emit("registrationSuccess", {
        user_id: user.id,
        device_id: user.device_id,
        message: "Enregistrement réussi"
      });

      // Notifier les autres que cet utilisateur est en ligne
      socket.broadcast.emit("userOnline", {
        user_id: user.id,
        device_id: user.device_id
      });

    } catch (error) {
      console.error("❌ Erreur enregistrement:", error);
      socket.emit("registrationError", { error: error.message });
    }
  });

  // ========== REJOINDRE UNE CONVERSATION ==========
  socket.on("joinConversation", (data) => {
    if (!socket.userId) {
      console.warn("⚠️ Socket non enregistré, impossible de rejoindre conversation");
      socket.emit("conversationError", { error: "Utilisateur non enregistré" });
      return;
    }
    
    const { otherUserId } = data;
    
    if (!otherUserId || otherUserId === socket.userId) {
      socket.emit("conversationError", { error: "ID destinataire invalide" });
      return;
    }
    
    // Rejoindre la room de conversation BILATERALE
    const roomName = `conversation_${Math.min(socket.userId, otherUserId)}_${Math.max(socket.userId, otherUserId)}`;
    socket.join(roomName);
    console.log(`💬 User ${socket.userId} rejoint conversation avec ${otherUserId} (room: ${roomName})`);
    
    socket.emit("conversationJoined", {
      userId: socket.userId,
      otherUserId,
      roomName
    });
  });

  // ========== ENVOYER UN MESSAGE ==========
  socket.on("sendMessage", (data) => {
    const { sender_id, receiver_id, message } = data;

    console.log(`📩 Message reçu de ${sender_id} pour ${receiver_id}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);

    // Validation
    if (!sender_id || !receiver_id || !message || !message.trim()) {
      console.warn("❌ Message invalide:", data);
      socket.emit("messageError", { error: "Message invalide" });
      return;
    }

    // Vérifier que l'émetteur est bien connecté (si on a l'info)
    if (socket.userId && socket.userId !== sender_id) {
      console.warn(`⚠️ User ${socket.userId} tente d'envoyer comme ${sender_id}`);
      // On continue quand même pour la compatibilité
    }

    // Insérer dans la base de données
    db.query(
      "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
      [sender_id, receiver_id, message.trim()],
      (err, result) => {
        if (err) {
          console.error("❌ Erreur MySQL:", err);
          socket.emit("messageError", { 
            error: "Erreur base de données",
            details: err.message 
          });
          return;
        }

        console.log(`✅ Message ${result.insertId} enregistré en DB`);

        const messageData = {
          id: result.insertId,
          sender_id,
          receiver_id,
          message: message.trim(),
          created_at: new Date(),
          is_read: false
        };

        // 🔴 CRITIQUE: ENVOYER AU DESTINATAIRE
        // 1. Via sa room personnelle (garantie de réception)
        const recipientRoom = `user_${receiver_id}`;
        console.log(`📤 Envoi à ${recipientRoom}`);
        io.to(recipientRoom).emit("receiveMessage", messageData);
        
        // 2. Via la room de conversation (pour les deux participants)
        const conversationRoom = `conversation_${Math.min(sender_id, receiver_id)}_${Math.max(sender_id, receiver_id)}`;
        console.log(`📤 Envoi aussi à ${conversationRoom}`);
        io.to(conversationRoom).emit("receiveMessage", messageData);
        
        // 3. Confirmer à l'expéditeur
        socket.emit("messageSent", {
          message_id: result.insertId,
          ...messageData
        });

        // Log de debug
        const recipientRoomSize = Array.from(io.sockets.adapter.rooms.get(recipientRoom) || []).length;
        const conversationRoomSize = Array.from(io.sockets.adapter.rooms.get(conversationRoom) || []).length;
        
        console.log(`🔍 Rooms: ${recipientRoom}=${recipientRoomSize}, ${conversationRoom}=${conversationRoomSize}`);
      }
    );
  });

  // ========== RÉCUPÉRER L'HISTORIQUE ==========
  socket.on("getConversation", (data) => {
    const { user1, user2, limit = 50 } = data;
    
    if (!user1 || !user2) {
      socket.emit("conversationError", { error: "IDs utilisateurs manquants" });
      return;
    }
    
    console.log(`📜 Demande historique ${user1} <-> ${user2}, limit: ${limit}`);
    
    db.query(
      `SELECT m.*, 
              u1.device_id as sender_device_id,
              u2.device_id as receiver_device_id
       FROM messages m
       LEFT JOIN users u1 ON m.sender_id = u1.id
       LEFT JOIN users u2 ON m.receiver_id = u2.id
       WHERE (sender_id = ? AND receiver_id = ?) 
          OR (sender_id = ? AND receiver_id = ?)
       ORDER BY m.created_at DESC 
       LIMIT ?`,
      [user1, user2, user2, user1, parseInt(limit)],
      (err, results) => {
        if (err) {
          console.error("❌ Erreur récupération conversation:", err);
          socket.emit("conversationError", { error: err.message });
          return;
        }
        
        // Inverser l'ordre pour avoir du plus ancien au plus récent
        const messages = results.reverse();
        
        console.log(`✅ Historique envoyé: ${messages.length} messages`);
        
        socket.emit("conversationHistory", {
          user1,
          user2,
          messages
        });
      }
    );
  });

  // ========== ANCIENNE MÉTHODE (pour compatibilité) ==========
  socket.on("join", (userId) => {
    // Pour compatibilité avec l'ancien code
    socket.join(userId.toString());
    console.log("➡️ User rejoint room (ancienne méthode):", userId);
  });

  // ========== DÉCONNEXION ==========
  socket.on("disconnect", (reason) => {
    console.log(`🔴 Déconnexion: ${socket.id} (user: ${socket.userId || 'inconnu'}) - ${reason}`);
    
    if (socket.userId) {
      // Notifier que l'utilisateur est hors ligne
      socket.broadcast.emit("userOffline", {
        user_id: socket.userId,
        device_id: socket.deviceId
      });
    }
  });

  // ========== PING/PONG ==========
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: new Date().toISOString() });
  });
});

// Middleware de logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// Log de démarrage
console.log("🔍 Configuration DB chargée :", {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER
});

// 🔴 PORT RENDER OBLIGATOIRE
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Backend lancé sur le port ${PORT}`);
  console.log(`📊 Base de données: ${process.env.DB_NAME} sur ${process.env.DB_HOST}:${process.env.DB_PORT}`);
  console.log(`🔌 Socket.IO prêt sur /socket.io/`);
});