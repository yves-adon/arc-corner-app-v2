// Proxy côté serveur vers l'API publique ClubElo (http://api.clubelo.com).
// Aucune clé nécessaire — l'API est déjà publique et gratuite. Ce proxy sert
// uniquement à éviter les soucis de CORS quand on appelle depuis le navigateur,
// puisqu'un appel serveur-à-serveur n'y est jamais soumis.
//
// Format Vercel (req/res) — différent du format Netlify (event/handler qui renvoie
// { statusCode, headers, body }). Si un jour tu repasses sur Netlify, il faut
// reprendre l'ancien format, pas juste déplacer ce fichier.

export default async function handler(req, res) {
  const team = req.query.team;

  if (!team) {
    res.status(400).send("Paramètre 'team' manquant, ex. ?team=Bodo/Glimt");
    return;
  }

  try {
    const url = `http://api.clubelo.com/${encodeURIComponent(team)}`;
    const response = await fetch(url);
    const text = await response.text();

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    // ClubElo est mis à jour une fois par jour — pas la peine de le réinterroger à
    // chaque clic, un court cache limite le nombre d'appels sortants
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(response.status).send(text);
  } catch (e) {
    res.status(502).send("Erreur en contactant ClubElo — réessaie dans un instant.");
  }
}
