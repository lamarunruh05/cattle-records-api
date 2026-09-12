import { neon } from "@neondatabase/serverless";
import { createRemoteJWKSet, jwtVerify } from "jose";
import webpush from "web-push";

const NEON_AUTH_URL =
  "https://ep-lively-breeze-acpy4xfq.neonauth.sa-east-1.aws.neon.tech/neondb/auth";

const NEON_JWKS_URL =
  `${NEON_AUTH_URL}/.well-known/jwks.json`;

const neonJWKS = createRemoteJWKSet(
  new URL(NEON_JWKS_URL)
);

async function verifyAuth(request) {
  const authorization = request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  const token = authorization.slice(7).trim();

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, neonJWKS);

    return payload;
  } catch (error) {
    console.error("JWT verification failed:", error);
    return null;
  }
}

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

function createInviteToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env, ctx) {
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
      if (request.method === "OPTIONS") {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
      }
let authContext = null;

if (pathname.startsWith("/api/")) {
  const auth = await verifyAuth(request);

  if (!auth?.sub) {
    return json(
      {
        ok: false,
        error: "Not authenticated",
      },
      401
    );
  }

  const membership = await getFarmForUser(String(auth.sub));

  if (!membership) {
    return json(
      {
        ok: false,
        error: "No farm access",
      },
      403
    );
  }

  authContext = {
    userId: String(auth.sub),
    farmId: membership.farm_id,
    displayName:
      membership.display_name ||
      auth.name ||
      auth.email ||
      "User",
    role: membership.role,
    farmName: membership.farm_name,
  };
}
      // --------------------------------
      // Find the current farm
      // --------------------------------
      async function getFarmForUser(authUserId) {
  const memberships = await sql`
    SELECT
      fm.farm_id,
      fm.auth_user_id,
      fm.display_name,
      fm.role,
      f.name AS farm_name
    FROM farm_members fm
    JOIN farms f
      ON f.id = fm.farm_id
    WHERE fm.auth_user_id = ${authUserId}
    LIMIT 1
  `;

  return memberships[0] || null;
}
      
      async function getFarm() {
  if (!authContext?.farmId) {
    return null;
  }

  return {
    id: authContext.farmId,
    name: authContext.farmName,
  };
      }

      // --------------------------------
      // Write a cattle-record activity entry. Chat activity is intentionally excluded.
      // Logging errors are reported to Cloudflare but do not make a successful
      // cattle/owner change look like it failed to the user.
      // --------------------------------
      async function logActivity({
        entityType,
        entityId = null,
        action,
        description,
        details = null,
      }) {
        if (!authContext?.farmId || !authContext?.userId) {
          return;
        }

        try {
          const detailsJson = details ? JSON.stringify(details) : null;

          await sql`
            INSERT INTO activity_log (
              farm_id,
              auth_user_id,
              display_name,
              entity_type,
              entity_id,
              action,
              description,
              details
            )
            VALUES (
              ${authContext.farmId},
              ${authContext.userId},
              ${authContext.displayName},
              ${entityType},
              ${entityId},
              ${action},
              ${description},
              CAST(${detailsJson} AS jsonb)
            )
          `;
        } catch (error) {
          console.error("Activity log insert failed:", error);
        }
      }

      // --------------------------------
      // Send a Farm Chat push notification to every subscribed device
      // in this farm except devices belonging to the sender. Dead
      // browser subscriptions are removed automatically.
      // --------------------------------
      async function sendFarmChatPush({ messageId, messageText = null, isPhoto = false }) {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
          console.error("Push notification keys are not configured");
          return;
        }

        const subscriptions = await sql`
          SELECT id, endpoint, p256dh, auth_key
          FROM push_subscriptions
          WHERE farm_id = ${authContext.farmId}
            AND auth_user_id <> ${authContext.userId}
        `;

        if (!subscriptions.length) {
          return;
        }

        webpush.setVapidDetails(
          "https://lamarunruh05.github.io/cattle-records/",
          env.VAPID_PUBLIC_KEY,
          env.VAPID_PRIVATE_KEY
        );

        const cleanText = String(messageText || "").trim();
        const body = isPhoto
          ? (cleanText ? `Photo: ${cleanText}` : "Sent a photo")
          : cleanText;

        const payload = JSON.stringify({
          title: `${authContext.displayName} · Farm Chat`,
          body: body.length > 180 ? `${body.slice(0, 177)}...` : body,
          tag: `farm-chat-${messageId}`,
          data: {
            url: "/cattle-records/?open=chat",
            messageId,
          },
        });

        const deadEndpoints = [];

        await Promise.all(
          subscriptions.map(async (row) => {
            const subscription = {
              endpoint: row.endpoint,
              keys: {
                p256dh: row.p256dh,
                auth: row.auth_key,
              },
            };

            try {
              await webpush.sendNotification(subscription, payload);
            } catch (error) {
              const statusCode = Number(error?.statusCode || 0);
              if (statusCode === 404 || statusCode === 410) {
                deadEndpoints.push(row.endpoint);
              } else {
                console.error("Push notification failed:", error);
              }
            }
          })
        );

        if (deadEndpoints.length) {
          await Promise.all(
            deadEndpoints.map((endpoint) => sql`
              DELETE FROM push_subscriptions
              WHERE endpoint = ${endpoint}
            `)
          );
        }
      }

      function queueFarmChatPush(payload) {
        const task = sendFarmChatPush(payload).catch((error) => {
          console.error("Farm Chat push task failed:", error);
        });

        if (ctx && typeof ctx.waitUntil === "function") {
          ctx.waitUntil(task);
        }
      }

      // --------------------------------
      // Shared cow lists (for example: "Cull cows 2026").
      // Tables are created lazily the first time a list route is used so this
      // feature can be deployed without a separate SQL migration step.
      // --------------------------------
      async function ensureCowListTables() {
        await sql`
          CREATE TABLE IF NOT EXISTS cow_lists (
            id UUID PRIMARY KEY,
            farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            created_by TEXT,
            created_by_name TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `;

        await sql`
          CREATE UNIQUE INDEX IF NOT EXISTS cow_lists_farm_name_unique
          ON cow_lists (farm_id, LOWER(name))
        `;

        await sql`
          CREATE TABLE IF NOT EXISTS cow_list_items (
            list_id UUID NOT NULL REFERENCES cow_lists(id) ON DELETE CASCADE,
            cow_id UUID NOT NULL REFERENCES cows(id) ON DELETE CASCADE,
            added_by TEXT,
            added_by_name TEXT,
            added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (list_id, cow_id)
          )
        `;
      }

      async function getListForCurrentFarm(listId) {
        const rows = await sql`
          SELECT id, farm_id, name, created_by, created_by_name, created_at, updated_at
          FROM cow_lists
          WHERE id = ${listId}
            AND farm_id = ${authContext.farmId}
          LIMIT 1
        `;
        return rows[0] || null;
      }

      // ================================================================
      // COW LISTS
      // Shared by every user who belongs to this farm.
      // ================================================================

      // GET /api/lists
      // Returns all farm lists plus the cow IDs/brand numbers in each list.
      if (pathname === "/api/lists" && request.method === "GET") {
        await ensureCowListTables();

        const lists = await sql`
          SELECT id, name, created_by, created_by_name, created_at, updated_at
          FROM cow_lists
          WHERE farm_id = ${authContext.farmId}
          ORDER BY LOWER(name), name
        `;

        const items = await sql`
          SELECT
            cli.list_id,
            cli.cow_id,
            cli.added_by,
            cli.added_by_name,
            cli.added_at,
            c.brand_number
          FROM cow_list_items cli
          JOIN cow_lists cl ON cl.id = cli.list_id
          JOIN cows c ON c.id = cli.cow_id
          WHERE cl.farm_id = ${authContext.farmId}
          ORDER BY LOWER(c.brand_number), c.brand_number
        `;

        const byList = new Map();
        for (const item of items) {
          if (!byList.has(item.list_id)) byList.set(item.list_id, []);
          byList.get(item.list_id).push({
            cow_id: item.cow_id,
            brand_number: item.brand_number,
            added_by: item.added_by,
            added_by_name: item.added_by_name,
            added_at: item.added_at,
          });
        }

        return json({
          ok: true,
          count: lists.length,
          lists: lists.map((list) => ({
            ...list,
            cows: byList.get(list.id) || [],
            cow_count: (byList.get(list.id) || []).length,
          })),
        });
      }

      // POST /api/lists
      // body: { name }
      if (pathname === "/api/lists" && request.method === "POST") {
        await ensureCowListTables();

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const name = String(body.name || "").trim().slice(0, 100);
        if (!name) return json({ ok: false, error: "List name is required" }, 400);

        const existing = await sql`
          SELECT id
          FROM cow_lists
          WHERE farm_id = ${authContext.farmId}
            AND LOWER(name) = LOWER(${name})
          LIMIT 1
        `;
        if (existing.length) {
          return json({ ok: false, error: "A list with that name already exists" }, 409);
        }

        const id = crypto.randomUUID();
        const inserted = await sql`
          INSERT INTO cow_lists (
            id, farm_id, name, created_by, created_by_name
          ) VALUES (
            ${id}, ${authContext.farmId}, ${name},
            ${authContext.userId}, ${authContext.displayName}
          )
          RETURNING id, name, created_by, created_by_name, created_at, updated_at
        `;

        await logActivity({
          entityType: "list",
          entityId: id,
          action: "create",
          description: `Created cow list ${name}`,
          details: { list_name: name },
        });

        return json({ ok: true, list: { ...inserted[0], cows: [], cow_count: 0 } }, 201);
      }

      const listMatch = pathname.match(/^\/api\/lists\/([^/]+)$/);

      // PUT /api/lists/:id
      // body: { name }
      if (listMatch && request.method === "PUT") {
        await ensureCowListTables();
        const listId = decodeURIComponent(listMatch[1]);
        const list = await getListForCurrentFarm(listId);
        if (!list) return json({ ok: false, error: "List not found" }, 404);

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }
        const name = String(body.name || "").trim().slice(0, 100);
        if (!name) return json({ ok: false, error: "List name is required" }, 400);

        const duplicate = await sql`
          SELECT id
          FROM cow_lists
          WHERE farm_id = ${authContext.farmId}
            AND id <> ${listId}
            AND LOWER(name) = LOWER(${name})
          LIMIT 1
        `;
        if (duplicate.length) {
          return json({ ok: false, error: "A list with that name already exists" }, 409);
        }

        const updated = await sql`
          UPDATE cow_lists
          SET name = ${name}, updated_at = NOW()
          WHERE id = ${listId}
            AND farm_id = ${authContext.farmId}
          RETURNING id, name, created_by, created_by_name, created_at, updated_at
        `;

        await logActivity({
          entityType: "list",
          entityId: listId,
          action: "update",
          description: `Renamed cow list ${list.name} to ${name}`,
          details: { old_name: list.name, list_name: name },
        });

        return json({ ok: true, list: updated[0] });
      }

      // DELETE /api/lists/:id
      if (listMatch && request.method === "DELETE") {
        await ensureCowListTables();
        const listId = decodeURIComponent(listMatch[1]);
        const list = await getListForCurrentFarm(listId);
        if (!list) return json({ ok: false, error: "List not found" }, 404);

        await sql`
          DELETE FROM cow_lists
          WHERE id = ${listId}
            AND farm_id = ${authContext.farmId}
        `;

        await logActivity({
          entityType: "list",
          entityId: listId,
          action: "delete",
          description: `Deleted cow list ${list.name}`,
          details: { list_name: list.name },
        });

        return json({ ok: true, deleted: { id: listId, name: list.name } });
      }

      const listCowMatch = pathname.match(/^\/api\/lists\/([^/]+)\/cows(?:\/([^/]+))?$/);

      // POST /api/lists/:id/cows
      // body: { cow_id }
      if (listCowMatch && !listCowMatch[2] && request.method === "POST") {
        await ensureCowListTables();
        const listId = decodeURIComponent(listCowMatch[1]);
        const list = await getListForCurrentFarm(listId);
        if (!list) return json({ ok: false, error: "List not found" }, 404);

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }
        const cowId = String(body.cow_id || "").trim();
        if (!cowId) return json({ ok: false, error: "cow_id is required" }, 400);

        const cows = await sql`
          SELECT id, brand_number
          FROM cows
          WHERE id = ${cowId}
            AND farm_id = ${authContext.farmId}
          LIMIT 1
        `;
        if (!cows.length) return json({ ok: false, error: "Cow not found" }, 404);

        const inserted = await sql`
          INSERT INTO cow_list_items (
            list_id, cow_id, added_by, added_by_name
          ) VALUES (
            ${listId}, ${cowId}, ${authContext.userId}, ${authContext.displayName}
          )
          ON CONFLICT (list_id, cow_id) DO NOTHING
          RETURNING list_id, cow_id, added_by, added_by_name, added_at
        `;

        if (inserted.length) {
          await sql`
            UPDATE cow_lists SET updated_at = NOW()
            WHERE id = ${listId}
          `;
          await logActivity({
            entityType: "list",
            entityId: listId,
            action: "add_cow",
            description: `Added cow ${cows[0].brand_number} to ${list.name}`,
            details: { list_name: list.name, cow_id: cowId, cow_brand_number: cows[0].brand_number },
          });
        }

        return json({
          ok: true,
          already_in_list: inserted.length === 0,
          item: inserted[0] || { list_id: listId, cow_id: cowId },
        });
      }

      // DELETE /api/lists/:id/cows/:cowId
      if (listCowMatch && listCowMatch[2] && request.method === "DELETE") {
        await ensureCowListTables();
        const listId = decodeURIComponent(listCowMatch[1]);
        const cowId = decodeURIComponent(listCowMatch[2]);
        const list = await getListForCurrentFarm(listId);
        if (!list) return json({ ok: false, error: "List not found" }, 404);

        const cowRows = await sql`
          SELECT brand_number FROM cows
          WHERE id = ${cowId} AND farm_id = ${authContext.farmId}
          LIMIT 1
        `;

        const removed = await sql`
          DELETE FROM cow_list_items
          WHERE list_id = ${listId}
            AND cow_id = ${cowId}
          RETURNING cow_id
        `;

        if (removed.length) {
          await sql`UPDATE cow_lists SET updated_at = NOW() WHERE id = ${listId}`;
          await logActivity({
            entityType: "list",
            entityId: listId,
            action: "remove_cow",
            description: `Removed cow ${cowRows[0]?.brand_number || cowId} from ${list.name}`,
            details: { list_name: list.name, cow_id: cowId, cow_brand_number: cowRows[0]?.brand_number || null },
          });
        }

        return json({ ok: true, removed: removed.length > 0 });
      }
      
