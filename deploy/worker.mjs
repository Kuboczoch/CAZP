// Cloudflare Worker: odpowiedź dla terminala.
//
// `curl czyacerixxznalazlprace.pl` ma wypisać "Nie." i nic poza tym. Cała reszta
// świata — przeglądarki, wyszukiwarki, agenci AI — dostaje niezmieniony HTML
// z serwera, razem ze statycznym podsumowaniem generowanym przez
// tools/build-agent-files.mjs.
//
// Ten plik NIE jedzie rsynkiem na serwer (workflow wyklucza deploy/). Leży tu
// kopia kanoniczna, a na brzeg sieci trafia wklejona ręcznie w panelu
// Cloudflare — patrz DEPLOYMENT.md, sekcja "The terminal answer".

// Wąska lista: wyłącznie narzędzia uruchamiane ręcznie w terminalu. Świadomie
// nie ma tu python-requests, Go-http-client ani node-fetch — tak stronę pobierają
// boty i agenci AI, a tym należy się pełne statyczne podsumowanie, nie cztery
// bajty. Lista jest białą listą: cokolwiek nieznanego dostaje HTML jak dotąd.
const CLI_AGENTS = /\b(curl|wget|httpie|xh|lwp-request)\b/i;

const ANSWER = { pl: "Nie.\n", en: "No.\n" };

// Odpowiedź tekstowa. curl nie wysyła Accept-Language, więc domyślnie polski.
function plainAnswer(request) {
    const english = /^en\b/i.test(request.headers.get("accept-language") || "");
    const body = request.method === "HEAD" ? null : (english ? ANSWER.en : ANSWER.pl);
    return new Response(body, {
        headers: {
            "content-type": "text/plain; charset=utf-8",
            // Treść zależy od nagłówków klienta, a cache Cloudflare ignoruje
            // Vary — bez no-store dałoby się podać "Nie." przeglądarce.
            "cache-control": "no-store",
            "vary": "user-agent, accept, accept-language"
        }
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const accept = request.headers.get("accept") || "";
        const agent = request.headers.get("user-agent") || "";

        // 1. Kto prosi o HTML, dostaje HTML — przeglądarki odpadają zanim
        //    zajrzymy w User-Agent. To także furtka diagnostyczna:
        //    curl -H 'Accept: text/html' zwraca normalną stronę.
        const wantsHtml = accept.includes("text/html");
        const isCli = !wantsHtml && CLI_AGENTS.test(agent);
        const isRoot = url.pathname === "/" || url.pathname === "/index.html";
        const isRead = request.method === "GET" || request.method === "HEAD";

        // 2. Terminal pytający o stronę główną: cała odpowiedź to jedno słowo.
        //    Pozostałe ścieżki (/data/events.json, /llms.txt, /dlc/) bez zmian.
        if (isCli && isRoot && isRead) return plainAnswer(request);

        // 3. Przekierowanie na HTTPS robi ten Worker, a nie ustawienie
        //    "Always Use HTTPS" — tamto działa wcześniej niż Workers i odcięłoby
        //    curl-a od odpowiedzi powyżej. Musi zostać wyłączone w panelu.
        if (url.protocol === "http:") {
            url.protocol = "https:";
            return Response.redirect(url.toString(), 301);
        }

        return fetch(request);
    }
};
