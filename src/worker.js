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

      // GET /
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

      // GET /health
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

      // GET /api/cows
      if (url.pathname === "/api/cows" && request.method === "GET") {
        const farms = await sql`
          SELECT id
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        if (!farms.length) {
          return json({ ok: false, error: "No farm found" }, 404);
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

      // POST /api/cows
      if (url.pathname === "/api/cows" && request.method === "POST") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const brandNumber = String(body.brand_number || "").trim();

        if (!brandNumber) {
          return json({ ok: false, error: "brand_number is required" }, 400);
        }

        const farms = await sql`
          SELECT id
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        if (!farms.length) {
          return json({ ok: false, error: "No farm found" }, 404);
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
          RETURNING *
        `;

        return json(
          {
            ok: true,
            cow: inserted[0],
          },
          201
        );
      }

      // GET /api/calves?cow_id=UUID
      if (url.pathname === "/api/calves" && request.method === "GET") {
        const cowId = String(url.searchParams.get("cow_id") || "").trim();

        if (!cowId) {
          return json({ ok: false, error: "cow_id is required" }, 400);
        }

        const calves = await sql`
          SELECT
            id,
            cow_id,
            birth_month,
            birth_year,
            gender,
            color,
            is_dead,
            notes,
            created_by,
            created_at,
            updated_at
          FROM calves
          WHERE cow_id = ${cowId}
          ORDER BY birth_year DESC, birth_month DESC, created_at DESC
        `;

        return json({
          ok: true,
          count: calves.length,
          calves,
        });
      }

      // POST /api/calves
      if (url.pathname === "/api/calves" && request.method === "POST") {
        let body;

        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const cowId = String(body.cow_id || "").trim();
        const birthMonth = Number(body.birth_month);
        const birthYear = Number(body.birth_year);

        if (!cowId) {
          return json({ ok: false, error: "cow_id is required" }, 400);
        }

        if (
          !Number.isInteger(birthMonth) ||
          birthMonth < 1 ||
          birthMonth > 12
        ) {
          return json(
            { ok: false, error: "birth_month must be between 1 and 12" },
            400
          );
        }

        if (!Number.isInteger(birthYear) || birthYear < 1900) {
          return json(
            { ok: false, error: "birth_year is invalid" },
            400
          );
        }

        const cow = await sql`
          SELECT id
          FROM cows
          WHERE id = ${cowId}
          LIMIT 1
        `;

        if (!cow.length) {
          return json({ ok: false, error: "Cow not found" }, 404);
        }

        const calfId = crypto.randomUUID();
        const now = new Date().toISOString();

        const gender =
          body.gender && String(body.gender).trim()
            ? String(body.gender).trim()
            : null;

        const color =
          body.color && String(body.color).trim()
            ? String(body.color).trim()
            : null;

        const notes =
          body.notes && String(body.notes).trim()
            ? String(body.notes).trim()
            : null;

        const createdBy =
          body.created_by && String(body.created_by).trim()
            ? String(body.created_by).trim()
            : null;

        const isDead = Boolean(body.is_dead);

        const inserted = await sql`
          INSERT INTO calves (
            id,
            cow_id,
            birth_month,
            birth_year,
            gender,
            color,
            is_dead,
            notes,
            created_by,
            created_at,
            updated_at
          )
          VALUES (
            ${calfId},
            ${cowId},
            ${birthMonth},
            ${birthYear},
            ${gender},
            ${color},
            ${isDead},
            ${notes},
            ${createdBy},
            ${now},
            ${now}
          )
          RETURNING *
        `;

        return json(
          {
            ok: true,
            calf: inserted[0],
          },
          201
        );
      }

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
