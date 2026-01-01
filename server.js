const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(bodyParser.json());
app.get("/", (req, res) => {
  res.send("✅ Backend chat fonctionne !");
});
app.use("/messages", require("./routes/messages"));

const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("User connecté :", socket.id);

  socket.on("join", (userId) => {
    socket.join(userId.toString());
  });

  socket.on("sendMessage", (data) => {
    const { sender_id, receiver_id, message } = data;
    const db = require("./db");
    db.query(
      "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?,?,?)",
      [sender_id, receiver_id, message]
    );
    io.to(receiver_id.toString()).emit("receiveMessage", data);
  });

  socket.on("disconnect", () => {
    console.log("User déconnecté");
  });
});

server.listen(3000, () => {
  console.log("✅ Backend lancé sur http://localhost:3000");
});
