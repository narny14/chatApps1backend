// routes/users.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const User = require("../models/User");

// GET /users - Liste des utilisateurs (sauf soi-même)
router.get("/", async (req, res) => {
  try {
    const { exclude } = req.query;
    const users = await User.findAll(exclude);
    res.json({ users });
  } catch (error) {
    console.error("❌ Erreur récupération users:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /users/:id - Infos d'un utilisateur
router.get("/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: "Utilisateur non trouvé" });
    }
    
    res.json({ user });
  } catch (error) {
    console.error("❌ Erreur récupération user:", error);
    res.status(500).json({ error: error.message });
  }
});

// POST /users/register - Enregistrement manuel (fallback)
router.post("/register", async (req, res) => {
  try {
    const { device_id, expo_push_token, device_model, os_version, app_version } = req.body;
    
    if (!device_id) {
      return res.status(400).json({ error: "device_id requis" });
    }
    
    const user = await User.findOrCreate({
      device_id,
      expo_push_token,
      device_model,
      os_version,
      app_version
    });
    
    res.json({
      success: true,
      user_id: user.id,
      device_id: user.device_id
    });
  } catch (error) {
    console.error("❌ Erreur enregistrement:", error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;