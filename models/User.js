// models/User.js
const db = require("../db");

class User {
  // Trouver ou créer un utilisateur par device_id
  static async findOrCreate(deviceData) {
    const {
      device_id,
      expo_push_token = null,
      device_model = null,
      os_version = null,
      app_version = null
    } = deviceData;

    return new Promise((resolve, reject) => {
      // D'abord, chercher l'utilisateur
      db.query(
        "SELECT * FROM users WHERE device_id = ?",
        [device_id],
        (err, results) => {
          if (err) return reject(err);

          if (results.length > 0) {
            // Mettre à jour last_seen et push token si fourni
            const updateFields = { last_seen: new Date() };
            const updateValues = [new Date()];
            
            if (expo_push_token) {
              updateFields.expo_push_token = expo_push_token;
              updateValues.push(expo_push_token);
            }
            
            updateValues.push(device_id);
            
            db.query(
              `UPDATE users SET last_seen = ? ${expo_push_token ? ', expo_push_token = ?' : ''} WHERE device_id = ?`,
              updateValues,
              (updateErr) => {
                if (updateErr) return reject(updateErr);
                resolve(results[0]); // Retourner l'utilisateur existant
              }
            );
          } else {
            // Créer un nouvel utilisateur
            db.query(
              `INSERT INTO users (device_id, expo_push_token, device_model, os_version, app_version) 
               VALUES (?, ?, ?, ?, ?)`,
              [device_id, expo_push_token, device_model, os_version, app_version],
              (insertErr, result) => {
                if (insertErr) return reject(insertErr);
                
                // Récupérer l'utilisateur créé
                db.query(
                  "SELECT * FROM users WHERE id = ?",
                  [result.insertId],
                  (selectErr, newUser) => {
                    if (selectErr) return reject(selectErr);
                    resolve(newUser[0]);
                  }
                );
              }
            );
          }
        }
      );
    });
  }

  // Trouver un utilisateur par ID
  static async findById(userId) {
    return new Promise((resolve, reject) => {
      db.query(
        "SELECT id, device_id, created_at, last_seen FROM users WHERE id = ?",
        [userId],
        (err, results) => {
          if (err) return reject(err);
          resolve(results[0] || null);
        }
      );
    });
  }

  // Trouver tous les utilisateurs (pour liste de contacts)
  static async findAll(excludeUserId = null) {
    return new Promise((resolve, reject) => {
      let sql = "SELECT id, device_id, created_at, last_seen FROM users";
      const params = [];
      
      if (excludeUserId) {
        sql += " WHERE id != ?";
        params.push(excludeUserId);
      }
      
      sql += " ORDER BY last_seen DESC";
      
      db.query(sql, params, (err, results) => {
        if (err) return reject(err);
        resolve(results);
      });
    });
  }
}

module.exports = User;