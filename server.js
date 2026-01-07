const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const { Expo } = require('expo-server-sdk');

const app = express();
const server = http.createServer(app);

// Créez une instance Expo
const expo = new Expo();

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

// Stockage en mémoire
const userSockets = new Map(); // { userId: socketId }
const socketUsers = new Map(); // { socketId: userId }

// URLs du serveur
const SERVER_URL = "https://chatapps1backend.onrender.com";
const SERVER_WS_URL = "wss://chatapps1backend.onrender.com";

// ================= FONCTIONS UTILITAIRES =================

// Fonction pour envoyer des notifications push
async function sendPushNotification(pushToken, title, body, data = {}) {
  try {
    if (!pushToken || !Expo.isExpoPushToken(pushToken)) {
      console.log(`❌ Token push invalide ou manquant`);
      return false;
    }

    const message = {
      to: pushToken,
      sound: 'default',
      title: title,
      body: body,
      data: data,
      priority: 'high',
      badge: 1
    };

    const tickets = await expo.sendPushNotificationsAsync([message]);
    
    const ticket = tickets[0];
    if (ticket.status === 'ok') {
      console.log(`✅ Notification envoyée`);
      return true;
    } else {
      console.log(`❌ Échec notification: ${ticket.message}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Erreur envoi notification:', error);
    return false;
  }
}

// Middleware CORS pour production
app.use((req, res, next) => {
  const allowedOrigins = [
    SERVER_URL,
    'exp://*',
    'http://localhost:*',
    'http://192.168.*:*',
    'http://10.0.*:*',
    'https://chatapps1backend.onrender.com'
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

// Route racine
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "Chat Server Running",
    server: SERVER_URL,
    websocket: SERVER_WS_URL,
    database: "railway",
    timestamp: new Date().toISOString(),
    onlineUsers: userSockets.size,
    serverTime: Date.now(),
    version: "1.0.0"
  });
});

// Route de santé
app.get("/health", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    
    res.json({
      status: "healthy",
      server: SERVER_URL,
      database: "connected",
      onlineUsers: userSockets.size,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      server: SERVER_URL,
      timestamp: Date.now()
    });
  }
});

// Route de debug
app.get("/debug", async (req, res) => {
  try {
    const connection = await pool.getConnection();
    
    // Statistiques utilisateurs
    const [userStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online_users_db
      FROM users
    `);
    
    // Statistiques messages
    const [messageStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total_messages,
        MAX(created_at) as latest_message,
        MIN(created_at) as first_message
      FROM messages
    `);
    
    // Derniers utilisateurs
    const [recentUsers] = await connection.execute(`
      SELECT 
        id,
        device_id,
        online,
        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as created_at,
        DATE_FORMAT(last_seen, '%Y-%m-%d %H:%i:%s') as last_seen
      FROM users
      ORDER BY last_seen DESC
      LIMIT 10
    `);
    
    // Derniers messages
    const [recentMessages] = await connection.execute(`
      SELECT 
        m.id,
        m.sender_id,
        m.receiver_id,
        LEFT(m.message, 50) as message_preview,
        DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i:%s') as created_at,
        u1.device_id as sender_device,
        u2.device_id as receiver_device
      FROM messages m
      LEFT JOIN users u1 ON m.sender_id = u1.id
      LEFT JOIN users u2 ON m.receiver_id = u2.id
      ORDER BY m.created_at DESC
      LIMIT 10
    `);
    
    connection.release();
    
    res.json({
      server: {
        url: SERVER_URL,
        websocket: SERVER_WS_URL,
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
        users: recentUsers,
        messages: recentMessages
      },
      active_sockets: Array.from(userSockets.entries()).map(([userId, socketId]) => ({
        userId,
        socketId: socketId.substring(0, 10) + '...'
      }))
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      server: SERVER_URL
    });
  }
});

// Route pour créer un utilisateur de test
app.post("/debug/create-user", async (req, res) => {
  try {
    const { device_id } = req.body;
    
    if (!device_id) {
      return res.status(400).json({ 
        error: "device_id est requis",
        server: SERVER_URL
      });
    }
    
    const connection = await pool.getConnection();
    
    // Vérifier si existe déjà
    const [existing] = await connection.execute(
      "SELECT id FROM users WHERE device_id = ?",
      [device_id]
    );
    
    let userId;
    let isNew = false;
    
    if (existing.length > 0) {
      userId = existing[0].id;
      console.log(`👤 Utilisateur existant #${userId}`);
    } else {
      // Créer nouvel utilisateur
      const [result] = await connection.execute(
        "INSERT INTO users (device_id, online) VALUES (?, 1)",
        [device_id]
      );
      
      userId = result.insertId;
      isNew = true;
      console.log(`🆕 Nouvel utilisateur #${userId} créé`);
    }
    
    connection.release();
    
    res.json({
      success: true,
      userId: userId,
      isNew: isNew,
      device_id: device_id,
      server: SERVER_URL,
      timestamp: Date.now()
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      server: SERVER_URL
    });
  }
});