// ================================================================
// FARM INVITES - PUBLIC / PRE-MEMBERSHIP ROUTES
// ================================================================

// --------------------------------
// GET /invite-info?token=...
// Public lookup used by the invite signup screen.
// --------------------------------
if (pathname === "/invite-info" && request.method === "GET") {
  const token = String(url.searchParams.get("token") || "").trim();

  if (!token) {
    return json({ ok: false, error: "Invite token is required" }, 400);
  }

  const rows = await sql`
    SELECT
      fi.id,
      fi.role,
      fi.expires_at,
      fi.accepted_at,
      f.name AS farm_name
    FROM farm_invites fi
    JOIN farms f
      ON f.id = fi.farm_id
    WHERE fi.token = ${token}
    LIMIT 1
  `;

  if (!rows.length) {
    return json({ ok: false, error: "Invite not found" }, 404);
  }

  const invite = rows[0];

  if (invite.accepted_at) {
    return json({ ok: false, error: "This invite has already been used" }, 410);
  }

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return json({ ok: false, error: "This invite has expired" }, 410);
  }

  return json({
    ok: true,
    invite: {
      farm_name: invite.farm_name,
      role: invite.role,
      expires_at: invite.expires_at,
    },
  });
}

// --------------------------------
// POST /invite-accept
// Requires a valid Neon Auth JWT, but does not require existing farm access.
// --------------------------------
if (pathname === "/invite-accept" && request.method === "POST") {
  const auth = await verifyAuth(request);

  if (!auth?.sub) {
    return json({ ok: false, error: "Not authenticated" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const token = String(body.token || "").trim();
  if (!token) {
    return json({ ok: false, error: "Invite token is required" }, 400);
  }

  const inviteRows = await sql`
    SELECT
      fi.id,
      fi.farm_id,
      fi.role,
      fi.expires_at,
      fi.accepted_at,
      f.name AS farm_name
    FROM farm_invites fi
    JOIN farms f
      ON f.id = fi.farm_id
    WHERE fi.token = ${token}
    LIMIT 1
  `;

  if (!inviteRows.length) {
    return json({ ok: false, error: "Invite not found" }, 404);
  }

  const invite = inviteRows[0];
  if (invite.accepted_at) {
    return json({ ok: false, error: "This invite has already been used" }, 410);
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return json({ ok: false, error: "This invite has expired" }, 410);
  }

  const userId = String(auth.sub);
  const existingMembership = await sql`
    SELECT farm_id
    FROM farm_members
    WHERE auth_user_id = ${userId}
    LIMIT 1
  `;

  if (existingMembership.length) {
    if (String(existingMembership[0].farm_id) === String(invite.farm_id)) {
      return json({
        ok: true,
        already_member: true,
        farm_name: invite.farm_name,
      });
    }

    return json(
      { ok: false, error: "This account already belongs to another farm" },
      409
    );
  }

  const displayName = String(
    body.display_name || auth.name || auth.email || "User"
  ).trim().slice(0, 100) || "User";

  const memberId = crypto.randomUUID();
  const now = new Date().toISOString();

  const inserted = await sql`
    WITH claimed AS (
      UPDATE farm_invites
      SET
        accepted_by = ${userId},
        accepted_at = ${now}
      WHERE id = ${invite.id}
        AND accepted_at IS NULL
        AND expires_at > NOW()
      RETURNING farm_id, role
    )
    INSERT INTO farm_members (
      id,
      farm_id,
      auth_user_id,
      display_name,
      role,
      created_at
    )
    SELECT
      ${memberId},
      claimed.farm_id,
      ${userId},
      ${displayName},
      claimed.role,
      ${now}
    FROM claimed
    RETURNING
      id,
      farm_id,
      auth_user_id,
      display_name,
      role,
      created_at
  `;

  if (!inserted.length) {
    return json({ ok: false, error: "Invite is no longer available" }, 409);
  }

  return json(
    {
      ok: true,
      farm_name: invite.farm_name,
      member: inserted[0],
    },
    201
  );
}

// --------------------------------
// GET /auth-test
// --------------------------------
if (pathname === "/auth-test" && request.method === "GET") {
  const auth = await verifyAuth(request);

  if (!auth) {
    return json(
      {
        ok: false,
        error: "Not authenticated",
      },
      401
    );
  }

  return json({
    ok: true,
    message: "Authentication verified",
    user: auth,
  });
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
      // ACTIVITY
      // ================================================================

      // --------------------------------
      // GET /api/activity
      // Cattle-record changes only; chat messages/photos are not logged.
      // --------------------------------
      if (pathname === "/api/activity" && request.method === "GET") {
        const farm = await getFarm();

        if (!farm) {
          return json({ ok: false, error: "No farm found" }, 404);
        }

        const activity = await sql`
          SELECT
            id,
            auth_user_id,
            display_name,
            entity_type,
            entity_id,
            action,
            description,
            details,
            created_at
          FROM activity_log
          WHERE farm_id = ${farm.id}
          ORDER BY created_at DESC, id DESC
          LIMIT 500
        `;

        return json({
          ok: true,
          count: activity.length,
          activity,
        });
      }

      // --------------------------------
      // DELETE /api/activity/:id
      // Admin only. Deletes one activity entry from this farm.
      // --------------------------------
      if (
        pathname.startsWith("/api/activity/") &&
        request.method === "DELETE"
      ) {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        const activityId = pathname.slice("/api/activity/".length).trim();

        if (!activityId) {
          return json({ ok: false, error: "Activity id is required" }, 400);
        }

        const deleted = await sql`
          DELETE FROM activity_log
          WHERE id = ${activityId}
            AND farm_id = ${authContext.farmId}
          RETURNING id
        `;

        if (!deleted.length) {
          return json({ ok: false, error: "Activity entry not found" }, 404);
        }

        return json({ ok: true, deleted: 1 });
      }

      // --------------------------------
      // POST /api/activity/clear
      // Admin only. Supports:
      //   { mode: "all" }
      //   { mode: "older_than_days", days: 30 }
      //   { mode: "before_date", before_date: "2026-09-01" }
      // --------------------------------
      if (pathname === "/api/activity/clear" && request.method === "POST") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const mode = String(body?.mode || "").trim();
        let deleted = [];

        if (mode === "all") {
          deleted = await sql`
            DELETE FROM activity_log
            WHERE farm_id = ${authContext.farmId}
            RETURNING id
          `;
        } else if (mode === "older_than_days") {
          const days = Number(body?.days);

          if (!Number.isInteger(days) || days < 1 || days > 3650) {
            return json(
              { ok: false, error: "Days must be a whole number from 1 to 3650" },
              400
            );
          }

          const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

          deleted = await sql`
            DELETE FROM activity_log
            WHERE farm_id = ${authContext.farmId}
              AND created_at < ${cutoff}
            RETURNING id
          `;
        } else if (mode === "before_date") {
          const rawDate = String(body?.before_date || "").trim();

          if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
            return json(
              { ok: false, error: "before_date must use YYYY-MM-DD" },
              400
            );
          }

          const cutoffDate = new Date(`${rawDate}T00:00:00.000Z`);

          if (Number.isNaN(cutoffDate.getTime())) {
            return json({ ok: false, error: "Invalid before_date" }, 400);
          }

          deleted = await sql`
            DELETE FROM activity_log
            WHERE farm_id = ${authContext.farmId}
              AND created_at < ${cutoffDate.toISOString()}
            RETURNING id
          `;
        } else {
          return json(
            {
              ok: false,
              error: "Mode must be all, older_than_days, or before_date",
            },
            400
          );
        }

        return json({
          ok: true,
          deleted: deleted.length,
        });
      }

      // ================================================================
      // FARM USERS / ADMIN SETTINGS
      // ================================================================

      // --------------------------------
      // GET /api/members
      // Admin only.
      // --------------------------------
      if (pathname === "/api/members" && request.method === "GET") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        const members = await sql`
          SELECT
            id,
            auth_user_id,
            display_name,
            role,
            created_at
          FROM farm_members
          WHERE farm_id = ${authContext.farmId}
          ORDER BY
            CASE WHEN role = 'admin' THEN 0 ELSE 1 END,
            LOWER(COALESCE(display_name, '')),
            created_at
        `;

        return json({
          ok: true,
          current_user_id: authContext.userId,
          members,
        });
      }

      // --------------------------------
      // GET /api/invites
      // Admin only. Returns pending invite links.
      // --------------------------------
      if (pathname === "/api/invites" && request.method === "GET") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        const invites = await sql`
          SELECT
            id,
            token,
            role,
            created_by,
            created_at,
            expires_at,
            accepted_by,
            accepted_at
          FROM farm_invites
          WHERE farm_id = ${authContext.farmId}
            AND accepted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 100
        `;

        return json({ ok: true, invites });
      }

      // --------------------------------
      // POST /api/invites
      // Admin only. Creates a one-use invite, default 7 days.
      // --------------------------------
      if (pathname === "/api/invites" && request.method === "POST") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const role = String(body.role || "member").trim().toLowerCase();
        if (role !== "member" && role !== "admin") {
          return json({ ok: false, error: "role must be member or admin" }, 400);
        }

        const requestedDays = Number(body.expires_days ?? 7);
        const expiresDays = Number.isFinite(requestedDays)
          ? Math.max(1, Math.min(30, Math.round(requestedDays)))
          : 7;

        const token = createInviteToken();
        const createdAt = new Date();
        const expiresAt = new Date(
          createdAt.getTime() + expiresDays * 24 * 60 * 60 * 1000
        );

        const rows = await sql`
          INSERT INTO farm_invites (
            id,
            farm_id,
            token,
            role,
            created_by,
            created_at,
            expires_at
          )
          VALUES (
            ${crypto.randomUUID()},
            ${authContext.farmId},
            ${token},
            ${role},
            ${authContext.userId},
            ${createdAt.toISOString()},
            ${expiresAt.toISOString()}
          )
          RETURNING
            id,
            token,
            role,
            created_at,
            expires_at
        `;

        return json(
          {
            ok: true,
            farm_name: authContext.farmName,
            invite: rows[0],
          },
          201
        );
      }

      const inviteAdminMatch = pathname.match(/^\/api\/invites\/([^/]+)$/);

      // --------------------------------
      // DELETE /api/invites/:id
      // Admin only. Revokes an unused invite.
      // --------------------------------
      if (inviteAdminMatch && request.method === "DELETE") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        const inviteId = decodeURIComponent(inviteAdminMatch[1]);
        const deleted = await sql`
          DELETE FROM farm_invites
          WHERE id = ${inviteId}
            AND farm_id = ${authContext.farmId}
            AND accepted_at IS NULL
          RETURNING id
        `;

        if (!deleted.length) {
          return json({ ok: false, error: "Invite not found" }, 404);
        }

        return json({ ok: true, deleted: deleted[0] });
      }

      const memberMatch = pathname.match(/^\/api\/members\/([^/]+)$/);

      // --------------------------------
      // PUT /api/members/:id
      // Admin only. Change member/admin role.
      // --------------------------------
      if (memberMatch && request.method === "PUT") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        const memberId = decodeURIComponent(memberMatch[1]);
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const role = String(body.role || "").trim().toLowerCase();
        if (role !== "member" && role !== "admin") {
          return json({ ok: false, error: "role must be member or admin" }, 400);
        }

        const targetRows = await sql`
          SELECT id, auth_user_id, display_name, role
          FROM farm_members
          WHERE id = ${memberId}
            AND farm_id = ${authContext.farmId}
          LIMIT 1
        `;

        if (!targetRows.length) {
          return json({ ok: false, error: "Farm user not found" }, 404);
        }

        const target = targetRows[0];
        if (String(target.auth_user_id) === String(authContext.userId) && role !== "admin") {
          return json(
            { ok: false, error: "You cannot demote your own admin account" },
            400
          );
        }

        if (target.role === "admin" && role !== "admin") {
          const counts = await sql`
            SELECT COUNT(*)::int AS count
            FROM farm_members
            WHERE farm_id = ${authContext.farmId}
              AND role = 'admin'
          `;
          if (Number(counts[0]?.count || 0) <= 1) {
            return json({ ok: false, error: "The farm must keep at least one admin" }, 409);
          }
        }

        const updated = await sql`
          UPDATE farm_members
          SET role = ${role}
          WHERE id = ${memberId}
            AND farm_id = ${authContext.farmId}
          RETURNING id, auth_user_id, display_name, role, created_at
        `;

        return json({ ok: true, member: updated[0] });
      }

      // --------------------------------
      // DELETE /api/members/:id
      // Admin only. Removes farm access, but does not delete their auth account.
      // --------------------------------
      if (memberMatch && request.method === "DELETE") {
        if (authContext.role !== "admin") {
          return json({ ok: false, error: "Admin access required" }, 403);
        }

        const memberId = decodeURIComponent(memberMatch[1]);
        const targetRows = await sql`
          SELECT id, auth_user_id, display_name, role
          FROM farm_members
          WHERE id = ${memberId}
            AND farm_id = ${authContext.farmId}
          LIMIT 1
        `;

        if (!targetRows.length) {
          return json({ ok: false, error: "Farm user not found" }, 404);
        }

        const target = targetRows[0];
        if (String(target.auth_user_id) === String(authContext.userId)) {
          return json({ ok: false, error: "You cannot remove your own account" }, 400);
        }

        if (target.role === "admin") {
          const counts = await sql`
            SELECT COUNT(*)::int AS count
            FROM farm_members
            WHERE farm_id = ${authContext.farmId}
              AND role = 'admin'
          `;
          if (Number(counts[0]?.count || 0) <= 1) {
            return json({ ok: false, error: "The farm must keep at least one admin" }, 409);
          }
        }

        const deleted = await sql`
          DELETE FROM farm_members
          WHERE id = ${memberId}
            AND farm_id = ${authContext.farmId}
          RETURNING id, auth_user_id, display_name, role
        `;

        return json({ ok: true, deleted: deleted[0] });
      }

      // ================================================================
      // OWNERS
      // ================================================================

      // --------------------------------
      // GET /api/owners
      // --------------------------------
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
      }

      // --------------------------------
      // POST /api/owners
      // --------------------------------
      if (pathname === "/api/owners" && request.method === "POST") {
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

        const name = String(body.name || "").trim();

        if (!name) {
          return json(
            {
              ok: false,
              error: "name is required",
            },
            400
          );
        }

        const existing = await sql`
          SELECT id
          FROM owners
          WHERE farm_id = ${farm.id}
            AND LOWER(name) = LOWER(${name})
          LIMIT 1
        `;

        if (existing.length) {
          return json(
            {
              ok: false,
              error: "An owner with that name already exists",
            },
            409
          );
        }

        const ownerId = crypto.randomUUID();
        const now = new Date().toISOString();

        const inserted = await sql`
          INSERT INTO owners (
            id,
            farm_id,
            name,
            created_at
          )
          VALUES (
            ${ownerId},
            ${farm.id},
            ${name},
            ${now}
          )
          RETURNING
            id,
            farm_id,
            name,
            created_at
        `;

        await logActivity({
          entityType: "owner",
          entityId: ownerId,
          action: "created",
          description: `${authContext.displayName} added owner ${name}`,
          details: { name },
        });

        return json(
          {
            ok: true,
            owner: inserted[0],
          },
          201
        );
      }

      // --------------------------------
      // Match /api/owners/:id
      // --------------------------------
      const ownerMatch = pathname.match(/^\/api\/owners\/([^/]+)$/);

      // --------------------------------
      // PUT /api/owners/:id
      // --------------------------------
      if (ownerMatch && request.method === "PUT") {
        const ownerId = decodeURIComponent(ownerMatch[1]);

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

        const existingOwner = await sql`
          SELECT
            id,
            farm_id,
            name,
            created_at
          FROM owners
          WHERE id = ${ownerId}
            AND farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!existingOwner.length) {
          return json(
            {
              ok: false,
              error: "Owner not found",
            },
            404
          );
        }

        const name =
          body.name !== undefined
            ? String(body.name).trim()
            : existingOwner[0].name;

        if (!name) {
          return json(
            {
              ok: false,
              error: "name is required",
            },
            400
          );
        }

        const duplicate = await sql`
          SELECT id
          FROM owners
          WHERE farm_id = ${farm.id}
            AND LOWER(name) = LOWER(${name})
            AND id <> ${ownerId}
          LIMIT 1
        `;

        if (duplicate.length) {
          return json(
            {
              ok: false,
              error: "An owner with that name already exists",
            },
            409
          );
        }

        const updated = await sql`
          UPDATE owners
          SET name = ${name}
          WHERE id = ${ownerId}
            AND farm_id = ${farm.id}
          RETURNING
            id,
            farm_id,
            name,
            created_at
        `;

        if (name !== existingOwner[0].name) {
          await logActivity({
            entityType: "owner",
            entityId: ownerId,
            action: "updated",
            description: `${authContext.displayName} renamed owner ${existingOwner[0].name} to ${name}`,
            details: {
              before: { name: existingOwner[0].name },
              after: { name },
            },
          });
        }

        return json({
          ok: true,
          owner: updated[0],
        });
      }

      // --------------------------------
      // DELETE /api/owners/:id
      // --------------------------------
      if (ownerMatch && request.method === "DELETE") {
        const ownerId = decodeURIComponent(ownerMatch[1]);

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

        const existingOwner = await sql`
          SELECT id, name
          FROM owners
          WHERE id = ${ownerId}
            AND farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!existingOwner.length) {
          return json(
            {
              ok: false,
              error: "Owner not found",
            },
            404
          );
        }

        await sql`
          UPDATE cows
          SET
            owner_id = NULL,
            updated_at = ${new Date().toISOString()}
          WHERE farm_id = ${farm.id}
            AND owner_id = ${ownerId}
        `;

        const deleted = await sql`
          DELETE FROM owners
          WHERE id = ${ownerId}
            AND farm_id = ${farm.id}
          RETURNING id, name
        `;

        await logActivity({
          entityType: "owner",
          entityId: ownerId,
          action: "deleted",
          description: `${authContext.displayName} deleted owner ${existingOwner[0].name}`,
          details: { name: existingOwner[0].name },
        });

        return json({
          ok: true,
          deleted: deleted[0],
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
        if (ownerId) {
  const owner = await sql`
    SELECT id
    FROM owners
    WHERE id = ${ownerId}
      AND farm_id = ${farm.id}
    LIMIT 1
  `;

  if (!owner.length) {
    return json(
      {
        ok: false,
        error: "Owner not found",
      },
      404
    );
  }
}

        const notes =
          body.notes && String(body.notes).trim()
            ? String(body.notes).trim()
            : null;

       const createdBy = authContext.displayName; 

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

        await logActivity({
          entityType: "cow",
          entityId: cowId,
          action: "created",
          description: `${authContext.displayName} added cow ${brandNumber}`,
          details: {
            brand_number: brandNumber,
            owner_id: ownerId,
            notes,
          },
        });

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
if (ownerId) {
  const owner = await sql`
    SELECT id
    FROM owners
    WHERE id = ${ownerId}
      AND farm_id = ${farm.id}
    LIMIT 1
  `;

  if (!owner.length) {
    return json(
      {
        ok: false,
        error: "Owner not found",
      },
      404
    );
  }
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

        const brandChanged = String(current.brand_number) !== String(brandNumber);
        const ownerChanged = String(current.owner_id || "") !== String(ownerId || "");
        const notesChanged = String(current.notes || "") !== String(notes || "");

        if (brandChanged || ownerChanged || notesChanged) {
          let description;

          if (ownerChanged && !brandChanged && !notesChanged) {
            description = `${authContext.displayName} changed owner on cow ${brandNumber}`;
          } else if (brandChanged && !ownerChanged && !notesChanged) {
            description = `${authContext.displayName} changed cow ${current.brand_number} to ${brandNumber}`;
          } else {
            description = `${authContext.displayName} edited cow ${brandNumber}`;
          }

          await logActivity({
            entityType: "cow",
            entityId: cowId,
            action: "updated",
            description,
            details: {
              before: {
                brand_number: current.brand_number,
                owner_id: current.owner_id,
                notes: current.notes,
              },
              after: {
                brand_number: brandNumber,
                owner_id: ownerId,
                notes,
              },
            },
          });
        }

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

        await logActivity({
          entityType: "cow",
          entityId: cowId,
          action: "deleted",
          description: `${authContext.displayName} deleted cow ${deleted[0].brand_number}`,
          details: { brand_number: deleted[0].brand_number },
        });

        return json({
          ok: true,
          deleted: deleted[0],
        });
      }

      // ================================================================
      // CALVES
      // ================================================================

      // --------------------------------
            // --------------------------------
      // GET /api/calves
      // Optional: ?cow_id=UUID
      // --------------------------------
      if (pathname === "/api/calves" && request.method === "GET") {
        const cowId = String(
          url.searchParams.get("cow_id") || ""
        ).trim();

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

        // ------------------------------------------------
        // If cow_id was supplied, return that cow's calves
        // ------------------------------------------------
        if (cowId) {
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

        // ------------------------------------------------
        // No cow_id supplied:
        // return ALL calves belonging to this farm
        // ------------------------------------------------
        const calves = await sql`
          SELECT
            calves.id,
            calves.cow_id,
            calves.birth_month,
            calves.birth_year,
            calves.gender,
            calves.color,
            calves.is_dead,
            calves.notes,
            calves.created_by,
            calves.created_at,
            calves.updated_at
          FROM calves
          INNER JOIN cows
            ON cows.id = calves.cow_id
          WHERE cows.farm_id = ${farm.id}
          ORDER BY
            calves.birth_year DESC,
            calves.birth_month DESC,
            calves.created_at DESC
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
          SELECT id, brand_number
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

        const createdBy = authContext.displayName;

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

        await logActivity({
          entityType: "calf",
          entityId: calfId,
          action: "created",
          description: `${authContext.displayName} added calf to cow ${cow[0].brand_number}`,
          details: {
            cow_id: cowId,
            cow_brand_number: cow[0].brand_number,
            birth_month: birthMonth,
            birth_year: birthYear,
            gender,
            color,
            is_dead: isDead,
            notes,
          },
        });

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
            calves.*,
            cows.brand_number AS cow_brand_number
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

        const calfChanged =
          Number(current.birth_month) !== Number(birthMonth) ||
          Number(current.birth_year) !== Number(birthYear) ||
          String(current.gender || "") !== String(gender || "") ||
          String(current.color || "") !== String(color || "") ||
          Boolean(current.is_dead) !== Boolean(isDead) ||
          String(current.notes || "") !== String(notes || "");

        if (calfChanged) {
          await logActivity({
            entityType: "calf",
            entityId: calfId,
            action: "updated",
            description: `${authContext.displayName} edited calf record for cow ${current.cow_brand_number}`,
            details: {
              cow_id: current.cow_id,
              cow_brand_number: current.cow_brand_number,
              before: {
                birth_month: current.birth_month,
                birth_year: current.birth_year,
                gender: current.gender,
                color: current.color,
                is_dead: current.is_dead,
                notes: current.notes,
              },
              after: {
                birth_month: birthMonth,
                birth_year: birthYear,
                gender,
                color,
                is_dead: isDead,
                notes,
              },
            },
          });
        }

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
          SELECT
            calves.id,
            calves.cow_id,
            cows.brand_number AS cow_brand_number
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

        await logActivity({
          entityType: "calf",
          entityId: calfId,
          action: "deleted",
          description: `${authContext.displayName} deleted calf record from cow ${existing[0].cow_brand_number}`,
          details: {
            cow_id: existing[0].cow_id,
            cow_brand_number: existing[0].cow_brand_number,
          },
        });

        return json({
          ok: true,
          deleted: deleted[0],
        });
      }

      // ================================================================
      // PUSH NOTIFICATIONS
      // ================================================================

      // --------------------------------
      // GET /api/push/public-key
      // The VAPID public key is safe to expose to authenticated clients.
      // --------------------------------
      if (pathname === "/api/push/public-key" && request.method === "GET") {
        if (!env.VAPID_PUBLIC_KEY) {
          return json({ ok: false, error: "Push notifications are not configured" }, 500);
        }

        return json({
          ok: true,
          public_key: env.VAPID_PUBLIC_KEY,
        });
      }

      // --------------------------------
      // POST /api/push/subscribe
      // Stores or refreshes this browser/device subscription.
      // --------------------------------
      if (pathname === "/api/push/subscribe" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        const subscription = body?.subscription || body;
        const endpoint = String(subscription?.endpoint || "").trim();
        const p256dh = String(subscription?.keys?.p256dh || "").trim();
        const authKey = String(subscription?.keys?.auth || "").trim();

        if (!endpoint || !p256dh || !authKey) {
          return json({ ok: false, error: "Invalid push subscription" }, 400);
        }

        await sql`
          INSERT INTO push_subscriptions (
            farm_id,
            auth_user_id,
            endpoint,
            p256dh,
            auth_key,
            updated_at
          )
          VALUES (
            ${authContext.farmId},
            ${authContext.userId},
            ${endpoint},
            ${p256dh},
            ${authKey},
            now()
          )
          ON CONFLICT (endpoint)
          DO UPDATE SET
            farm_id = EXCLUDED.farm_id,
            auth_user_id = EXCLUDED.auth_user_id,
            p256dh = EXCLUDED.p256dh,
            auth_key = EXCLUDED.auth_key,
            updated_at = now()
        `;

        return json({ ok: true });
      }

      // --------------------------------
      // DELETE /api/push/subscribe
      // Removes this user's browser/device subscription.
      // --------------------------------
      if (pathname === "/api/push/subscribe" && request.method === "DELETE") {
        let endpoint = "";
        try {
          const body = await request.json();
          endpoint = String(body?.endpoint || "").trim();
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, 400);
        }

        if (!endpoint) {
          return json({ ok: false, error: "Push endpoint is required" }, 400);
        }

        await sql`
          DELETE FROM push_subscriptions
          WHERE endpoint = ${endpoint}
            AND farm_id = ${authContext.farmId}
            AND auth_user_id = ${authContext.userId}
        `;

        return json({ ok: true });
      }

      // ================================================================
      // FARM CHAT
      // ================================================================

      // --------------------------------
      // GET /api/messages
      // --------------------------------
      if (pathname === "/api/messages" && request.method === "GET") {
        const farm = await getFarm();

        if (!farm) {
          return json({ ok: false, error: "No farm found" }, 404);
        }

        const messages = await sql`
          SELECT
            id,
            auth_user_id,
            display_name,
            message_text,
            photo_url,
            created_at
          FROM farm_messages
          WHERE farm_id = ${farm.id}
          ORDER BY created_at ASC, id ASC
        `;

        return json({ ok: true, messages });
      }

      // --------------------------------
      // POST /api/messages
      // Text messages only for now.
      // Shared photo storage will be added separately.
      // --------------------------------
      if (pathname === "/api/messages" && request.method === "POST") {
        const farm = await getFarm();

        if (!farm) {
          return json({ ok: false, error: "No farm found" }, 404);
        }

        const body = await request.json();
        const messageText =
          body.message_text === null || body.message_text === undefined
            ? ""
            : String(body.message_text).trim();

        if (!messageText) {
          return json({ ok: false, error: "Message is required" }, 400);
        }

        // Keep accidental/abusive oversized requests out of the database.
        if (messageText.length > 5000) {
          return json({ ok: false, error: "Message is too long" }, 400);
        }

        const inserted = await sql`
          INSERT INTO farm_messages (
            farm_id,
            auth_user_id,
            display_name,
            message_text,
            photo_url
          )
          VALUES (
            ${farm.id},
            ${authContext.userId},
            ${authContext.displayName},
            ${messageText},
            ${null}
          )
          RETURNING
            id,
            auth_user_id,
            display_name,
            message_text,
            photo_url,
            created_at
        `;

        queueFarmChatPush({
          messageId: inserted[0].id,
          messageText: inserted[0].message_text,
          isPhoto: false,
        });

        return json({ ok: true, message: inserted[0] }, 201);
      }

      // --------------------------------
      // POST /api/messages/photo
      // Stores the image privately in R2, then creates the shared chat message.
      // --------------------------------
      if (pathname === "/api/messages/photo" && request.method === "POST") {
        const farm = await getFarm();

        if (!farm) {
          return json({ ok: false, error: "No farm found" }, 404);
        }

        if (!env.PHOTOS) {
          return json({ ok: false, error: "Photo storage is not configured" }, 500);
        }

        const formData = await request.formData();
        const photo = formData.get("photo");
        const captionValue = formData.get("message_text");
        const messageText =
          captionValue === null || captionValue === undefined
            ? null
            : String(captionValue).trim() || null;

        if (!photo || typeof photo.arrayBuffer !== "function") {
          return json({ ok: false, error: "Photo is required" }, 400);
        }

        if (messageText && messageText.length > 5000) {
          return json({ ok: false, error: "Message is too long" }, 400);
        }

        const allowedTypes = new Set([
          "image/jpeg",
          "image/png",
          "image/webp",
        ]);
        const contentType = String(photo.type || "").toLowerCase();

        if (!allowedTypes.has(contentType)) {
          return json(
            { ok: false, error: "Photo must be JPEG, PNG, or WebP" },
            400
          );
        }

        const maxPhotoBytes = 8 * 1024 * 1024;
        if (Number(photo.size || 0) <= 0 || Number(photo.size) > maxPhotoBytes) {
          return json(
            { ok: false, error: "Photo must be 8 MB or smaller" },
            400
          );
        }

        const extension =
          contentType === "image/png"
            ? "png"
            : contentType === "image/webp"
              ? "webp"
              : "jpg";

        const objectKey = `${farm.id}/${crypto.randomUUID()}.${extension}`;
        const bytes = await photo.arrayBuffer();

        await env.PHOTOS.put(objectKey, bytes, {
          httpMetadata: {
            contentType,
            cacheControl: "private, max-age=86400",
          },
          customMetadata: {
            farmId: String(farm.id),
            uploadedBy: String(authContext.userId),
          },
        });

        try {
          const inserted = await sql`
            INSERT INTO farm_messages (
              farm_id,
              auth_user_id,
              display_name,
              message_text,
              photo_url
            )
            VALUES (
              ${farm.id},
              ${authContext.userId},
              ${authContext.displayName},
              ${messageText},
              ${objectKey}
            )
            RETURNING
              id,
              auth_user_id,
              display_name,
              message_text,
              photo_url,
              created_at
          `;

          queueFarmChatPush({
            messageId: inserted[0].id,
            messageText: inserted[0].message_text,
            isPhoto: true,
          });

          return json({ ok: true, message: inserted[0] }, 201);
        } catch (error) {
          // Avoid leaving an orphaned R2 object if the database insert fails.
          try {
            await env.PHOTOS.delete(objectKey);
          } catch (cleanupError) {
            console.error("R2 cleanup failed:", cleanupError);
          }
          throw error;
        }
      }

      // --------------------------------
      // GET /api/media/:messageId
      // Streams a private R2 photo only when it belongs to this user's farm.
      // --------------------------------
      const mediaMatch = pathname.match(/^\/api\/media\/([^/]+)$/);

      if (mediaMatch && request.method === "GET") {
        const messageId = decodeURIComponent(mediaMatch[1]);
        const farm = await getFarm();

        if (!farm) {
          return json({ ok: false, error: "No farm found" }, 404);
        }

        if (!env.PHOTOS) {
          return json({ ok: false, error: "Photo storage is not configured" }, 500);
        }

        const rows = await sql`
          SELECT id, photo_url
          FROM farm_messages
          WHERE id = ${messageId}
            AND farm_id = ${farm.id}
            AND photo_url IS NOT NULL
          LIMIT 1
        `;

        if (!rows.length) {
          return json({ ok: false, error: "Photo not found" }, 404);
        }

        const object = await env.PHOTOS.get(rows[0].photo_url);

        if (!object) {
          return json({ ok: false, error: "Photo not found" }, 404);
        }

        const headers = new Headers(corsHeaders());
        object.writeHttpMetadata(headers);
        headers.set("Cache-Control", "private, max-age=86400");
        headers.set("X-Content-Type-Options", "nosniff");

        return new Response(object.body, {
          status: 200,
          headers,
        });
      }

      // Match /api/messages/:id
      const messageMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);

      // --------------------------------
      // DELETE /api/messages/:id
      // Sender can delete their own message; farm admin can delete any.
      // --------------------------------
      if (messageMatch && request.method === "DELETE") {
        const messageId = decodeURIComponent(messageMatch[1]);
        const farm = await getFarm();

        if (!farm) {
          return json({ ok: false, error: "No farm found" }, 404);
        }

        const existing = await sql`
          SELECT id, auth_user_id, photo_url
          FROM farm_messages
          WHERE id = ${messageId}
            AND farm_id = ${farm.id}
          LIMIT 1
        `;

        if (!existing.length) {
          return json({ ok: false, error: "Message not found" }, 404);
        }

        const isSender =
          String(existing[0].auth_user_id) === String(authContext.userId);
        const isAdmin = authContext.role === "admin";

        if (!isSender && !isAdmin) {
          return json({ ok: false, error: "Not allowed to delete this message" }, 403);
        }

        const deleted = await sql`
          DELETE FROM farm_messages
          WHERE id = ${messageId}
            AND farm_id = ${farm.id}
          RETURNING id
        `;

        if (existing[0].photo_url && env.PHOTOS) {
          try {
            await env.PHOTOS.delete(existing[0].photo_url);
          } catch (error) {
            // The message is already deleted from Neon. Log an orphan cleanup issue
            // rather than making the user think the delete failed.
            console.error("R2 photo delete failed:", error);
          }
        }

        return json({ ok: true, deleted: deleted[0] });
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
