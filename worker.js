const ROUTE_PREFIX = "/service/";

function toProxiedPath(target) {
  return `${ROUTE_PREFIX}${encodeURIComponent(target)}`;
}

function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

function htmlRewriter(targetOrigin) {
  return new HTMLRewriter()
    // Anchor tags
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) return;
        el.setAttribute('href', toProxiedPath(resolveUrl(targetOrigin, href)));
      }
    })
    // Forms
    .on('form[action]', {
      element(el) {
        const action = el.getAttribute('action');
        if (!action) return;
        el.setAttribute('action', toProxiedPath(resolveUrl(targetOrigin, action)));
        el.setAttribute('target', '_self');
      }
    })
    // Iframes
    .on('iframe[src]', {
      element(el) {
        const src = el.getAttribute('src');
        if (!src) return;
        el.setAttribute('src', toProxiedPath(resolveUrl(targetOrigin, src)));
      }
    })
    // Images
    .on('img[src]', {
      element(el) {
        const src = el.getAttribute('src');
        if (!src) return;
        el.setAttribute('src', toProxiedPath(resolveUrl(targetOrigin, src)));
      }
    })
    // Responsive images: srcset
    .on('img[srcset], source[srcset]', {
      element(el) {
        const srcset = el.getAttribute('srcset');
        if (!srcset) return;
        const rewritten = srcset.split(',').map(part => {
          const [u, w] = part.trim().split(/\s+/);
          const abs = resolveUrl(targetOrigin, u);
          return `${toProxiedPath(abs)}${w ? " " + w : ""}`;
        }).join(', ');
        el.setAttribute('srcset', rewritten);
      }
    })
    // picture/source src
    .on('source[src]', {
      element(el) {
        const src = el.getAttribute('src');
        if (!src) return;
        el.setAttribute('src', toProxiedPath(resolveUrl(targetOrigin, src)));
      }
    })
    // Scripts
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src');
        if (!src) return;
        el.setAttribute('src', toProxiedPath(resolveUrl(targetOrigin, src)));
      }
    })
    // Stylesheets
    .on('link[rel="stylesheet"][href], link[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) return;
        el.setAttribute('href', toProxiedPath(resolveUrl(targetOrigin, href)));
      }
    })
    // Inline style url(...) (best-effort for style attributes)
    .on('[style]', {
      element(el) {
        const style = el.getAttribute('style');
        if (!style) return;
        const rewritten = style.replace(/url\((['"]?)([^'")]+)\1\)/g, (_m, _q, u) => {
          if (u.startsWith('data:')) return _m;
          const abs = resolveUrl(targetOrigin, u);
          return `url(${toProxiedPath(abs)})`;
        });
        el.setAttribute('style', rewritten);
      }
    })
    // Meta refresh
    .on('meta[http-equiv="refresh"]', {
      element(el) {
        const content = el.getAttribute('content');
        if (!content) return;
        const match = content.match(/\d+;\s*url=(.+)/i);
        if (match) {
          const abs = resolveUrl(targetOrigin, match[1]);
          el.setAttribute('content', content.replace(match[1], toProxiedPath(abs)));
        }
      }
    });
}

// Rewrite CSS url(...) including fonts/backgrounds
async function rewriteCss(resp, targetOrigin) {
  const cssText = await resp.text();
  const rewritten = cssText.replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, url) => {
    if (url.startsWith("data:")) return match;
    const abs = resolveUrl(targetOrigin, url);
    return `url(${toProxiedPath(abs)})`;
  });
  const headers = new Headers(resp.headers);
  headers.set("content-type", "text/css; charset=utf-8");
  sanitizeHeadersInPlace(headers);
  return new Response(rewritten, { status: resp.status, headers });
}

function sanitizeHeadersInPlace(h) {
  h.delete('content-security-policy');
  h.delete('content-security-policy-report-only');
  h.delete('x-frame-options');
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-headers', '*');
  h.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      return new Response("Boat Proxy Worker ready. Use /service/<encodedURL>", { status: 200 });
    }

    const encoded = url.pathname.slice(ROUTE_PREFIX.length);
    if (!encoded) return new Response("Missing encoded URL", { status: 400 });

    let target;
    try { target = decodeURIComponent(encoded); }
    catch { return new Response("Bad encoded URL", { status: 400 }); }

    // Prevent recursion (proxying the worker’s own origin)
    if (target.startsWith(url.origin)) {
      return new Response("Refusing to proxy worker origin", { status: 400 });
    }

    const init = {
      method: request.method,
      headers: request.headers,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (err) {
      return new Response("Upstream fetch error: " + err, { status: 502 });
    }

    const ct = upstream.headers.get('content-type') || '';
    const lowerCT = ct.toLowerCase();
    const headers = new Headers(upstream.headers);
    sanitizeHeadersInPlace(headers);

    if (lowerCT.includes('text/html')) {
      const rewritten = htmlRewriter(new URL(target).toString()).transform(upstream);
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(rewritten.body, { status: upstream.status, headers });
    }

    if (lowerCT.includes('text/css')) {
      return rewriteCss(upstream, new URL(target).toString());
    }

    // Stream other assets untouched with original content-type
    return new Response(upstream.body, { status: upstream.status, headers });
  }
};
