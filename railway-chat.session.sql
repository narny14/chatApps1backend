-- Augmentez la taille de la colonne expo_push_token
ALTER TABLE users MODIFY COLUMN expo_push_token VARCHAR(255);

-- Ou si la colonne n'existe pas encore, créez-la
--ALTER TABLE users ADD COLUMN expo_push_token VARCHAR(255) NULL DEFAULT NULL;

-- Vérifiez la structure
DESCRIBE users;