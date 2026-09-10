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

      // --------------------------------
      // Find the current farm
      // --------------------------------
      async function getFarm() {
        const farms = await sql`
          SELECT id, name, created_at
          FROM farms
          ORDER BY created_at ASC
          LIMIT 1
        `;

        return farms[0] || null;
      }

      // --------------------------------
      // GET /
      // --------------------------------
      if (pathname === "/" && request.method === "GET") {
        const farm = await getFarm();

        return json({
          ok: true,
          message: "Cattle Records API connected to Neon",
          farm,
        });
      }

      // --------------------------------
      // GET /health
      // --------------------------------
      if (pathname === "/health" && request.method === "GET") {
        const farm = await getFarm();

        return json({
          ok: true,
          database: "connected",
          farm,
        });
      }

      // ================================================================
      // COWS
      // ================================================================

      // --------------------------------
      // GET /api/cows
      // --------------------------------
      if (pathname === "/api/cows" && request.method === "GET") {
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
          WHERE farm_id = ${farm.id}
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
      // --------------------------------
      if (pathname === "/api/cows" && request.method === "POST") {
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

        const existing = await sql`
          SELECT id
          FROM cows
          WHERE farm_id = ${farm.id}
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

        const cowId = crypto.randomUUID();
        const now = new Date().toISOString();

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
            ${farm.id},
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
      // Match /api/cows/:id
      // --------------------------------
      const cowMatch = pathname.match(/^\/api\/cows\/([^/]+)$/);

      // --------------------------------
      // PUT /api/cows/:id
      // --------------------------------
      if (cowMatch && request.method === "PUT") {
        const cowId = decodeURIComponent(cowMatch[1]);

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

        const existingCow = await sql`
          SELECT *
          FROM cows
          WHERE id = ${cowId}
            AND farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!existingCow.length) {
          return json(
            {
              ok: false,
              error: "Cow not found",
            },
            404
          );
        }

        const current = existingCow[0];

        const brandNumber =
          body.brand_number !== undefined
            ? String(body.brand_number).trim()
            : current.brand_number;

        if (!brandNumber) {
          return json(
            {
              ok: false,
              error: "brand_number is required",
            },
            400
          );
        }

        const duplicate = await sql`
          SELECT id
          FROM cows
          WHERE farm_id = ${farm.id}
            AND brand_number = ${brandNumber}
            AND id <> ${cowId}
          LIMIT 1
        `;

        if (duplicate.length) {
          return json(
            {
              ok: false,
              error: "A cow with that brand number already exists",
            },
            409
          );
        }

        let ownerId = current.owner_id;

        if (body.owner_id !== undefined) {
          ownerId =
            body.owner_id && String(body.owner_id).trim()
              ? String(body.owner_id).trim()
              : null;
        }

        let notes = current.notes;

        if (body.notes !== undefined) {
          notes =
            body.notes && String(body.notes).trim()
              ? String(body.notes).trim()
              : null;
        }

        const now = new Date().toISOString();

        const updated = await sql`
          UPDATE cows
          SET
            brand_number = ${brandNumber},
            owner_id = ${ownerId},
            notes = ${notes},
            updated_at = ${now}
          WHERE id = ${cowId}
            AND farm_id = ${farm.id}
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

        return json({
          ok: true,
          cow: updated[0],
        });
      }

      // --------------------------------
      // DELETE /api/cows/:id
      // --------------------------------
      if (cowMatch && request.method === "DELETE") {
        const cowId = decodeURIComponent(cowMatch[1]);

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

        const deleted = await sql`
          DELETE FROM cows
          WHERE id = ${cowId}
            AND farm_id = ${farm.id}
          RETURNING id, brand_number
        `;

        if (!deleted.length) {
          return json(
            {
              ok: false,
              error: "Cow not found",
            },
            404
          );
        }

        return json({
          ok: true,
          deleted: deleted[0],
        });
      }

      // ================================================================
      // CALVES
      // ================================================================

      // --------------------------------
      // GET /api/calves?cow_id=UUID
      // --------------------------------
      if (pathname === "/api/calves" && request.method === "GET") {
        const cowId = String(
          url.searchParams.get("cow_id") || ""
        ).trim();

        if (!cowId) {
          return json(
            {
              ok: false,
              error: "cow_id is required",
            },
            400
          );
        }

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

        const cow = await sql`
          SELECT id
          FROM cows
          WHERE id = ${cowId}
            AND farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!cow.length) {
          return json(
            {
              ok: false,
              error: "Cow not found",
            },
            404
          );
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
          ORDER BY
            birth_year DESC,
            birth_month DESC,
            created_at DESC
        `;

        return json({
          ok: true,
          count: calves.length,
          calves,
        });
      }

      // --------------------------------
      // POST /api/calves
      // --------------------------------
      if (pathname === "/api/calves" && request.method === "POST") {
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

        const cowId = String(body.cow_id || "").trim();
        const birthMonth = Number(body.birth_month);
        const birthYear = Number(body.birth_year);

        if (!cowId) {
          return json(
            {
              ok: false,
              error: "cow_id is required",
            },
            400
          );
        }

        if (
          !Number.isInteger(birthMonth) ||
          birthMonth < 1 ||
          birthMonth > 12
        ) {
          return json(
            {
              ok: false,
              error: "birth_month must be between 1 and 12",
            },
            400
          );
        }

        if (
          !Number.isInteger(birthYear) ||
          birthYear < 1900 ||
          birthYear > 2200
        ) {
          return json(
            {
              ok: false,
              error: "birth_year is invalid",
            },
            400
          );
        }

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

        const cow = await sql`
          SELECT id
          FROM cows
          WHERE id = ${cowId}
            AND farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!cow.length) {
          return json(
            {
              ok: false,
              error: "Cow not found",
            },
            404
          );
        }

        const gender = normalizeGender(body.gender);

        if (gender === "__INVALID__") {
          return json(
            {
              ok: false,
              error: "gender must be Bull, Heifer, male, or female",
            },
            400
          );
        }

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

        const calfId = crypto.randomUUID();
        const now = new Date().toISOString();

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
          RETURNING
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
        `;

        return json(
          {
            ok: true,
            calf: inserted[0],
          },
          201
        );
      }

      // --------------------------------
      // Match /api/calves/:id
      // --------------------------------
      const calfMatch = pathname.match(/^\/api\/calves\/([^/]+)$/);

      // --------------------------------
      // PUT /api/calves/:id
      // --------------------------------
      if (calfMatch && request.method === "PUT") {
        const calfId = decodeURIComponent(calfMatch[1]);

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

        const existing = await sql`
          SELECT
            calves.*
          FROM calves
          JOIN cows ON cows.id = calves.cow_id
          WHERE calves.id = ${calfId}
            AND cows.farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!existing.length) {
          return json(
            {
              ok: false,
              error: "Calf not found",
            },
            404
          );
        }

        const current = existing[0];

        const birthMonth =
          body.birth_month !== undefined
            ? Number(body.birth_month)
            : current.birth_month;

        const birthYear =
          body.birth_year !== undefined
            ? Number(body.birth_year)
            : current.birth_year;

        if (
          !Number.isInteger(birthMonth) ||
          birthMonth < 1 ||
          birthMonth > 12
        ) {
          return json(
            {
              ok: false,
              error: "birth_month must be between 1 and 12",
            },
            400
          );
        }

        if (
          !Number.isInteger(birthYear) ||
          birthYear < 1900 ||
          birthYear > 2200
        ) {
          return json(
            {
              ok: false,
              error: "birth_year is invalid",
            },
            400
          );
        }

        let gender = current.gender;

        if (body.gender !== undefined) {
          gender = normalizeGender(body.gender);

          if (gender === "__INVALID__") {
            return json(
              {
                ok: false,
                error: "gender must be Bull, Heifer, male, or female",
              },
              400
            );
          }
        }

        let color = current.color;

        if (body.color !== undefined) {
          color =
            body.color && String(body.color).trim()
              ? String(body.color).trim()
              : null;
        }

        let notes = current.notes;

        if (body.notes !== undefined) {
          notes =
            body.notes && String(body.notes).trim()
              ? String(body.notes).trim()
              : null;
        }

        const isDead =
          body.is_dead !== undefined
            ? Boolean(body.is_dead)
            : current.is_dead;

        const now = new Date().toISOString();

        const updated = await sql`
          UPDATE calves
          SET
            birth_month = ${birthMonth},
            birth_year = ${birthYear},
            gender = ${gender},
            color = ${color},
            is_dead = ${isDead},
            notes = ${notes},
            updated_at = ${now}
          WHERE id = ${calfId}
          RETURNING
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
        `;

        return json({
          ok: true,
          calf: updated[0],
        });
      }

      // --------------------------------
      // DELETE /api/calves/:id
      // --------------------------------
      if (calfMatch && request.method === "DELETE") {
        const calfId = decodeURIComponent(calfMatch[1]);

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

        const existing = await sql`
          SELECT calves.id
          FROM calves
          JOIN cows ON cows.id = calves.cow_id
          WHERE calves.id = ${calfId}
            AND cows.farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!existing.length) {
          return json(
            {
              ok: false,
              error: "Calf not found",
            },
            404
          );
        }

        const deleted = await sql`
          DELETE FROM calves
          WHERE id = ${calfId}
          RETURNING id, cow_id
        `;

        return json({
          ok: true,
          deleted: deleted[0],
        });
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
