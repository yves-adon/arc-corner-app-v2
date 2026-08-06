// Proxy côté serveur vers l'API publique ClubElo (http://api.clubelo.com) sur VERCEL
// Version optimisée pour les noms complexes avec slashs ou accents (ex: Bodø/Glimt)

export default async function handler(req, res) {
  // Sur Vercel, on récupère les paramètres de l'URL via req.query
  let team = req.query && req.query.team;

  if (!team) {
    return res.status(400).send("Paramètre 'team' manquant, ex. ?team=Bodo/Glimt");
  }

  try {
    // 1. Remplacement des caractères accentués scandinaves/européens fréquents
    team = team.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // Supprime les accents standards
    team = team.replace(/ø/g, "o").replace(/Ø/g, "O");          // Gère le ø spécifique
    team = team.replace(/æ/g, "ae").replace(/Æ/g, "AE");
    team = team.replace(/å/g, "a").replace(/Å/g, "A");

    // 2. Nettoyage des séparateurs : supprime les slashes (/), tirets, espaces et caractères spéciaux
    // "Bodø/Glimt" ou "Bodo / Glimt" devient "BodoGlimt"
    team = team.replace(/[\s\/\-\_\.\,\'\’]/g, ""); 

    // Configuration de l'URL ClubElo
    const url = `http://api.clubelo.com/${team}`;

    const apiResponse = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3"
      }
    });

    if (!apiResponse.ok) {
      throw new Error(`ClubElo a répondu avec un statut ${apiResponse.status} pour le club nettoyé en '${team}'`);
    }

    const text = await apiResponse.text();

    // Configuration des en-têtes de réponse sur Vercel
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");

    // Envoi des données CSV à l'application React
    return res.status(200).send(text);

  } catch (e) {
    console.error("Erreur proxy ClubElo:", e.message);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(502).send(`Erreur en contactant ClubElo — réessaie dans un instant. (Détail: ${e.message})`);
  }
}
