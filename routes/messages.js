// routes/messages.js - version améliorée
const express = require("express");
const router = express.Router();
const db = require("../db");

// Ajoutez cette route GET dans messages.js
router.get("/conversation", (req, res) => {
  const { user1, user2, limit = 50 } = req.query;
  
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 et user2 requis" });
  }
  
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
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        user1,
        user2,
        messages: results.reverse()
      });
    }
  );
});
// POST /messages
router.post("/", (req, res) => {
  const { sender_id, receiver_id, message } = req.body;

  // Validation
  if (!sender_id || !receiver_id || !message) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  if (sender_id === receiver_id) {
    return res.status(400).json({ error: "Impossible de s'envoyer un message à soi-même" });
  }

  const sql = "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)";

  db.query(sql, [sender_id, receiver_id, message], (err, result) => {
    if (err) {
      console.error("❌ Erreur MySQL:", err);
      return res.status(500).json({
        error: err.message,
        code: err.code,
      });
    }

    res.json({
      success: true,
      message_id: result.insertId,
      sender_id,
      receiver_id,
      created_at: new Date()
    });
  });
});

// GET /messages/conversation?user1=X&user2=Y
/*router.get("/conversation", (req, res) => {
  const { user1, user2, limit = 50 } = req.query;
  
  if (!user1 || !user2) {
    return res.status(400).json({ error: "user1 et user2 requis" });
  }
  
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
        return res.status(500).json({ error: err.message });
      }
      
      res.json({
        user1,
        user2,
        messages: results.reverse() // Plus ancien au plus récent
      });
    }
  );
});*/

module.exports = router;