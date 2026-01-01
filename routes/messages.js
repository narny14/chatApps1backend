const express = require("express");
const router = express.Router();
const db = require("../db");

router.get("/:user1/:user2", (req, res) => {
  const { user1, user2 } = req.params;
  const sql = `
    SELECT * FROM messages
    WHERE (sender_id=? AND receiver_id=?)
       OR (sender_id=? AND receiver_id=?)
    ORDER BY created_at ASC
  `;
  db.query(sql, [user1, user2, user2, user1], (err, result) => {
    if (err) return res.status(500).json(err);
    res.json(result);
  });
});

module.exports = router;
