const express = require("express");
const router = express.Router();
const db = require("../db");

/**
 * POST /messages
 * body: { sender_id, receiver_id, message }
 */
router.post("/", (req, res) => {
  const { sender_id, receiver_id, message } = req.body;

  if (!sender_id || !receiver_id || !message) {
    return res.status(400).json({ error: "Champs manquants" });
  }

  const sql =
    "INSERT INTO messages (sender_id, receiver_id, message) VALUES (?, ?, ?)";

  db.query(sql, [sender_id, receiver_id, message], (err, result) => {
    if (err) {
  console.error("❌ Erreur MySQL:", err);
  return res.status(500).json({
    error: err.message, // message exact de MySQL
    code: err.code,     // code d'erreur
  });
}


    res.json({
      success: true,
      message_id: result.insertId,
    });
  });
});

module.exports = router;
