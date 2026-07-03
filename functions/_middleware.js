// functions/_middleware.js
// -----------------------------------------------------------------------------
// Injects the Microsoft Clarity analytics snippet into the <head> of every HTML
// page served by experiences.amoreparaiso.com (Cloudflare Pages).
//
// Why middleware instead of editing each page: the site is ~70 self-contained
// HTML files plus generated hubs. Injecting here means every current AND future
// page gets Clarity automatically — nothing to edit in the decks or the build
// scripts, and no risk of the generators double-injecting it.
//
// Scope: ALL pages, including the /private/ couple hubs. Clarity masks text
// content by default, so figures on the finances / guests-paid pages are not
// captured in recordings unless explicitly unmasked. (If you ever want a figure
// fully excluded, wrap it in an element with the `data-clarity-mask="true"`
// attribute.) See _Company/SOPs/Deck_Publishing_SOP.md.
//
// Project: "Amore Paraíso — Experiences" (separate from the main-site project).
// Runs before every request; only text/html responses are transformed, so the
// /api/interest JSON endpoint and static assets (images, robots.txt) pass
// through untouched. Wrapped in try/catch so a transform error can never take
// the site down.
// -----------------------------------------------------------------------------

const CLARITY_PROJECT_ID = "xgn83lvd4g";

const CLARITY_SNIPPET =
  "(function(c,l,a,r,i,t,y){" +
  "c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};" +
  't=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;' +
  "y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);" +
  '})(window, document, "clarity", "script", "' + CLARITY_PROJECT_ID + '");';

class ClarityInjector {
  element(element) {
    element.append(
      '<script type="text/javascript">' + CLARITY_SNIPPET + "</script>",
      { html: true }
    );
  }
}

export async function onRequest(context) {
  const response = await context.next();

  // Only inject into HTML documents; leave JSON/API and static assets alone.
  try {
    const ctype = response.headers.get("content-type") || "";
    if (!ctype.includes("text/html")) return response;
    if (!CLARITY_PROJECT_ID) return response;
    return new HTMLRewriter().on("head", new ClarityInjector()).transform(response);
  } catch (err) {
    // Never let analytics injection break the page.
    return response;
  }
}
