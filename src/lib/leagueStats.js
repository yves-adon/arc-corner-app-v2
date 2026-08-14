/* Base multi-équipes persistante (via window.storage, donc localStorage sous le capot —
   voir storage.js) pour calculer une MOYENNE DE LIGUE de référence, comme les petits
   badges "54%"/"71%" qu'on voit sur les sites de paris à côté de chaque stat d'équipe.

   Principe : à chaque fois qu'une équipe est chargée/mise à jour dans l'appli (via
   ComparateurTab), on enregistre un résumé de ses stats buts (Vic/Nul/Déf, Clean sheet,
   BTTS, Over 2.5) sous une clé qui combine la ligue détectée et le nom de l'équipe. Pour
   afficher une moyenne de ligue, on liste toutes les équipes stockées sous cette même
   ligue et on agrège leurs compteurs bruts (pas une moyenne de pourcentages — une vraie
   moyenne pondérée par le nombre de matchs de chaque équipe, plus robuste).

   Aucune donnée n'est envoyée nulle part : tout reste en local sur l'appareil, comme le
   reste de l'appli (voir storage.js). La base se construit organiquement au fil de tes
   analyses — plus tu analyses d'équipes d'une même ligue, plus la moyenne devient fiable
   (d'où le seuil minTeams ci-dessous, pour ne jamais afficher une "moyenne" trompeuse
   calculée sur une ou deux équipes). */

const LEAGUE_PREFIX = "league-team:";

/* Normalise un nom (ligue ou équipe) en clé de stockage sûre — minuscules, sans accents,
   sans espaces ni caractères interdits par l'API de stockage (espaces, / \ ' "). */
export function slugify(str) {
  return (
    (str || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "inconnu"
  );
}

function leagueTeamKey(ligue, teamName) {
  return `${LEAGUE_PREFIX}${slugify(ligue)}:${slugify(teamName)}`;
}

/* Ligue "dominante" d'une équipe = la valeur la plus fréquente du champ `ligue` sur ses
   matchs saisis. La plupart des équipes n'ont qu'une seule compétition principale dans
   leur historique ; en cas de mélange (coupe + championnat par ex.), on prend la plus
   représentée plutôt que de deviner. */
export function dominantLigue(matches) {
  const counts = {};
  (matches || []).forEach((m) => {
    const l = (m.ligue || "").trim();
    if (!l) return;
    counts[l] = (counts[l] || 0) + 1;
  });
  let best = null;
  let bestCount = 0;
  Object.entries(counts).forEach(([l, c]) => {
    if (c > bestCount) {
      best = l;
      bestCount = c;
    }
  });
  return best;
}

/* Enregistre le résumé buts d'UNE équipe (comptes bruts, pas des %, pour permettre une
   agrégation pondérée correcte côté lecture) sous sa ligue dominante. Best-effort : une
   erreur de stockage ne doit jamais interrompre l'appli, donc on avale silencieusement
   les échecs — la moyenne de ligue est un bonus d'affichage, pas une donnée critique. */
export async function saveTeamLeagueStats(ligue, teamName, { vndButs, csButs, bttsButs, ouButs25 }) {
  if (!ligue || !teamName || !vndButs || !vndButs.n) return;
  const record = {
    teamName,
    ligue,
    updatedAt: Date.now(),
    n: vndButs.n,
    vic: vndButs.vic,
    nul: vndButs.nul,
    def: vndButs.def,
    csN: csButs ? csButs.n : 0,
    cs: csButs ? csButs.cs : 0,
    bttsN: bttsButs ? bttsButs.n : 0,
    btts: bttsButs ? bttsButs.btts : 0,
    overN: ouButs25 ? ouButs25.n : 0,
    over: ouButs25 ? ouButs25.over : 0,
  };
  try {
    await window.storage.set(leagueTeamKey(ligue, teamName), JSON.stringify(record), false);
  } catch (e) {
    /* ignoré volontairement — voir commentaire ci-dessus */
  }
}

/* Moyenne de ligue agrégée sur toutes les équipes stockées pour cette ligue. Retourne
   null si la ligue n'a jamais été vue, ou { insufficient: true, nTeams } si trop peu
   d'équipes sont enregistrées pour qu'une moyenne soit honnête (seuil par défaut : 3).
   Les pourcentages sont pondérés par le nombre de matchs de chaque équipe (somme des
   compteurs bruts / somme des échantillons), pas une simple moyenne de pourcentages qui
   donnerait autant de poids à une équipe à 3 matchs qu'à une équipe à 30. */
export async function getLeagueAverage(ligue, minTeams = 3) {
  if (!ligue) return null;
  const prefix = `${LEAGUE_PREFIX}${slugify(ligue)}:`;
  try {
    const listRes = await window.storage.list(prefix, false);
    if (!listRes || !listRes.keys || !listRes.keys.length) return null;
    const records = [];
    for (const key of listRes.keys) {
      try {
        const res = await window.storage.get(key, false);
        if (res && res.value) records.push(JSON.parse(res.value));
      } catch (e) {
        /* entrée corrompue ou absente — on l'ignore, pas bloquant */
      }
    }
    if (records.length < minTeams) return { insufficient: true, nTeams: records.length };

    let n = 0, vic = 0, nCs = 0, cs = 0, nBtts = 0, btts = 0, nOver = 0, over = 0;
    records.forEach((r) => {
      n += r.n || 0;
      vic += r.vic || 0;
      nCs += r.csN || 0;
      cs += r.cs || 0;
      nBtts += r.bttsN || 0;
      btts += r.btts || 0;
      nOver += r.overN || 0;
      over += r.over || 0;
    });

    return {
      insufficient: false,
      nTeams: records.length,
      vicPct: n ? (vic / n) * 100 : null,
      csPct: nCs ? (cs / nCs) * 100 : null,
      bttsPct: nBtts ? (btts / nBtts) * 100 : null,
      overPct: nOver ? (over / nOver) * 100 : null,
    };
  } catch (e) {
    return null;
  }
}
