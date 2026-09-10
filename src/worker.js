import { neon } from "@neondatabase/serverless";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function normalizeGender(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const raw = String(value).trim().toLowerCase();

  if (raw === "bull" || raw === "male") {
    return "male";
  }

  if (raw === "heifer" || raw === "female") {
    return "female";
  }

  return "__INVALID__";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    try {
      const sql = neon(env.DATABASE_URL);
      const url = new URL(request.url);
      const pathname = url.pathname;

      // ================================================================
      // CURRENT FARM
      // ================================================================

      async function getFarm() {
        const farms = await sql`
          SELECT id, name, created_at
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        return farms[0] || null;
      }

      // ================================================================
      // BASIC TESTS
      // ================================================================

      // GET /
      if (pathname === "/" && request.method === "GET") {
        const farm = await getFarm();

        return json({
          ok: true,
          message: "Cattle Records API connected to Neon",
          farm,
        });
      }

      // GET /health
      if (pathname === "/health" && request.method === "GET") {
        const farm = await getFarm();

        return json({
          ok: true,
          database: "connected",
          farm,
        });
      }

      // ================================================================
      // OWNERS
      // ================================================================

      // GET /api/owners
      if (pathname === "/api/owners" && request.method === "GET") {
        const farm = await getFarm();

        if (!farm) {
          return json(
            {
              ok: false,
              error: "No farm found",
            },
            404
          );
        }

        const owners = await sql`
          SELECT
            id,
            farm_id,
            name,
            created_at
          FROM owners
          WHERE farm_id = ${farm.id}
          ORDER BY LOWER(name), name
        `;

        return json({
          ok: true,
          count: owners.length,
          owners,
        });
     
