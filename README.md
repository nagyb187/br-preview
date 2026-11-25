# balatonroute

A [balatonrouting.hu](https://balatonrouting.hu) forrása: ingyenes vitorlás útvonaltervező a Balatonra.

## Visszajelzés és polár beküldése

- **GitHub-fiókkal:** [új jegy](https://github.com/nagyb187/balatonroute/issues/new/choose): Hibabejelentés, Javaslat / visszajelzés vagy Polár beküldése.
- **GitHub-fiók nélkül:** a balatonrouting.hu láblécében a **Visszajelzés** link (`#visszajelzes`). Az űrlap egy Cloudflare Workerhez küld (`worker/`), az nyitja meg a jegyet. A GitHub token kizárólag a Worker titkos tárolójában van, a weboldal kódjában nincs.
- **E-mailben:** info@nbsailing.hu

Minden beküldés **nyilvános** jegy lesz ebben a tárolóban.

## Polár CSV formátum

Sablon: [`polars/template.csv`](polars/template.csv)

```csv
TWA\TWS,6,8,10,12,14,16,20
52,4.87,5.76,6.41,6.73,6.87,6.92,6.96
60,5.16,6.07,6.62,6.90,7.05,7.12,7.15
...
```

- **Első sor (fejléc):** az első cella tetszőleges szöveg (pl. `TWA\TWS`), utána a **valós szélsebességek (TWS) csomóban**, szigorúan növekvő sorrendben, 0-nál nagyobb és legfeljebb 40.
- **További sorok:** az első cella a **valós szélszög (TWA) fokban** (0–180, szigorúan növekvő), utána a **hajósebesség csomóban** (0–25) az adott TWS-hez.
- **Üres cella:** nincs adat (pl. 40°-nál gyenge szélben).
- **Elválasztó:** vessző, pontosvessző vagy tabulátor. Pontosvesszőnél és tabulátornál tizedesvessző is jó (pl. Excel magyar beállítással: `52;4,87;5,76`).
- A `#`-tal kezdődő sorok megjegyzések.
- **Korlátok:** legfeljebb 60 szögsor, 40 szélsebesség-oszlop, 20 kB.
- A beküldéskor automatikus ellenőrzés fut. A hibás érték (nem szám, tartományon kívül, rossz sorrend) blokkol. A gyanús érték csak figyelmeztetés: 25° alatti haladás, a szél másfélszeresénél gyorsabb hajó, a szomszédos szögekhez képest kiugró érték, vagy erősödő szélben 20%-nál nagyobb lassulás.
- A tervező a rácsból számolja a legjobb cirkáló (élesen a szélnek) és hátszeles szögeket. Ha ismered a hajód optimális cirkálószögét, írd a megjegyzésbe.

A beküldött polár ellenőrzés és jóváhagyás után kerül a tervezőbe. A hajó neve csak akkor kerül a nyilvános jegybe és a polárlistába, ha a beküldő ehhez külön hozzájárult (`publikálható-név` címke); a webes űrlap hozzájárulás nélkül a nevet el sem küldi. A GitHubon közvetlenül nyitott jegynél a beírt név azonnal nyilvános.
