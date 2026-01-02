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
app.get("/test-db", (req, res) => {
  db.getConnection((err, connection) => {
    if (err) {
      console.error("❌ Erreur connexion MySQL:", err);
      return res.status(500).json({
        error: err.message,
        code: err.code,
        sqlMessage: err.sqlMessage,
        address: err.address,
        port: err.port
      });
    } else {
      console.log("✅ Connexion MySQL réussie");
      connection.release();
      return res.json({ 
        success: true, 
        message: "Connexion DB réussie",
        host: process.env.DB_HOST,
        port: process.env.DB_PORT
      });
    }
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
