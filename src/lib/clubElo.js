
/* Récupère l'Elo actuel d'un club via le proxy Netlify (evite les soucis CORS d'un
   appel direct navigateur -> api.clubelo.com), et calcule une probabilité de match
   à partir de l'écart entre deux Elo.

   ClubElo renvoie un CSV avec l'historique complet d'Elo du club, une ligne par
   période (Rank,Club,Country,Level,Elo,From,To) — on ne garde que la DERNIÈRE ligne
   (période la plus récente = Elo actuel). */
export async function fetchClubElo(teamName) {
  const name = (teamName || "").trim();
  if (!name) return null;
  
  const res = await fetch(`/.netlify/functions/clubelo?team=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error("ClubElo indisponible");
  
  const text = await res.text();
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return null; // juste l'en-tête ou vide = club introuvable
  
  // Nettoyage des en-têtes pour supprimer les espaces ou caractères invisibles
  const header = lines[0].split(",").map((h) => h.trim().replace(/["'\r]/g, ""));
  const lastRow = lines[lines.length - 1].split(",").map((r) => r.trim());
  
  const get = (col, fallbackIdx) => {
    const idx = header.indexOf(col);
    // Si l'index dynamique échoue, on utilise l'index fixe standard du CSV de ClubElo
    const finalIdx = idx >= 0 ? idx : fallbackIdx;
    return lastRow[finalIdx];
  };

  // Index standards de ClubElo : Rank=0, Club=1, Country=2, Level=3, Elo=4, From=5, To=6
  const eloRaw = get("Elo", 4);
  const elo = parseFloat(eloRaw);
  
  if (Number.isNaN(elo)) return null;
  
  return {
    club: get("Club", 1) || name,
    country: get("Country", 2) || "",
    elo,
    from: get("From", 5) || "",
    to: get("To", 6) || "",
  };
}

/* Espérance de gain façon Elo (formule standard, identique aux échecs) : probabilité
   que l'équipe "home" ne perde pas face à "away", compte tenu de l'écart d'Elo et d'un
   bonus d'avantage du terrain (100 points est la valeur généralement citée en football,
   proche de ce que publie ClubElo). Ce n'est PAS la méthode exacte propriétaire de
   ClubElo pour son 1X2 (non publiée), donc à prendre comme une approximation
   raisonnable, pas une donnée officielle. */
export function computeEloMatchup(eloHome, eloAway, homeAdvantage = 100) {
  if (eloHome === null || eloAway === null || eloHome === undefined || eloAway === undefined) return null;
  const diff = eloHome + homeAdvantage - eloAway;
  const we = 1 / (1 + Math.pow(10, -diff / 400)); // dans [0,1] par construction

  // Approximation 1X2 : le nul est plus probable quand les deux équipes sont proches,
  // et s'amenuise quand l'écart se creuse — modèle simple à cloche, pas une donnée
  // ClubElo officielle.
  const pDraw = Math.max(0.06, 0.28 * Math.exp(-((diff / 200) ** 2)));
  const remaining = 1 - pDraw;
  const pHome = we * remaining;
  const pAway = (1 - we) * remaining;

  return {
    diff: eloHome - eloAway,
    diffWithHomeAdvantage: diff,
    we,
    pHome,
    pDraw,
    pAway,
  };
}
