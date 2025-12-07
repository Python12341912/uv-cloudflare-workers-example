const WORKER_BASE = ""; // leave empty for workers.dev root; or set like "/service/"
const ROUTE_PREFIX = "/service/";

/**
 * Resolve relative URLs to absolute using a base.
 */
function resolveUrl(base, rel) {
  try {
    return new URL(rel, base).toString();
  } catch {
    return rel;
  }
}

/**
 * Encode target URL for path segment.
 */
function encodeTarget(u) {
  return encodeURIComponent(u);
}

/**
 * Build proxied URL path for a target.
 */
function toProxiedPath(target) {
  return `${ROUTE_PREFIX}${encodeTarget(target)}`;
}

/**
 * Basic HTML rewrite: update href/src/action attributes to route through the Worker.
 */
function htmlRewriter(targetOrigin) {
  const rw = new HTMLRewriter()
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) return;
        const abs = resolveUrl(targetOrigin, href);
        el.setAttribute('href', toProxiedPath(abs));
      }
    })
    .on('link[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) return;
        const abs = resolveUrl(targetOrigin, href);
        el.setAttribute('href', toProxiedPath(abs));
      }
    })
    .on('script[src]', {
      element(el) {
        const src = el.getAttribute('src');
        if (!src) return;
        const abs = resolveUrl(targetOrigin, src);
        el.setAttribute('src', toProxiedPath(abs));
      }
    })
    .on('img[src]', {
      element(el) {
        const src = el.getAttribute('src');
        if (!src) return;
        const abs = resolveUrl(targetOrigin, src);
        el.setAttribute('src', toProxiedPath(abs));
      }
    })
    .on('form[action]', {
      element(el) {
        const action = el.getAttribute('action');
        if (!action) return;
        const abs = resolveUrl(targetOrigin, action);
        el.setAttribute('action', toProxiedPath(abs));
        // Force target to _self so it stays in the proxied context
        el.setAttribute('target', '_self');
      }
    });

  return rw;
}

/**
 * Loosen or strip problematic headers so pages render.
 */
function sanitizeHeaders(headers, contentTypeIsHtml) {
  const h = new Headers(headers);

  // Remove strict CSP that blocks rendering within proxy context
  if (h.has('content-security-policy')) h.delete('content-security-policy');
  if (h.has('content-security-policy-report-only')) h.delete('content-security-policy-report-only');

  // CORS: allow same-origin from the worker URL
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-headers', '*');
  h.set('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  // Disable frame options that could blank pages
  if (h.has('x-frame-options')) h.delete('x-frame-options');

  // Some sites set nosniff that can interfere in transformed contexts
  if (h.has('x-content-type-options')) h.delete('x-content-type-options');

  // Keep content-type intact; for HTML, ensure text/html charset is present
  if (contentTypeIsHtml) {
    const ct = h.get('content-type') || 'text/html; charset=utf-8';
    if (!/text\/html/i.test(ct)) h.set('content-type', 'text/html; charset=utf-8');
  }

  return h;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Health/info
    if (url.pathname === "/" || url.pathname === WORKER_BASE) {
      return new Response("Ultraviolet-style Worker: use /service/<encodedURL>", { status: 200 });
    }

    // Only handle /service/<encodedURL>
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      return new Response("Not found. Use /service/<encodedURL>", { status: 404 });
    }

    // Decode target
    const encoded = url.pathname.slice(ROUTE_PREFIX.length);
    if (!encoded) {
      return new Response("Missing encoded URL", { status: 400 });
    }

    let target;
    try {
      target = decodeURIComponent(encoded);
    } catch {
      return new Response("Bad encoded URL", { status: 400 });
    }

    // Prepare request to target
    // Forward method, headers, and body for non-GET/HEAD
    const init = {
      method: request.method,
      headers: request.headers,
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    // Avoid recursive calls to the worker itself
    if (target.startsWith(url.origin)) {
      return new Response("Refusing to proxy this origin", { status: 400 });
    }

    let resp;
    try {
      resp = await fetch(target, init);
    } catch (err) {
      return new Response(`Upstream fetch error: ${err}`, { status: 502 });
    }

    // Handle opaque/cors-restricted responses gracefully
    if (resp.type === "opaque") {
      return new Response("Opaque upstream response; try a different site", { status: 502 });
    }

    const ct = resp.headers.get('content-type') || '';
    const isHtml = ct.toLowerCase().includes('text/html');

    // Sanitize headers
    const safeHeaders = sanitizeHeaders(resp.headers, isHtml);

    // For HTML, rewrite URLs to pass back through /service/
    if (isHtml) {
      const targetOrigin = new URL(target).toString();
      const transformed = htmlRewriter(targetOrigin).transform(resp);
      return new Response(transformed.body, {
        status: resp.status,
        headers: safeHeaders
      });
    }

    // Otherwise stream as-is (CSS/JS/images/etc.)
    return new Response(resp.body, {
      status: resp.status,
      headers: safeHeaders
    });
  }
};
