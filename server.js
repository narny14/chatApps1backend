const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const app = express();
const server = http.createServer(app);

// Configuration MySQL Railway
const pool = mysql.createPool({
  host: "centerbeam.proxy.rlwy.net",
  user: "root",
  password: "hcyWqBlfnvbihFsayzebffBaxXtNihBz",
  database: "railway",
  port: 44341,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: { rejectUnauthorized: false }
});

// Stockage en mémoire pour les sockets actifs
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
    database: "railway",
    timestamp: new Date().toISOString(),
    onlineUsers: userSockets.size,
    totalUsers: userSockets.size,
    serverTime: Date.now()
  });
});

// Route de debug
app.get("/debug", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Statistiques
    const [userStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online_users_db,
        MIN(created_at) as first_user,
        MAX(last_seen) as last_activity
      FROM users
    `);
    
    const [messageStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total_messages,
        MAX(created_at) as latest_message,
        MIN(created_at) as first_message
      FROM messages
    `);
    
    // Derniers messages
    const [recentMessages] = await connection.execute(`
      SELECT 
        m.id,
        m.sender_id,
        m.receiver_id,
        LEFT(m.message, 50) as message_preview,
        m.created_at,
        s.device_id as sender_device,
        r.device_id as receiver_device
      FROM messages m
      LEFT JOIN users s ON m.sender_id = s.id
      LEFT JOIN users r ON m.receiver_id = r.id
      ORDER BY m.created_at DESC
      LIMIT 5
    `);
    
    // Derniers utilisateurs
    const [recentUsers] = await connection.execute(`
      SELECT 
        id,
        device_id,
        online,
        created_at,
        last_seen
      FROM users
      ORDER BY last_seen DESC
      LIMIT 5
    `);
    
    connection.release();
    
    res.json({
      server: {
        url: "https://chatapps1backend.onrender.com",
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: Date.now()
      },
      database: {
        connected: true,
        users: userStats[0],
        messages: messageStats[0],
        sockets_online: userSockets.size
      },
      recent: {
        messages: recentMessages,
        users: recentUsers
      },
      active_sockets: Array.from(userSockets.entries()).map(([userId, socketId]) => ({
        userId,
        socketId: socketId.substring(0, 10) + '...'
      }))
    });
    
  } catch (error) {
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

// ================= GESTION DES CONNEXIONS SOCKET =================

io.on("connection", (socket) => {
  console.log(`🔌 Nouveau client: ${socket.id} (${socket.handshake.address})`);
  
  // Heartbeat
  socket.on("ping", (data) => {
    socket.emit("pong", { 
      ...data, 
      serverTime: Date.now(),
      server: "https://chatapps1backend.onrender.com"
    });
  });

  // ============ 1. ENREGISTREMENT UTILISATEUR ============
  socket.on("register", async (data) => {
    console.log(`📱 Register request from ${socket.id}:`, {
      deviceId: data.deviceId ? data.deviceId.substring(0, 30) + '...' : 'none',
      timestamp: Date.now()
    });
    
    try {
      const { deviceId } = data;
      
      if (!deviceId || deviceId.trim() === "") {
        socket.emit("register_error", { 
          error: "deviceId est requis",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }
      
      const connection = await pool.getConnection();
      
      try {
        // Vérifier si l'utilisateur existe déjà
        const [existingUsers] = await connection.execute(
          "SELECT id, device_id, online FROM users WHERE device_id = ?",
          [deviceId.trim()]
        );
        
        let userId;
        let isNewUser = false;
        
        if (existingUsers.length > 0) {
          // Utilisateur existant
          userId = existingUsers[0].id;
          console.log(`👤 Utilisateur existant #${userId} reconnecté`);
          
          // Mettre à jour le statut et last_seen
          await connection.execute(
            "UPDATE users SET online = 1, last_seen = NOW() WHERE id = ?",
            [userId]
          );
        } else {
          // Nouvel utilisateur
          console.log(`🆕 Création nouvel utilisateur pour: ${deviceId.substring(0, 30)}...`);
          
          const [result] = await connection.execute(
            "INSERT INTO users (device_id, online) VALUES (?, 1)",
            [deviceId.trim()]
          );
          
          userId = result.insertId;
          isNewUser = true;
          console.log(`✅ Nouvel utilisateur #${userId} créé`);
        }
        
        connection.release();
        
        // Associer socket ↔ utilisateur
        socket.userId = userId;
        socket.deviceId = deviceId;
        userSockets.set(userId, socket.id);
        socketUsers.set(socket.id, userId);
        
        // Joindre la room personnelle
        socket.join(`user:${userId}`);
        
        console.log(`✅ User #${userId} ↔ Socket ${socket.id} (${isNewUser ? 'new' : 'existing'})`);
        
        // Réponse au client
        socket.emit("registered", {
          success: true,
          userId: userId,
          deviceId: deviceId,
          isNewUser: isNewUser,
          socketId: socket.id,
          server: "https://chatapps1backend.onrender.com",
          timestamp: Date.now()
        });
        
        // Mettre à jour la liste des utilisateurs pour tous
        broadcastOnlineUsers();
        
        // Envoyer la liste des utilisateurs après un court délai
        setTimeout(() => {
          if (socket.connected) {
            sendUsersList(socket);
          }
        }, 500);
        
      } catch (dbError) {
        connection.release();
        console.error("❌ Erreur base de données register:", {
          error: dbError.message,
          code: dbError.code,
          sql: dbError.sql,
          deviceId: deviceId.substring(0, 30) + '...'
        });
        
        // Mode temporaire en cas d'erreur
        const tempUserId = Math.floor(Math.random() * 9000) + 1000;
        socket.userId = tempUserId;
        
        socket.emit("registered", {
          success: true,
          userId: tempUserId,
          deviceId: deviceId,
          isTemporary: true,
          warning: "Mode temporaire - erreur DB",
          server: "https://chatapps1backend.onrender.com",
          timestamp: Date.now()
        });
        
        console.log(`⚠️ Mode temporaire User #${tempUserId} pour ${socket.id}`);
      }
      
    } catch (error) {
      console.error("❌ Erreur générale register:", error);
      socket.emit("register_error", { 
        error: "Erreur serveur",
        details: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // ============ 2. DEMANDER LA LISTE DES UTILISATEURS ============
  socket.on("get_users", async () => {
    try {
      if (!socket.userId) {
        console.log(`❌ get_users: socket ${socket.id} non authentifié`);
        socket.emit("users_error", { 
          error: "Non authentifié - register d'abord",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }
      
      console.log(`👥 get_users demandé par User #${socket.userId}`);
      sendUsersList(socket);
      
    } catch (error) {
      console.error("❌ Erreur get_users:", error);
      socket.emit("users_error", { 
        error: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // ============ 3. ENVOYER UN MESSAGE ============
  socket.on("send_message", async (data) => {
    const startTime = Date.now();
    
    try {
      const { to, text } = data;
      const from = socket.userId;
      
      console.log(`📤 send_message: User #${from} → User #${to}`, {
        textLength: text?.length || 0,
        textPreview: text ? text.substring(0, 50) + (text.length > 50 ? '...' : '') : 'empty',
        socket: socket.id
      });
      
      // Validation stricte
      if (!from || !to || !text || text.trim() === "") {
        console.error("❌ Validation failed:", { from, to, text: text ? 'present' : 'missing' });
        socket.emit("message_error", { 
          error: "Données invalides: from, to et text requis",
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
      
      const connection = await pool.getConnection();
      
      try {
        // Vérifier que le destinataire existe
        const [recipientCheck] = await connection.execute(
          "SELECT id, device_id FROM users WHERE id = ?",
          [to]
        );
        
        if (recipientCheck.length === 0) {
          connection.release();
          console.error(`❌ Destinataire User #${to} non trouvé`);
          socket.emit("message_error", { 
            error: `Destinataire User #${to} non trouvé`,
            server: "https://chatapps1backend.onrender.com"
          });
          return;
        }
        
        // INSÉRER LE MESSAGE DANS LA BASE
        const [insertResult] = await connection.execute(
          "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
          [from, to, text.trim()]
        );
        
        const messageId = insertResult.insertId;
        console.log(`✅ Message #${messageId} inséré en DB (${Date.now() - startTime}ms)`);
        
        // RÉCUPÉRER LE MESSAGE COMPLET AVEC TIMESTAMP FORMATÉ
        const [messages] = await connection.execute(
          `SELECT 
            m.*,
            DATE_FORMAT(m.created_at, '%Y-%m-%dT%TZ') as created_at_iso,
            s.device_id as sender_device_id,
            r.device_id as receiver_device_id
           FROM messages m
           LEFT JOIN users s ON m.sender_id = s.id
           LEFT JOIN users r ON m.receiver_id = r.id
           WHERE m.id = ?`,
          [messageId]
        );
        
        connection.release();
        
        if (messages.length === 0) {
          console.error(`❌ Message #${messageId} inséré mais non retrouvé`);
          socket.emit("message_error", { 
            error: "Erreur de récupération du message",
            server: "https://chatapps1backend.onrender.com"
          });
          return;
        }
        
        const messageData = messages[0];
        
        // Formater pour le client
        const formattedMessage = {
          id: messageData.id,
          sender_id: parseInt(messageData.sender_id),
          receiver_id: parseInt(messageData.receiver_id),
          message: messageData.message,
          created_at: messageData.created_at_iso || messageData.created_at,
          sender_device_id: messageData.sender_device_id,
          receiver_device_id: messageData.receiver_device_id
        };
        
        console.log(`📊 Message #${messageId} formaté:`, {
          sender: formattedMessage.sender_id,
          receiver: formattedMessage.receiver_id,
          timestamp: formattedMessage.created_at
        });
        
        // 1. CONFIRMER À L'EXPÉDITEUR IMMÉDIATEMENT
        socket.emit("message_sent", {
          success: true,
          message: formattedMessage,
          server: "https://chatapps1backend.onrender.com",
          timestamp: Date.now(),
          insertTime: Date.now() - startTime
        });
        
        console.log(`✅ Confirmation envoyée à expéditeur User #${from}`);
        
        // 2. ENVOYER AU DESTINATAIRE EN TEMPS RÉEL
        const recipientSocketId = userSockets.get(parseInt(to));
        
        if (recipientSocketId) {
          console.log(`📩 Envoi temps réel à User #${to} (socket: ${recipientSocketId})`);
          
          io.to(recipientSocketId).emit("new_message", {
            success: true,
            message: formattedMessage,
            server: "https://chatapps1backend.onrender.com",
            timestamp: Date.now()
          });
          
          console.log(`✅ Message délivré en temps réel à User #${to}`);
        } else {
          console.log(`📭 Destinataire User #${to} hors ligne - Message sauvegardé en DB`);
        }
        
        console.log(`✅ Process complet: ${Date.now() - startTime}ms`);
        
      } catch (dbError) {
        connection.release();
        console.error("❌ Erreur DB send_message:", {
          error: dbError.message,
          code: dbError.code,
          sql: dbError.sql,
          from: from,
          to: to
        });
        
        socket.emit("message_error", { 
          error: "Erreur base de données",
          details: dbError.message,
          code: dbError.code,
          server: "https://chatapps1backend.onrender.com"
        });
      }
      
    } catch (error) {
      console.error("❌ Erreur générale send_message:", error);
      socket.emit("message_error", { 
        error: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // ============ 4. CHARGER L'HISTORIQUE DES MESSAGES ============
  socket.on("get_messages", async (data) => {
    try {
      const { with: otherUserId, limit = 50 } = data;
      const userId = socket.userId;
      
      console.log(`📜 get_messages: User #${userId} avec User #${otherUserId}`);
      
      if (!userId || !otherUserId) {
        socket.emit("messages_error", { 
          error: "Paramètres manquants",
          server: "https://chatapps1backend.onrender.com"
        });
        return;
      }
      
      const connection = await pool.getConnection();
      
      const [messages] = await connection.execute(
        `SELECT 
          m.*,
          DATE_FORMAT(m.created_at, '%Y-%m-%dT%TZ') as created_at_iso,
          s.device_id as sender_device_id,
          r.device_id as receiver_device_id
         FROM messages m
         LEFT JOIN users s ON m.sender_id = s.id
         LEFT JOIN users r ON m.receiver_id = r.id
         WHERE (m.sender_id = ? AND m.receiver_id = ?) 
            OR (m.sender_id = ? AND m.receiver_id = ?)
         ORDER BY m.created_at ASC
         LIMIT ?`,
        [userId, otherUserId, otherUserId, userId, parseInt(limit)]
      );
      
      connection.release();
      
      // Formater les messages
      const formattedMessages = messages.map(msg => ({
        id: msg.id,
        sender_id: parseInt(msg.sender_id),
        receiver_id: parseInt(msg.receiver_id),
        message: msg.message,
        created_at: msg.created_at_iso || msg.created_at,
        sender_device_id: msg.sender_device_id,
        receiver_device_id: msg.receiver_device_id
      }));
      
      console.log(`📜 ${formattedMessages.length} messages chargés entre ${userId} et ${otherUserId}`);
      
      socket.emit("messages", {
        success: true,
        with: otherUserId,
        messages: formattedMessages,
        count: formattedMessages.length,
        server: "https://chatapps1backend.onrender.com",
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error("❌ Erreur get_messages:", error);
      socket.emit("messages_error", { 
        error: error.message,
        server: "https://chatapps1backend.onrender.com"
      });
    }
  });

  // ============ 5. DÉCONNEXION ============
  socket.on("disconnect", async (reason) => {
    console.log(`🔴 Déconnexion: ${socket.id} (${reason})`);
    
    const userId = socketUsers.get(socket.id);
    
    if (userId) {
      try {
        const connection = await pool.getConnection();
        await connection.execute(
          "UPDATE users SET online = 0 WHERE id = ?",
          [userId]
        );
        connection.release();
        console.log(`✅ User #${userId} marqué hors ligne`);
      } catch (error) {
        console.error(`❌ Erreur update déconnexion User #${userId}:`, error);
      }
      
      userSockets.delete(userId);
      socketUsers.delete(socket.id);
      
      broadcastOnlineUsers();
    }
  });
});

// ================= FONCTIONS UTILITAIRES =================

// Envoyer la liste des utilisateurs à un socket
async function sendUsersList(socket) {
  try {
    const connection = await pool.getConnection();
    
    const [users] = await connection.execute(
      `SELECT 
        id, 
        device_id, 
        online,
        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') as created_at,
        DATE_FORMAT(last_seen, '%Y-%m-%d %H:%i') as last_seen
       FROM users 
       WHERE id != ? 
       ORDER BY online DESC, last_seen DESC`,
      [socket.userId]
    );
    
    connection.release();
    
    // Marquer comme en ligne ceux qui ont un socket actif
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
    
    console.log(`👥 Liste envoyée à User #${socket.userId}: ${usersWithStatus.length} utilisateurs`);
    
  } catch (error) {
    console.error("❌ Erreur sendUsersList:", error);
    socket.emit("users_error", { 
      error: error.message,
      server: "https://chatapps1backend.onrender.com"
    });
  }
}

// Diffuser les utilisateurs en ligne à tous
function broadcastOnlineUsers() {
  const onlineUsers = Array.from(userSockets.keys());
  
  io.emit("online_users_update", {
    onlineUsers: onlineUsers,
    count: onlineUsers.length,
    server: "https://chatapps1backend.onrender.com",
    timestamp: Date.now()
  });
  
  console.log(`📡 Mise à jour broadcast: ${onlineUsers.length} utilisateurs en ligne`);
}

// Vérifier la base de données au démarrage
async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Vérifier les tables
    const [usersTable] = await connection.execute(`
      SELECT 
        TABLE_NAME,
        ENGINE,
        TABLE_ROWS,
        CREATE_TIME
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = 'railway' AND TABLE_NAME = 'users'
    `);
    
    const [messagesTable] = await connection.execute(`
      SELECT 
        TABLE_NAME,
        ENGINE,
        TABLE_ROWS,
        CREATE_TIME
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = 'railway' AND TABLE_NAME = 'messages'
    `);
    
    // Statistiques
    const [userStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total,
        SUM(online) as online_count
      FROM users
    `);
    
    const [messageStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total,
        MAX(created_at) as latest,
        MIN(created_at) as earliest
      FROM messages
    `);
    
    connection.release();
    
    console.log("=== BASE DE DONNÉES RAILWAY ===");
    console.log("📊 Utilisateurs:", userStats[0].total, `(${userStats[0].online_count} en ligne)`);
    console.log("📊 Messages:", messageStats[0].total);
    if (messageStats[0].latest) {
      console.log("📅 Dernier message:", messageStats[0].latest);
    }
    console.log("✅ Base de données prête");
    console.log("===============================");
    
  } catch (error) {
    console.error("❌ Erreur vérification DB:", error);
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
  console.log(`🚀 Serveur de production démarré sur le port ${PORT}`);
  console.log(`🔗 URL Render: https://chatapps1backend.onrender.com`);
  console.log(`📡 WebSocket: wss://chatapps1backend.onrender.com`);
  console.log(`🌐 Debug: https://chatapps1backend.onrender.com/debug`);
  console.log(`🗄️  Database: Railway MySQL`);
  console.log("===========================================");
  
  initDatabase();
});