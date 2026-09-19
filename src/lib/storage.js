/* Remplace l'API window.storage fournie par Claude Artifacts (stockage côté
   plateforme) par une implémentation équivalente basée sur localStorage — un seul
   appareil par défaut, aucun serveur nécessaire.

   Même signature que l'originale (get/set/delete/list, tous asynchrones), donc
   App.jsx n'a rien à changer : il continue d'appeler window.storage.get(...) etc.
   exactement comme avant.

   SYNCHRONISATION MULTI-APPAREILS (optionnelle) : quand un "code de synchro" est
   configuré (voir window.sync ci-dessous), chaque set()/delete() se répercute AUSSI
   vers Supabase en arrière-plan (fire-and-forget, n'attend pas la réponse pour ne
   jamais ralentir l'app) — localStorage reste la source de vérité IMMÉDIATE (lecture
   toujours locale, instantanée), Supabase sert uniquement de copie miroir pour que les
   autres appareils puissent la récupérer.

   Clé "anon public" volontairement en clair ici : c'est sa fonction (protégée par les
   policies RLS côté Supabase, pas un secret) — même principe qu'une clé API Stripe
   "publishable" ou Firebase côté client. */
const SUPABASE_URL = "https://qwbwrsxccaojmjlfpjaz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3Yndyc3hjY2Fvam1qbGZwamF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NzI1ODUsImV4cCI6MjEwNTM0ODU4NX0.0BxBiDc-fZpEeRkO8eOmCuPeDwSdy4u70-dAbmPO1sg";
const SYNC_CODE_KEY = "arc_sync_code";
const REST_URL = `${SUPABASE_URL}/rest/v1/sync_data`;
const REST_HEADERS = {
  "Content-Type": "application/json",
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

function getSyncCode() {
  try {
    return localStorage.getItem(SYNC_CODE_KEY) || null;
  } catch (e) {
    return null;
  }
}

/* Pousse une paire clé/valeur vers Supabase pour le code actif — silencieux en cas
   d'échec (pas de connexion, etc.) : l'app continue de fonctionner en local seul. */
async function remotePush(key, value) {
  const code = getSyncCode();
  if (!code) return;
  try {
    await fetch(`${REST_URL}?on_conflict=code,key`, {
      method: "POST",
      headers: { ...REST_HEADERS, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ code, key, value, updated_at: new Date().toISOString() }),
    });
  } catch (e) {
    /* pas de réseau ou Supabase indisponible — on continue en local seul */
  }
}

