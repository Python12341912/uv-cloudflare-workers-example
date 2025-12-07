export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Expect path like /service/<encoded target>
    if (url.pathname.startsWith("/service/")) {
      const target = decodeURIComponent(url.pathname.replace("/service/", ""));
      try {
        const resp = await fetch(target, {
          method: request.method,
          headers: request.headers,
          body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        });
        return resp;
      } catch (err) {
        return new Response("Error fetching target: " + err, { status: 500 });
      }
    }

    return new Response("Ultraviolet Worker running. Use /service/<url>", { status: 200 });
  }
}
