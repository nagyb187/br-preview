// Balaton Routing – Cloudflare Web Analytics betöltése, kikapcsolhatóan.
// Ha a böngésző localStorage-ában a 'br_no_analytics' kulcs értéke '1',
// a Cloudflare mérőkódja be sem töltődik (nincs kérés a cloudflareinsights.com felé).
// A kapcsoló az adatkezeles.html oldalon van (#meres).
(function () {
  var KEY = 'br_no_analytics';
  var self = document.currentScript;
  var token = self && self.getAttribute('data-cf-token');
  window.brAnalytics = {
    key: KEY,
    isOff: function () { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } },
    setOff: function (off) {
      try { if (off) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); return true; } catch (e) { return false; }
    }
  };
  if (!token || window.brAnalytics.isOff()) return;
  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.setAttribute('data-cf-beacon', JSON.stringify({ token: token }));
  document.head.appendChild(s);
})();