// Configuration Socket.IO pour production
const io = new Server(server, {
  cors: {
    origin: [
      SERVER_URL,
      'exp://*',
      'http://localhost:*',
      'http://192.168.*:*',
      'http://10.0.*:*'
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
  
  // Heartbeat pour Render
  socket.on("ping", (data) => {
    socket.emit("pong", { 
      ...data, 
      serverTime: Date.now(),
      server: SERVER_URL
    });
  });

  // ============ 1. ENREGISTREMENT UTILISATEUR ============
  socket.on("register", async (data) => {
    console.log(`📱 Register request from ${socket.id}:`, {
      deviceId: data.deviceId ? data.deviceId.substring(0, 30) + '...' : 'none',
      hasExpoToken: !!data.expoPushToken,
      tokenLength: data.expoPushToken?.length || 0,
      timestamp: Date.now()
    });
    
    try {
      const { deviceId, expoPushToken } = data;
      
      if (!deviceId || deviceId.trim() === "") {
        socket.emit("register_error", { 
          error: "deviceId est requis",
          server: SERVER_URL
        });
        return;
      }
      
      // VALIDATION DU TOKEN EXPO
      let validToken = null;
      if (expoPushToken) {
        // Vérifier que c'est un token Expo valide
        if (expoPushToken.includes('ExponentPushToken[') && expoPushToken.includes(']')) {
          validToken = expoPushToken;
          console.log(`✅ Token Expo valide reçu: ${validToken.substring(0, 50)}...`);
        } else {
          console.warn(`⚠️ Format token Expo invalide: ${expoPushToken.substring(0, 50)}...`);
          // Essayer de le nettoyer
          if (expoPushToken.startsWith('ExponentPushToken') && expoPushToken.length > 20) {
            validToken = expoPushToken;
            console.log(`🔄 Token accepté malgré format suspect`);
          }
        }
      }
      
      const connection = await pool.getConnection();
      
      try {
        // Vérifier si l'utilisateur existe déjà
        const [existingUsers] = await connection.execute(
          "SELECT id, device_id, online, expo_push_token FROM users WHERE device_id = ?",
          [deviceId.trim()]
        );
        
        let userId;
        let isNewUser = false;
        
        if (existingUsers.length > 0) {
          // Utilisateur existant
          userId = existingUsers[0].id;
          console.log(`👤 Utilisateur existant #${userId} reconnecté`);
          
          // Mettre à jour le statut et le token push si fourni
          if (validToken) {
            // Vérifier si le token est différent de celui enregistré
            const currentToken = existingUsers[0].expo_push_token;
            if (currentToken !== validToken) {
              await connection.execute(
                "UPDATE users SET online = 1, last_seen = NOW(), expo_push_token = ? WHERE id = ?",
                [validToken, userId]
              );
              console.log(`🔔 Token push MIS À JOUR pour User #${userId}: ${validToken.substring(0, 30)}...`);
            } else {
              await connection.execute(
                "UPDATE users SET online = 1, last_seen = NOW() WHERE id = ?",
                [userId]
              );
              console.log(`🔔 Token push DÉJÀ À JOUR pour User #${userId}`);
            }
          } else {
            await connection.execute(
              "UPDATE users SET online = 1, last_seen = NOW() WHERE id = ?",
              [userId]
            );
          }
        } else {
          // Nouvel utilisateur
          console.log(`🆕 Création nouvel utilisateur pour: ${deviceId.substring(0, 30)}...`);
          
          // Insérer avec token push si disponible
          if (validToken) {
            const [result] = await connection.execute(
              "INSERT INTO users (device_id, online, expo_push_token) VALUES (?, 1, ?)",
              [deviceId.trim(), validToken]
            );
            console.log(`🔔 Nouvel utilisateur avec token push créé`);
          } else {
            const [result] = await connection.execute(
              "INSERT INTO users (device_id, online) VALUES (?, 1)",
              [deviceId.trim()]
            );
          }
          
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
        
        // Rejoindre la room personnelle
        socket.join(`user:${userId}`);
        
        console.log(`✅ User #${userId} ↔ Socket ${socket.id} (${isNewUser ? 'new' : 'existing'})`);
        
        // Réponse au client
        socket.emit("registered", {
          success: true,
          userId: userId,
          deviceId: deviceId,
          isNewUser: isNewUser,
          socketId: socket.id,
          expoTokenSaved: !!validToken,
          server: SERVER_URL,
          timestamp: Date.now()
        });
        
        // Mettre à jour la liste des utilisateurs
        broadcastOnlineUsers();
        
        // Envoyer la liste des utilisateurs
        setTimeout(() => {
          if (socket.connected) {
            sendUsersList(socket);
          }
        }, 500);
        
      } catch (dbError) {
        connection.release();
        
        // Gérer les doublons
        if (dbError.code === 'ER_DUP_ENTRY') {
          console.log(`⚠️ Device ID dupliqué, récupération de l'utilisateur existant...`);
          
          const conn = await pool.getConnection();
          const [users] = await conn.execute(
            "SELECT id, expo_push_token FROM users WHERE device_id = ?",
            [deviceId.trim()]
          );
          conn.release();
          
          if (users.length > 0) {
            const userId = users[0].id;
            const currentToken = users[0].expo_push_token;
            
            // Mettre à jour le token push seulement s'il est fourni ET différent
            if (validToken && currentToken !== validToken) {
              const conn2 = await pool.getConnection();
              await conn2.execute(
                "UPDATE users SET expo_push_token = ? WHERE id = ?",
                [validToken, userId]
              );
              conn2.release();
              console.log(`🔔 Token push MIS À JOUR (doublon résolu) pour User #${userId}`);
            }
            
            socket.userId = userId;
            userSockets.set(userId, socket.id);
            socketUsers.set(socket.id, userId);
            
            socket.emit("registered", {
              success: true,
              userId: userId,
              deviceId: deviceId,
              isNewUser: false,
              warning: "Device ID existant réutilisé",
              expoTokenUpdated: !!validToken,
              server: SERVER_URL,
              timestamp: Date.now()
            });
            
            console.log(`✅ User #${userId} récupéré (device_id dupliqué)`);
          }
        } else {
          console.error(`❌ Erreur DB register:`, dbError);
          throw dbError;
        }
      }
      
    } catch (error) {
      console.error("❌ Erreur register:", error);
      socket.emit("register_error", { 
        error: "Erreur serveur",
        details: error.message,
        server: SERVER_URL
      });
    }
  });

  // ============ 2. DEMANDER LA LISTE DES UTILISATEURS ============
  socket.on("get_users", async () => {
    try {
      if (!socket.userId) {
        console.log(`❌ get_users: socket non authentifié`);
        socket.emit("users_error", { 
          error: "Non authentifié - register d'abord",
          server: SERVER_URL
        });
        return;
      }
      
      console.log(`👥 get_users demandé par User #${socket.userId}`);
      sendUsersList(socket);
      
    } catch (error) {
      console.error("❌ Erreur get_users:", error);
      socket.emit("users_error", { 
        error: error.message,
        server: SERVER_URL
      });
    }
  });

  // ============ 3. ENVOYER UN MESSAGE ============
  socket.on("send_message", async (data) => {
    console.log(`📤 send_message: User #${socket.userId} → User #${data.to}`, {
      textLength: data.text?.length || 0,
      socket: socket.id
    });
    
    try {
      const { to, text } = data;
      const from = socket.userId;
      
      // Validation
      if (!from || !to || !text || text.trim() === "") {
        console.error("❌ Données invalides");
        socket.emit("message_error", { 
          error: "Données invalides: from, to et text requis",
          server: SERVER_URL
        });
        return;
      }
      
      const connection = await pool.getConnection();
      
      try {
        // Vérifier que le destinataire existe
        const [recipientCheck] = await connection.execute(
          "SELECT id FROM users WHERE id = ?",
          [to]
        );
        
        if (recipientCheck.length === 0) {
          connection.release();
          console.error(`❌ Destinataire User #${to} non trouvé`);
          socket.emit("message_error", { 
            error: `Destinataire User #${to} non trouvé`,
            server: SERVER_URL
          });
          return;
        }
        
        // INSÉRER LE MESSAGE
        const [insertResult] = await connection.execute(
          "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)",
          [from, to, text.trim()]
        );
        
        const messageId = insertResult.insertId;
        console.log(`✅ Message #${messageId} inséré dans la base`);
        
        // RÉCUPÉRER LE MESSAGE
        const [messages] = await connection.execute(
          `SELECT 
            m.*,
            DATE_FORMAT(m.created_at, '%Y-%m-%dT%TZ') as created_at_iso
           FROM messages m
           WHERE m.id = ?`,
          [messageId]
        );
        
        const messageData = messages[0];
        
        // Récupérer le token push du destinataire
        const [recipientData] = await connection.execute(
          "SELECT expo_push_token, device_id FROM users WHERE id = ?",
          [to]
        );
        
        connection.release();
        
        const recipientPushToken = recipientData[0]?.expo_push_token;
        const recipientDeviceId = recipientData[0]?.device_id || `User #${to}`;
        
        // Formater pour le client
        const formattedMessage = {
          id: messageData.id,
          sender_id: parseInt(messageData.sender_id),
          receiver_id: parseInt(messageData.receiver_id),
          message: messageData.message,
          created_at: messageData.created_at_iso || messageData.created_at
        };
        
        // 1. CONFIRMER À L'EXPÉDITEUR
        socket.emit("message_sent", {
          success: true,
          message: formattedMessage,
          server: SERVER_URL,
          timestamp: Date.now()
        });
        
        console.log(`✅ Confirmation envoyée à expéditeur User #${from}`);
        
        // 2. ENVOYER AU DESTINATAIRE
        const recipientSocketId = userSockets.get(parseInt(to));
        
        if (recipientSocketId) {
          console.log(`📩 Envoi temps réel à User #${to} (socket: ${recipientSocketId})`);
          
          io.to(recipientSocketId).emit("new_message", {
            success: true,
            message: formattedMessage,
            server: SERVER_URL,
            timestamp: Date.now()
          });
          
          console.log(`✅ Message délivré en temps réel à User #${to}`);
        } else {
          console.log(`📭 Destinataire User #${to} hors ligne - Message sauvegardé`);
          
          // Envoyer une notification push si le destinataire a un token
          if (recipientPushToken) {
            try {
              // Récupérer les infos de l'expéditeur
              const conn = await pool.getConnection();
              const [senderData] = await conn.execute(
                "SELECT device_id FROM users WHERE id = ?",
                [from]
              );
              conn.release();
              
              const senderDeviceId = senderData[0]?.device_id || `User #${from}`;
              
              await sendPushNotification(
                recipientPushToken,
                `Message de ${senderDeviceId}`,
                text.length > 100 ? text.substring(0, 100) + '...' : text,
                {
                  type: 'new_message',
                  sender_id: from,
                  message_id: messageId,
                  sender_device: senderDeviceId,
                  server: SERVER_URL,
                  timestamp: Date.now()
                }
              );
              
              console.log(`🔔 Notification push envoyée à User #${to}`);
            } catch (pushError) {
              console.error(`❌ Erreur envoi notification push:`, pushError);
            }
          }
        }
        
      } catch (dbError) {
        connection.release();
        console.error("❌ Erreur DB send_message:", dbError.message);
        
        socket.emit("message_error", { 
          error: "Erreur base de données",
          details: dbError.message,
          server: SERVER_URL
        });
      }
      
    } catch (error) {
      console.error("❌ Erreur send_message:", error);
      socket.emit("message_error", { 
        error: error.message,
        server: SERVER_URL
      });
    }
  });

  // ============ 4. CHARGER L'HISTORIQUE ============
  socket.on("get_messages", async (data) => {
    try {
      const { with: otherUserId } = data;
      const userId = socket.userId;
      
      console.log(`📜 get_messages: User #${userId} avec User #${otherUserId}`);
      
      if (!userId || !otherUserId) {
        socket.emit("messages_error", { 
          error: "Paramètres manquants",
          server: SERVER_URL
        });
        return;
      }
      
      const connection = await pool.getConnection();
      
      const [messages] = await connection.execute(
        `SELECT 
          m.*,
          DATE_FORMAT(m.created_at, '%Y-%m-dT%TZ') as created_at_iso
         FROM messages m
         WHERE (m.sender_id = ? AND m.receiver_id = ?) 
            OR (m.sender_id = ? AND m.receiver_id = ?)
         ORDER BY m.created_at ASC
         LIMIT 50`,
        [userId, otherUserId, otherUserId, userId]
      );
      
      connection.release();
      
      // Formater les messages
      const formattedMessages = messages.map(msg => ({
        id: msg.id,
        sender_id: parseInt(msg.sender_id),
        receiver_id: parseInt(msg.receiver_id),
        message: msg.message,
        created_at: msg.created_at_iso || msg.created_at
      }));
      
      console.log(`📜 ${formattedMessages.length} messages chargés`);
      
      socket.emit("messages", {
        success: true,
        with: otherUserId,
        messages: formattedMessages,
        count: formattedMessages.length,
        server: SERVER_URL,
        timestamp: Date.now()
      });
      
    } catch (error) {
      console.error("❌ Erreur get_messages:", error);
      socket.emit("messages_error", { 
        error: error.message,
        server: SERVER_URL
      });
    }
  });

  // ============ 5. MISE À JOUR DU TOKEN PUSH ============
  socket.on("update_push_token", async (data) => {
    try {
      const { expoPushToken } = data;
      const userId = socket.userId;
      
      console.log("📥 update_push_token reçu:", {
        userId: userId,
        hasToken: !!expoPushToken,
        tokenLength: expoPushToken?.length || 0,
        socket: socket.id
      });
      
      if (!userId) {
        console.log("❌ update_push_token: Utilisateur non authentifié");
        socket.emit("push_token_error", {
          success: false,
          error: "Non authentifié",
          server: SERVER_URL
        });
        return;
      }
      
      if (!expoPushToken) {
        console.log("❌ update_push_token: Token manquant");
        socket.emit("push_token_error", {
          success: false,
          error: "Token manquant",
          server: SERVER_URL
        });
        return;
      }
      
      // VALIDER LE FORMAT DU TOKEN
      if (!expoPushToken.includes('ExponentPushToken') || expoPushToken.length < 20) {
        console.warn(`⚠️ Format token suspect: ${expoPushToken.substring(0, 50)}...`);
        
        socket.emit("push_token_error", {
          success: false,
          error: "Format token invalide",
          receivedToken: expoPushToken.substring(0, 30) + '...',
          server: SERVER_URL
        });
        return;
      }
      
      const connection = await pool.getConnection();
      
      try {
        // 1. Vérifier l'utilisateur existe
        const [userCheck] = await connection.execute(
          "SELECT id, expo_push_token FROM users WHERE id = ?",
          [userId]
        );
        
        if (userCheck.length === 0) {
          connection.release();
          console.error(`❌ User #${userId} non trouvé`);
          socket.emit("push_token_error", {
            success: false,
            error: "Utilisateur non trouvé",
            server: SERVER_URL
          });
          return;
        }
        
        const currentToken = userCheck[0].expo_push_token;
        
        // 2. Vérifier si le token est différent
        if (currentToken === expoPushToken) {
          connection.release();
          console.log(`✅ Token déjà à jour pour User #${userId}`);
          
          socket.emit("push_token_updated", {
            success: true,
            message: "Token déjà à jour",
            token: expoPushToken.substring(0, 30) + '...',
            server: SERVER_URL,
            timestamp: Date.now()
          });
          return;
        }
        
        // 3. Mettre à jour le token
        const [updateResult] = await connection.execute(
          "UPDATE users SET expo_push_token = ?, last_seen = NOW() WHERE id = ?",
          [expoPushToken, userId]
        );
        
        connection.release();
        
        if (updateResult.affectedRows > 0) {
          console.log(`✅ Token MIS À JOUR pour User #${userId}: ${expoPushToken.substring(0, 50)}...`);
          
          socket.emit("push_token_updated", {
            success: true,
            message: "Token push mis à jour avec succès",
            tokenUpdated: true,
            newTokenPreview: expoPushToken.substring(0, 30) + '...',
            server: SERVER_URL,
            timestamp: Date.now()
          });
        } else {
          console.error(`❌ Aucune ligne affectée pour User #${userId}`);
          socket.emit("push_token_error", {
            success: false,
            error: "Échec mise à jour token",
            server: SERVER_URL
          });
        }
        
      } catch (dbError) {
        connection.release();
        
        // Gérer les erreurs spécifiques MySQL
        if (dbError.code === 'ER_DATA_TOO_LONG') {
          console.error(`❌ Token trop long pour la colonne MySQL: ${expoPushToken.length} caractères`);
          
          // Essayez de le tronquer (mais cela risque de le rendre invalide)
          const truncatedToken = expoPushToken.substring(0, 254);
          console.log(`⚠️ Tentative avec token tronqué: ${truncatedToken.length} caractères`);
          
          try {
            const conn2 = await pool.getConnection();
            const [result] = await conn2.execute(
              "UPDATE users SET expo_push_token = ?, last_seen = NOW() WHERE id = ?",
              [truncatedToken, userId]
            );
            conn2.release();
            
            if (result.affectedRows > 0) {
              console.log(`✅ Token TRONQUÉ inséré pour User #${userId}`);
              socket.emit("push_token_warning", {
                success: true,
                warning: "Token tronqué (trop long pour MySQL)",
                tokenLength: expoPushToken.length,
                truncatedLength: truncatedToken.length,
                tokenPreview: truncatedToken.substring(0, 30) + '...',
                server: SERVER_URL,
                timestamp: Date.now()
              });
            }
          } catch (truncateError) {
            console.error(`❌ Échec insertion token tronqué:`, truncateError);
            socket.emit("push_token_error", {
              success: false,
              error: "Token trop long pour la base de données",
              tokenLength: expoPushToken.length,
              maxLength: 255,
              server: SERVER_URL
            });
          }
        } else {
          console.error(`❌ Erreur DB update_push_token:`, dbError);
          socket.emit("push_token_error", {
            success: false,
            error: "Erreur base de données",
            details: dbError.message,
            server: SERVER_URL
          });
        }
      }
      
    } catch (error) {
      console.error(`❌ Erreur update_push_token:`, error);
      socket.emit("push_token_error", {
        success: false,
        error: error.message,
        server: SERVER_URL
      });
    }
  });

  // ============ 6. DÉCONNEXION ============
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
        console.error(`❌ Erreur update déconnexion:`, error);
      }
      
      userSockets.delete(userId);
      socketUsers.delete(socket.id);
      
      broadcastOnlineUsers();
    }
  });
});

