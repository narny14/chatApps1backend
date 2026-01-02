const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./db");
const User = require("./models/User"); // ⬅️ IMPORT AJOUTÉ

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());

// 🔹 Route test
app.get("/", (req, res) => {
  res.send("✅ Backend chat fonctionne (Render)");
});

// 🔹 Route pour tester la connexion DB (SÉCURISÉE)
app.get("/test-db", (req, res) => {
  console.log("🔍 Test DB - Variables d'environnement :", {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_NAME: process.env.DB_NAME,
    DB_PASSWORD_SET: !!process.env.DB_PASSWORD // ⬅️ CORRIGÉ : ne pas afficher le mot de passe
  });

  // Test de connexion directe
  const mysql = require("mysql2");
  
  const testConnection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 10000,
    debug: false // ⬅️ Désactivé en production
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
app.use("/users", require("./routes/users")); // ⬅️ DÉPLACÉ ICI

// 🔹 Route de santé
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "chatapps1backend"
  });
});

// 🔹 Route de debug (sécurisée)
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
  }
});

io.on("connection", (socket) => {
  console.log("🟢 Nouvelle connexion Socket.IO:", socket.id);

  // ⬇️⬇️⬇️ NOUVEAU CODE POUR L'ENREGISTREMENT AUTOMATIQUE ⬇️⬇️⬇️
  socket.on("registerDevice", async (deviceData) => {
    try {
      const { device_id } = deviceData;
      
      if (!device_id) {
        socket.emit("registrationError", { error: "device_id requis" });
        return;
      }

      // Trouver ou créer l'utilisateur
      const user = await User.findOrCreate(deviceData);
      
      console.log(`📱 Téléphone enregistré: ${device_id} -> User ID: ${user.id}`);
      
      // Enregistrer l'ID socket avec l'ID utilisateur
      socket.userId = user.id;
      socket.deviceId = device_id;
      
      // Rejoindre la room personnelle
      socket.join(`user_${user.id}`);
      
      // Confirmer l'enregistrement au client
      socket.emit("registrationSuccess", {
        user_id: user.id,
        device_id: user.device_id,
        message: "Enregistrement réussi"
      });

      // Notifier que l'utilisateur est en ligne
      socket.broadcast.emit("userOnline", {
        user_id: user.id,
        device_id: user.device_id
      });

    } catch (error) {
      console.error("❌ Erreur enregistrement device:", error);
      socket.emit("registrationError", { error: error.message });
    }
  });

  // Ancien 'join' pour compatibilité
  socket.on("join", (userId) => {
    socket.join(userId.toString());
    console.log("➡️ User rejoint la room (ancienne méthode):", userId);
  });

  // Rejoindre une conversation
  socket.on("joinConversation", (data) => {
    const { userId, otherUserId } = data;
    
    if (socket.userId != userId) {
      console.warn("⚠️ Tentative de join avec mauvais userId");
      return;
    }
    
    // Rejoindre la room de conversation
    const roomName = `conversation_${Math.min(userId, otherUserId)}_${Math.max(userId, otherUserId)}`;
    socket.join(roomName);
    console.log(`💬 User ${userId} a rejoint la conversation avec ${otherUserId}`);
  });

  // Envoyer un message
  socket.on("sendMessage", (data) => {
    const { sender_id, receiver_id, message } = data;

    // Vérification pour la nouvelle structure
    if (socket.userId && socket.userId != sender_id) {
      console.warn(`⚠️ Tentative d'envoi depuis mauvais user: socket=${socket.userId}, message=${sender_id}`);
      socket.emit("messageError", { error: "Authentification invalide" });
      return;
    }

    console.log("📩 Message reçu:", { sender_id, receiver_id, message: message.substring(0, 50) + "..." });

    // Insérer dans la base
    db.query(
      "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
      [sender_id, receiver_id, message],
      (err, result) => {
        if (err) {
          console.error("❌ Erreur MySQL:", err);
          socket.emit("messageError", { error: "Erreur base de données" });
          return;
        }

        console.log("✅ Message enregistré ID:", result.insertId);

        const messageData = {
          id: result.insertId,
          sender_id,
          receiver_id,
          message,
          created_at: new Date(),
          is_read: false
        };

        // Envoyer au receveur (ancienne méthode)
        io.to(receiver_id.toString()).emit("receiveMessage", messageData);
        
        // Envoyer à la room de conversation (nouvelle méthode)
        const conversationRoom = `conversation_${Math.min(sender_id, receiver_id)}_${Math.max(sender_id, receiver_id)}`;
        io.to(conversationRoom).emit("receiveMessage", messageData);
        
        // Envoyer aussi une notification
        io.to(`user_${receiver_id}`).emit("newMessageNotification", {
          ...messageData,
          sender_device_id: socket.deviceId
        });
      }
    );
  });

  // Récupérer l'historique des messages
  socket.on("getConversation", (data) => {
    const { user1, user2, limit = 50 } = data;
    
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
        
        socket.emit("conversationHistory", {
          user1,
          user2,
          messages
        });
      }
    );
  });

  // Déconnexion
  socket.on("disconnect", () => {
    console.log("🔴 Déconnexion:", socket.id, "User ID:", socket.userId);
    
    if (socket.userId) {
      // Notifier que l'utilisateur est hors ligne
      socket.broadcast.emit("userOffline", {
        user_id: socket.userId,
        device_id: socket.deviceId
      });
    }
  });
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
});