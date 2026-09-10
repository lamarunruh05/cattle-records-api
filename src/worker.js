import { neon } from "@neondatabase/serverless";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      try {
        const sql = neon(env.DATABASE_URL);
        const rows = await sql`
          SELECT name, created_at
          FROM farms
          ORDER BY created_at
          LIMIT 1
        `;

        return json({
          ok: true,
          message: "Cattle Records API connected to Neon",
          farm: rows[0] ?? null
        });
      } catch (error) {
        console.error(error);
        return json({
          ok: false,
          message: "Cattle Records API could not connect to Neon",
          error: error?.message ?? String(error)
        }, 500);
      }
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
};
