const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./db");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());

// 🔹 Route test
app.get("/", (req, res) => {
  res.send("✅ Backend chat fonctionne (Render)");
});
// 🔹 Route pour tester la connexion DB
// 🔹 Route pour tester la connexion DB (version améliorée)
app.get("/test-db", (req, res) => {
  console.log("🔍 Test DB - Variables d'environnement :", {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_USER: process.env.DB_USER,
    DB_NAME: process.env.DB_NAME,
    DB_PASSWORD: process.env.DB_PASSWORD ? "hcyWqBlfnvbihFsayzebffBaxXtNihBz" : "MANQUANT"
  });

  // Test de connexion directe
  const mysql = require("mysql2");
  
  const testConnection = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 10000, // 10 secondes
    debug: true // Active les logs détaillés
  });

  testConnection.connect((err) => {
    if (err) {
      console.error("❌ ERREUR CONNEXION COMPLÈTE :", {
        message: err.message,
        code: err.code,
        errno: err.errno,
        sqlState: err.sqlState,
        sqlMessage: err.sqlMessage,
        address: err.address,
        port: err.port,
        fatal: err.fatal,
        stack: err.stack
      });
      
      return res.status(500).json({
        error: "Connexion refusée",
        details: {
          code: err.code,
          errno: err.errno,
          message: err.message,
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          attemptedAt: new Date().toISOString()
        },
        config: {
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          user: process.env.DB_USER,
          database: process.env.DB_NAME
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

// 🔹 Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("🟢 User connecté :", socket.id);

  socket.on("join", (userId) => {
    socket.join(userId.toString());
    console.log("➡️ User rejoint la room :", userId);
  });

  socket.on("sendMessage", (data) => {
    const { sender_id, receiver_id, message } = data;

    console.log("📩 Message reçu :", data);

    db.query(
      "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?,?,?)",
      [sender_id, receiver_id, message],
      (err, result) => {
        if (err) {
          console.error("❌ Erreur MySQL :", err);
          return;
        }

        console.log("✅ Message enregistré ID:", result.insertId);

        io.to(receiver_id.toString()).emit("receiveMessage", {
          id: result.insertId,
          sender_id,
          receiver_id,
          message,
          created_at: new Date()
        });
      }
    );
  });

  socket.on("disconnect", () => {
    console.log("🔴 User déconnecté :", socket.id);
  });
});

// 🔴 PORT RENDER OBLIGATOIRE
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Backend lancé sur le port", PORT);
});