async function remoteDelete(key) {
  const code = getSyncCode();
  if (!code) return;
  try {
    await fetch(`${REST_URL}?code=eq.${encodeURIComponent(code)}&key=eq.${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: REST_HEADERS,
    });
  } catch (e) {
    /* silencieux */
  }
}

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
      remotePush(key, value); // fire-and-forget, ne bloque jamais l'écriture locale
      return { key, value, shared: false };
    } catch (e) {
      return null;
    }
  },

  async delete(key /*, shared */) {
    try {
      localStorage.removeItem(PREFIX + key);
      remoteDelete(key);
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

/* API de synchronisation, séparée de window.storage — utilisée uniquement par
   l'écran de réglages "Synchronisation" (configuration ponctuelle, pas à chaque
   lecture/écriture). */
window.sync = {
  getCode: getSyncCode,

  setCode(code) {
    try {
      if (code) localStorage.setItem(SYNC_CODE_KEY, code);
      else localStorage.removeItem(SYNC_CODE_KEY);
      return true;
    } catch (e) {
      return false;
    }
  },

  /* Envoie ce qui est en local vers ce code Supabase — SANS écraser ce qui existe déjà
     sur le serveur : pour les listes à id (matchs sauvegardés, historique de paris), va
     d'abord chercher la version serveur, fusionne avec la version locale, puis renvoie
     la fusion (et la réécrit aussi en local, pour que cet appareil récupère au passage
     ce qui n'existait que côté serveur). Utilisable sans risque depuis n'importe quel
     appareil, à n'importe quel moment, même par erreur à la place de "Récupérer" — les
     deux boutons ont le même résultat sûr : plus aucune donnée ne peut être perdue par
     un simple mauvais clic. */
  async pushAll() {
    const code = getSyncCode();
    if (!code) return { ok: false, error: "Aucun code de synchro configuré." };
    const MERGE_BY_ID_KEYS = ["arc_matches_v1", "arc_bets_v1"];
    const keys = safeParseKeys("");
    let sent = 0;
    for (const key of keys) {
      const localValue = localStorage.getItem(PREFIX + key);
      if (localValue === null) continue;
      let valueToSend = localValue;
      if (MERGE_BY_ID_KEYS.includes(key)) {
        try {
          const res = await fetch(`${REST_URL}?code=eq.${encodeURIComponent(code)}&key=eq.${encodeURIComponent(key)}&select=value`, { headers: REST_HEADERS });
          if (res.ok) {
            const rows = await res.json();
            if (rows.length) {
              let remoteList = [];
              let localList = [];
              try {
                remoteList = JSON.parse(rows[0].value) || [];
              } catch (e) {
                remoteList = [];
              }
              try {
                localList = JSON.parse(localValue) || [];
              } catch (e) {
                localList = [];
              }
              const byId = new Map();
              [...remoteList, ...localList].forEach((item) => {
                if (item && item.id !== undefined) byId.set(item.id, item);
              });
              const mergedList = Array.from(byId.values());
              valueToSend = JSON.stringify(mergedList);
              localStorage.setItem(PREFIX + key, valueToSend); // cet appareil récupère aussi ce qui manquait
            }
          }
        } catch (e) {
          /* pas de version serveur accessible — on enverra la version locale telle quelle */
        }
      }
      try {
        await fetch(`${REST_URL}?on_conflict=code,key`, {
          method: "POST",
          headers: { ...REST_HEADERS, Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({ code, key, value: valueToSend, updated_at: new Date().toISOString() }),
        });
        sent++;
      } catch (e) {
        return { ok: false, error: "Connexion perdue en cours d'envoi — réessaie.", sent };
      }
    }
    return { ok: true, sent };
  },

  /* Nouvel appareil AVEC des données locales à préserver : fusionne au lieu d'écraser.
     Pour les deux listes qui comptent vraiment (matchs sauvegardés, historique de
     paris), chaque entrée a un "id" unique — on garde toutes les entrées des DEUX
     côtés (locale + serveur), sans doublon par id, puis on réécrit le résultat fusionné
     aussi bien en local que sur le serveur (pour que les autres appareils profitent
     aussi de la fusion). Le brouillon en cours (arc_draft_v1) n'est PAS un id de
     merge possible (c'est un objet unique, pas une liste) : celui-là reste tel quel en
     local, on ne touche pas au travail en cours sur cet appareil. */
  async pullAll() {
    const code = getSyncCode();
    if (!code) return { ok: false, error: "Aucun code de synchro configuré." };
    try {
      const res = await fetch(`${REST_URL}?code=eq.${encodeURIComponent(code)}&select=key,value`, { headers: REST_HEADERS });
      if (!res.ok) return { ok: false, error: `Erreur serveur (${res.status})` };
      const rows = await res.json();
      const MERGE_BY_ID_KEYS = ["arc_matches_v1", "arc_bets_v1"];
      let merged = 0;
      let untouched = 0;
      for (const r of rows) {
        if (MERGE_BY_ID_KEYS.includes(r.key)) {
          let remoteList = [];
          let localList = [];
          try {
            remoteList = JSON.parse(r.value) || [];
          } catch (e) {
            remoteList = [];
          }
          try {
            const localRaw = localStorage.getItem(PREFIX + r.key);
            localList = localRaw ? JSON.parse(localRaw) || [] : [];
          } catch (e) {
            localList = [];
          }
          const byId = new Map();
          [...remoteList, ...localList].forEach((item) => {
            if (item && item.id !== undefined) byId.set(item.id, item);
          });
          const mergedList = Array.from(byId.values());
          localStorage.setItem(PREFIX + r.key, JSON.stringify(mergedList));
          // renvoie la fusion vers le serveur pour que les autres appareils en profitent aussi
          try {
            await fetch(`${REST_URL}?on_conflict=code,key`, {
              method: "POST",
              headers: { ...REST_HEADERS, Prefer: "resolution=merge-duplicates" },
              body: JSON.stringify({ code, key: r.key, value: JSON.stringify(mergedList), updated_at: new Date().toISOString() }),
            });
          } catch (e) {
            /* la fusion locale a quand même réussi, seul le renvoi serveur a échoué */
          }
          merged++;
        } else {
          // arc_draft_v1 (ou toute autre clé future qui n'est pas une liste avec id) :
          // on ne touche pas au brouillon en cours sur cet appareil
          untouched++;
        }
      }
      return { ok: true, merged, untouched };
    } catch (e) {
      return { ok: false, error: "Impossible de contacter le serveur de synchro." };
    }
  },
};
