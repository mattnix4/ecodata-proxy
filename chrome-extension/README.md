# Extension Chrome EcoData

## Configuration de déploiement

Modifier `config.js` avant d’empaqueter l’extension :

```js
self.ECODATA_CONFIG = {
  proxyHost: "proxy.example.com",
  proxyPort: 8081,
  dashboardUrl: "https://dashboard.example.com"
};
```

Les valeurs locales par défaut sont `127.0.0.1:8081` pour le proxy et `http://127.0.0.1:8082` pour le dashboard.

Pour un déploiement distant, le serveur écoute par défaut sur `0.0.0.0` pour
les ports `8081` et `8082`. Construisez l’extension avec l’adresse réellement
joignable par Chrome dans `config.js` :

```js
self.ECODATA_CONFIG = {
  proxyHost: "proxy.example.com",
  proxyPort: 8081,
  dashboardUrl: "https://ecodata.example.com"
};
```

Le dashboard HTTP (`8082`) peut être publié derrière un reverse proxy HTTPS
classique. Le proxy navigateur (`8081`) doit accepter la méthode `CONNECT` :
utilisez une exposition TCP/stream ou un forward proxy compatible, pas une
simple route HTTP d’un reverse proxy. Faites suivre les en-têtes personnalisés
`X-EcoData-*` et `Authorization` vers le dashboard.

Le nom d’hôte défini dans `dashboardUrl` est automatiquement ajouté à la liste
de contournement Chrome, comme `localhost` et `127.0.0.1`. Les appels de
connexion et de statistiques ne repassent donc jamais par le proxy EcoData.

## Installation locale

1. Ouvrir `chrome://extensions` dans Chrome.
2. Activer **Mode développeur**.
3. Cliquer **Charger l’extension non empaquetée** et sélectionner ce dossier.
4. Ouvrir l’extension, saisir l’identifiant et le mot de passe proxy créés dans le dashboard administrateur, puis l’adresse du serveur EcoData (port `8081` par défaut).

Pour les sites HTTPS, le certificat racine EcoData doit toujours être installé sur la machine cliente. L’extension configure le proxy et son authentification, mais Chrome n’autorise pas une extension à installer silencieusement une autorité de certification.

En production, déployer le proxy sur une adresse accessible aux clients et limiter son port par pare-feu. Les identifiants sont stockés dans `chrome.storage.local` du profil Chrome et effacés lors de la déconnexion.

## DNS et confidentialité

Pour les requêtes HTTP et HTTPS proxifiées, Chrome transmet le nom d’hôte au proxy EcoData : la résolution de la destination est donc effectuée côté proxy. Pendant la connexion, l’extension désactive aussi la prédiction réseau/prélecture DNS et bloque l’UDP WebRTC non proxifié afin de limiter les fuites DNS et IP. Ces réglages sont libérés à la déconnexion.

Une extension Chrome ne peut pas intercepter les requêtes DNS du système d’exploitation ni imposer sa configuration Secure DNS/DoH. Les autres applications de la machine restent hors du tunnel EcoData.
