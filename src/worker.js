import { neon } from "@neondatabase/serverless";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        },
      });
    }

    try {
      const sql = neon(env.DATABASE_URL);
      const url = new URL(request.url);

      // --------------------------------
      // GET /
      // Basic API / Neon connection test
      // --------------------------------
      if (url.pathname === "/" && request.method === "GET") {
        const farms = await sql`
          SELECT id, name, created_at
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        return json({
          ok: true,
          message: "Cattle Records API connected to Neon",
          farm: farms[0] || null,
        });
      }

      // --------------------------------
      // GET /health
      // --------------------------------
      if (url.pathname === "/health" && request.method === "GET") {
        const farms = await sql`
          SELECT id, name
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        return json({
          ok: true,
          database: "connected",
          farm: farms[0] || null,
        });
      }

      // --------------------------------
      // GET /api/cows
      // Return all cows for the farm
      // --------------------------------
      if (url.pathname === "/api/cows" && request.method === "GET") {
        const farms = await sql`
          SELECT id
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        if (!farms.length) {
          return json(
            {
              ok: false,
              error: "No farm found",
            },
            404
          );
        }

        const farmId = farms[0].id;

        const cows = await sql`
          SELECT
            id,
            farm_id,
            brand_number,
            owner_id,
            notes,
            created_by,
            created_at,
            updated_at
          FROM cows
          WHERE farm_id = ${farmId}
          ORDER BY
            CASE
              WHEN brand_number ~ '^[0-9]+$'
              THEN brand_number::integer
              ELSE NULL
            END,
            brand_number
        `;

        return json({
          ok: true,
          count: cows.length,
          cows,
        });
      }

      // --------------------------------
      // POST /api/cows
      // Add a new cow
      // --------------------------------
      if (url.pathname === "/api/cows" && request.method === "POST") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json(
            {
              ok: false,
              error: "Invalid JSON body",
            },
            400
          );
        }

        const brandNumber = String(body.brand_number || "").trim();

        if (!brandNumber) {
          return json(
            {
              ok: false,
              error: "brand_number is required",
            },
            400
          );
        }

        const farms = await sql`
          SELECT id
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        if (!farms.length) {
          return json(
            {
              ok: false,
              error: "No farm found",
            },
            404
          );
        }

        const farmId = farms[0].id;

        const existing = await sql`
          SELECT id
          FROM cows
          WHERE farm_id = ${farmId}
            AND brand_number = ${brandNumber}
          LIMIT 1
        `;

        if (existing.length) {
          return json(
            {
              ok: false,
              error: "A cow with that brand number already exists",
            },
            409
          );
        }

        const cowId = crypto.randomUUID();
        const now = new Date().toISOString();

        const ownerId =
          body.owner_id && String(body.owner_id).trim()
            ? String(body.owner_id).trim()
            : null;

        const notes =
          body.notes && String(body.notes).trim()
            ? String(body.notes).trim()
            : null;

        const createdBy =
          body.created_by && String(body.created_by).trim()
            ? String(body.created_by).trim()
            : null;

        const inserted = await sql`
          INSERT INTO cows (
            id,
            farm_id,
            brand_number,
            owner_id,
            notes,
            created_by,
            created_at,
            updated_at
          )
          VALUES (
            ${cowId},
            ${farmId},
            ${brandNumber},
            ${ownerId},
            ${notes},
            ${createdBy},
            ${now},
            ${now}
          )
          RETURNING
            id,
            farm_id,
            brand_number,
            owner_id,
            notes,
            created_by,
            created_at,
            updated_at
        `;

        return json(
          {
            ok: true,
            cow: inserted[0],
          },
          201
        );
      }

      // --------------------------------
      // 404
      // --------------------------------
      return json(
        {
          ok: false,
          error: "Not found",
        },
        404
      );
    } catch (error) {
      console.error(error);

      return json(
        {
          ok: false,
          error: "Internal server error",
          message: error?.message || "Unknown error",
        },
        500
      );
    }
  },
};
