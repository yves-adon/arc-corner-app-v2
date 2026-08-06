/* Remplace l'API window.storage fournie par Claude Artifacts (stockage côté
   plateforme) par une implémentation équivalente basée sur localStorage — un seul
   appareil, aucune synchronisation, aucun serveur nécessaire.

   Même signature que l'originale (get/set/delete/list, tous asynchrones), donc
   App.jsx n'a rien à changer : il continue d'appeler window.storage.get(...) etc.
   exactement comme avant. */

const PREFIX = "arc_corner_";

function safeParseKeys(prefix) {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const raw = localStorage.key(i);
    if (raw && raw.startsWith(PREFIX) ) {
      const shortKey = raw.slice(PREFIX.length);
      if (!prefix || shortKey.startsWith(prefix)) keys.push(shortKey);
    }
  }
  return keys;
}

window.storage = {
  async get(key /*, shared */) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return null;
      return { key, value: raw, shared: false };
    } catch (e) {
      return null;
    }
  },

  async set(key, value /*, shared */) {
    try {
      localStorage.setItem(PREFIX + key, value);
      return { key, value, shared: false };
    } catch (e) {
      return null;
    }
  },

  async delete(key /*, shared */) {
    try {
      localStorage.removeItem(PREFIX + key);
      return { key, deleted: true, shared: false };
    } catch (e) {
      return null;
    }
  },

  async list(prefix = "" /*, shared */) {
    try {
      return { keys: safeParseKeys(prefix), prefix, shared: false };
    } catch (e) {
      return null;
    }
  },
};
