# balatonrouting-feedback Worker

`POST /submit`: a balatonrouting.hu Visszajelzés űrlapjától JSON-t kap, és GitHub-jegyet nyit a `nagyb187/balatonroute` tárolóban.

| `type`     | Címke                                          |
|------------|------------------------------------------------|
| `bug`      | `hiba`                                         |
| `feedback` | `javaslat`                                     |
| `polar`    | `polár-kérés` (+ `publikálható-név`, ha `consent: true`) |

Válasz: `201 {"ok":true,"number":12,"url":"https://github.com/nagyb187/balatonroute/issues/12"}`, hiba esetén `{"ok":false,"error":"<kód>","message":"<magyar szöveg>"}`.

## Védelem

- **CORS / Origin:** csak az `https://balatonrouting.hu` origin. Minden más 403, még Turnstile és GitHub előtt.
- **Rate limit:** Workers Rate Limiting binding `SUBMIT_LIMITER`, 3 kérés / 60 s sózott IP-hashenként. Ha a binding hiányzik, a Worker fail-closed, és 503-at ad.
- **Napi plafon (opcionális KV):** `FEEDBACK_KV`, 10 / nap IP-hashenként és 150 / nap összesen.
- **Turnstile:** siteverify a `TURNSTILE_SECRET` kulccsal. A `hostname` csak `balatonrouting.hu` lehet, az `action` csak `submit`.
- **Bemenet:** a törzs legfeljebb 32 kB, a cím 120, a szöveg 4000, a CSV 20 kB. Vezérlő- és bidi-karakterek törlése. A HTML-t escape-eli, az `@említés` és a `#123` hivatkozás nem értesít, nem linkel. A beküldött szöveg idézetblokkba kerül. A polár CSV-t számokra normalizálja (kódblokk-injekció ellen). Honeypot mezőt is használ.
- **Titkok:** `GITHUB_TOKEN`, `TURNSTILE_SECRET` és `IP_SALT` csak `wrangler secret`. A GitHub hibaválaszát és a tokent nem adja vissza a kliensnek.
- **Adatok:** e-mail-címet nem gyűjt. IP-címet nem tárol, csak a sózott, naponta cserélődő hasht (`IP_SALT|UTC-dátum|IP`) a rate limithez (a KV-ben 2 nap TTL-lel).
- **Nyilvánosság:** `publicAck: true` kötelező (a „Megértettem, hogy a beküldés nyilvános lesz” jelölőnégyzet). Enélkül 400 `missing_public_ack`, még Turnstile és GitHub előtt.
- **Hajónév:** csak `consent: true` esetén kerül a jegybe (címbe és törzsbe) a `publikálható-név` címkével. Hozzájárulás nélkül a Worker eldobja, a böngésző el sem küldi.

## Teszt

```sh
cd worker
npm ci
npm test          # node:test, a GitHub és a Turnstile mockolva
npm run check     # wrangler deploy --dry-run (bundle + bindingek)
```

## Telepítés (Bence jóváhagyásával)

1. **Turnstile widget:** Cloudflare Dashboard → Turnstile → Add widget. Név `balatonrouting-feedback`, hostname `balatonrouting.hu`, mód Managed. A domainnek nem kell Cloudflare-zónának lennie. Ugyanez API-val:
   `POST /accounts/{account_id}/challenges/widgets` `{"name":"balatonrouting-feedback","domains":["balatonrouting.hu"],"mode":"managed"}`. Ez visszaadja a `sitekey`-t (nyilvános) és a `secret`-et (titkos).
2. **(Opcionális) KV:** `npx wrangler kv namespace create FEEDBACK_KV`. Az id-t írd a `wrangler.toml` kikommentezett blokkjába.
3. **Deploy:** `npx wrangler deploy`. Ezután a Worker elérhető: `https://balatonrouting-feedback.<subdomain>.workers.dev`. Titkok nélkül 503-at ad.
4. **Titkok:**
   ```sh
   printf %s "$BR_GITHUB_ISSUES_TOKEN" | npx wrangler secret put GITHUB_TOKEN
   printf %s "<turnstile secret>"     | npx wrangler secret put TURNSTILE_SECRET
   openssl rand -hex 32               | npx wrangler secret put IP_SALT
   ```
5. **Címkék:**
   ```sh
   gh label create "hiba"             --repo nagyb187/balatonroute --color d73a4a --description "Hibabejelentés"
   gh label create "javaslat"         --repo nagyb187/balatonroute --color a2eeef --description "Javaslat / visszajelzés"
   gh label create "polár-kérés"      --repo nagyb187/balatonroute --color 0e8a16 --description "Beküldött hajópolár"
   gh label create "publikálható-név" --repo nagyb187/balatonroute --color fbca04 --description "A hajónév közzétehető a polárlistában"
   ```
6. **Weboldal:** az `index.html`-ben a `js/feedback.js` script `data-turnstile-sitekey` attribútumába kerül a sitekey (ha más lett a Worker URL, akkor a `data-feedback-worker` is változik). Ezután commit és push a `main`-re.
7. **Ellenőrzés:**
   `curl -si -X OPTIONS -H 'Origin: https://balatonrouting.hu' https://balatonrouting-feedback.<subdomain>.workers.dev/submit` → 204. Utána egy próbabeküldés az élő oldalról, majd a próbajegy lezárása.
