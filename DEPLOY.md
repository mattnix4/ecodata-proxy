# Déploiement EcoData derrière Nginx

Le serveur EcoData écoute par défaut sur toutes les interfaces :

- `0.0.0.0:8081` : proxy HTTP/MITM utilisé par Chrome, y compris pour les tunnels HTTPS `CONNECT` ;
- `0.0.0.0:8082` : dashboard et API HTTP.

Le dashboard peut être publié derrière un reverse proxy HTTPS classique. Le
port proxy doit être exposé directement ou relayé au niveau TCP.

## Dashboard et API en HTTPS

Exemple pour `ecodata.example.com` :

```nginx
server {
    listen 80;
    server_name ecodata.example.com;

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ecodata.example.com;

    ssl_certificate     /etc/letsencrypt/live/ecodata.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ecodata.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8082;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Authentification dashboard
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Client-Id   $http_x_client_id;

        # Authentification extension
        proxy_set_header X-EcoData-User     $http_x_ecodata_user;
        proxy_set_header X-EcoData-Password $http_x_ecodata_password;
        proxy_set_header X-EcoData-Device   $http_x_ecodata_device;

        proxy_connect_timeout 10s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;

        # Ne jamais mettre en cache les réponses API.
        proxy_no_cache 1;
        proxy_cache_bypass 1;
    }
}
```

Les variables Nginx `$http_*` utilisent des underscores à la place des tirets
des en-têtes HTTP. Par exemple, `X-EcoData-User` devient
`$http_x_ecodata_user`.

Évitez de journaliser `X-EcoData-Password`, `Authorization` ou les identifiants
de session. La configuration standard des logs Nginx ne journalise pas ces
en-têtes.

## Relais TCP du proxy Chrome

Le port `8081` ne doit pas être placé dans une simple route HTTP Nginx. Chrome
y envoie aussi la méthode `CONNECT`. Utilisez le module Nginx `stream` :

```nginx
stream {
    upstream ecodata_proxy {
        server 127.0.0.1:8081;
    }

    server {
        listen 8081;
        proxy_connect_timeout 10s;
        proxy_timeout 10m;
        proxy_pass ecodata_proxy;
    }
}
```

Selon l'installation Nginx, le bloc `stream` doit se trouver dans
`/etc/nginx/nginx.conf` ou dans un fichier inclus au niveau principal, et non
à l'intérieur du bloc `http`.

Le port `8081` doit être protégé par le pare-feu et accessible uniquement aux
clients autorisés. Les comptes EcoData restent obligatoires, mais ne remplacent
pas une politique réseau restrictive.

## Configuration de l'extension

Avant de distribuer l'extension, configurez
`chrome-extension/config.js` avec les adresses publiques :

```js
self.ECODATA_CONFIG = {
  proxyHost: "proxy.example.com",
  proxyPort: 8081,
  dashboardUrl: "https://ecodata.example.com"
};
```

`proxyHost` contient uniquement un nom d'hôte, sans `http://` ou `https://`.
`dashboardUrl` contient au contraire l'URL HTTPS complète, sans slash final
obligatoire.

## Certificat MITM

Chaque poste client doit installer et approuver le certificat racine EcoData.
Il est disponible depuis le dashboard :

```text
https://ecodata.example.com/ca.pem
```

N'installez ce certificat que sur des appareils administrés et autorisés. La
clé privée de l'autorité EcoData ne doit jamais quitter le serveur.

## Validation

Vérifiez et rechargez Nginx :

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Testez le dashboard :

```bash
curl -i https://ecodata.example.com/
```

Testez la transmission des en-têtes de connexion de l'extension :

```bash
curl -i -X POST https://ecodata.example.com/api/extension/login \
  -H "X-EcoData-User: USERNAME" \
  -H "X-EcoData-Password: PASSWORD" \
  -H "X-EcoData-Device: test-device"
```

Une réponse `200` contenant `clientId` et `proxySession` confirme que la route
et les en-têtes fonctionnent. Une réponse `401` indique des identifiants
incorrects ou des en-têtes supprimés par un intermédiaire.

### CORS de l'extension

Le serveur répond directement aux préflights `OPTIONS` des origines Chrome
`chrome-extension://...` sur `/api/extension/*`. Il autorise uniquement les
méthodes et en-têtes nécessaires à EcoData. N'ajoutez pas
`Access-Control-Allow-Origin: *` dans Nginx.

En production, vous pouvez limiter CORS à l'identifiant exact de l'extension :

```bash
EXTENSION_ORIGINS=chrome-extension://IDENTIFIANT_EXTENSION npm start
```

Plusieurs extensions peuvent être indiquées en les séparant par une virgule.

Testez enfin le port proxy depuis un poste client :

```bash
curl -v --proxy http://proxy.example.com:8081 https://example.com/
```

Pour ce dernier test, le client doit fournir une session proxy valide générée
par l'extension et faire confiance au certificat racine EcoData.

## Variables serveur facultatives

Les valeurs d'écoute peuvent être remplacées au démarrage :

```bash
PROXY_HOST=0.0.0.0 MITM_PORT=8081 \
DASHBOARD_HOST=0.0.0.0 STATS_PORT=8082 \
npm start
```

Sous PowerShell :

```powershell
$env:PROXY_HOST = "0.0.0.0"
$env:MITM_PORT = "8081"
$env:DASHBOARD_HOST = "0.0.0.0"
$env:STATS_PORT = "8082"
npm start
```

Documentation Nginx :

- [Module HTTP proxy](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
- [Module stream](https://nginx.org/en/docs/stream/ngx_stream_core_module.html)