// ================= FONCTIONS UTILITAIRES =================

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
      server: SERVER_URL,
      timestamp: Date.now()
    });
    
    console.log(`👥 Liste envoyée à User #${socket.userId}: ${usersWithStatus.length} utilisateurs`);
    
  } catch (error) {
    console.error("❌ Erreur sendUsersList:", error);
    socket.emit("users_error", { 
      error: error.message,
      server: SERVER_URL
    });
  }
}

// Diffuser les utilisateurs en ligne
function broadcastOnlineUsers() {
  const onlineUsers = Array.from(userSockets.keys());
  
  io.emit("online_users_update", {
    onlineUsers: onlineUsers,
    count: onlineUsers.length,
    server: SERVER_URL,
    timestamp: Date.now()
  });
  
  console.log(`📡 Mise à jour broadcast: ${onlineUsers.length} utilisateurs en ligne`);
}

// Vérifier la base de données
async function initDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Vérifier la connexion
    await connection.ping();
    
    // Statistiques
    const [userStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online_users
      FROM users
    `);
    
    const [messageStats] = await connection.execute(`
      SELECT 
        COUNT(*) as total_messages,
        MAX(created_at) as latest_message
      FROM messages
    `);
    
    connection.release();
    
    console.log("=== BASE DE DONNÉES RAILWAY ===");
    console.log(`🔗 URL: ${SERVER_URL}`);
    console.log(`👥 Utilisateurs: ${userStats[0].total_users} (${userStats[0].online_users} en ligne)`);
    console.log(`💬 Messages: ${messageStats[0].total_messages}`);
    if (messageStats[0].latest_message) {
      console.log(`📅 Dernier message: ${messageStats[0].latest_message}`);
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
  console.log(`🔗 URL Render: ${SERVER_URL}`);
  console.log(`📡 WebSocket: ${SERVER_WS_URL}`);
  console.log(`🌐 API Health: ${SERVER_URL}/health`);
  console.log(`🔍 Debug: ${SERVER_URL}/debug`);
  console.log(`🗄️  Database: Railway MySQL (centerbeam.proxy.rlwy.net:44341)`);
  console.log("===========================================");
  
  initDatabase();
});