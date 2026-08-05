/**
 * brevo-sync — Cloudflare Worker
 *
 * Syncs contacts from Supabase into Brevo marketing lists AND mirrors the
 * contact-relevant rows into NeonDB slim tables for analytics/reporting.
 *
 * Pipeline (per source):
 *   1. Fetch rows from Supabase REST API (paginated)
 *   2. Upsert slim contact rows into NeonDB  (ADMIN_NEON_DB_URL)
 *   3. Batch-import contacts into Brevo      (BREVO_API_KEY)
 *
 * Sources → Brevo lists:
 *   Supabase public.orders          → NeonDB orders_contacts    → "Customers (Orders)"
 *   Supabase public.quote_customers → NeonDB quote_contacts     → "Enquiries (Quotes)"
 *   Supabase public.leads           → NeonDB leads_contacts     → "AI Scraped Leads"
 *   NeonDB   public.word_emails     → (already in Neon)         → "Word Doc Contacts"
 *
 * Triggers (wrangler.toml):
 *   • Cron : "0 *6 * * *"   (every 6 hours)
 *   • HTTP GET /run           (manual trigger / service binding)
 *
 * Required secrets (Secrets Store — store_id 2556bcd9458349f6b4ff2a3fc93bdba1):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   ADMIN_NEON_DB_URL      ← same secret already used by ai-sync, no new secret needed
 *   BREVO_API_KEY
 */

import { Client } from "pg";

// ── Brevo list names (created automatically if missing) ───────────────────
const BREVO_LISTS = {
  orders: "Customers (Orders)",
  quotes: "Enquiries (Quotes)",
  leads:  "AI Scraped Leads",
  word:   "Word Doc Contacts",
};

// ── Supabase column whitelists (only marketing-safe columns) ──────────────
const SUPABASE_SOURCES = {
  orders: {
    table:    "orders",
    columns:  ["id", "email", "customer_name", "phone", "product_type",
               "material", "status", "payment_status", "created_at"],
    pageSize: 500,
  },
  quotes: {
    table:    "quote_customers",
    columns:  ["id", "email", "company_name", "contact_person",
               "contact_number", "city", "state", "created_at"],
    pageSize: 500,
  },
  leads: {
    table:    "leads",
    columns:  ["id", "email", "company_name", "contact_name", "phone",
               "industry", "source", "status", "created_at"],
    pageSize: 500,
  },
};

// ── NeonDB upsert SQL per source ──────────────────────────────────────────
const NEON_UPSERTS = {
  orders: `
    INSERT INTO orders_contacts
      (id, email, customer_name, phone, product_type, material,
       status, payment_status, created_at, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (id) DO UPDATE SET
      email          = EXCLUDED.email,
      customer_name  = EXCLUDED.customer_name,
      phone          = EXCLUDED.phone,
      product_type   = EXCLUDED.product_type,
      material       = EXCLUDED.material,
      status         = EXCLUDED.status,
      payment_status = EXCLUDED.payment_status,
      synced_at      = now()
  `,
  quotes: `
    INSERT INTO quote_contacts
      (id, email, company_name, contact_person, contact_number,
       city, state, created_at, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
    ON CONFLICT (id) DO UPDATE SET
      email          = EXCLUDED.email,
      company_name   = EXCLUDED.company_name,
      contact_person = EXCLUDED.contact_person,
      contact_number = EXCLUDED.contact_number,
      city           = EXCLUDED.city,
      state          = EXCLUDED.state,
      synced_at      = now()
  `,
  leads: `
    INSERT INTO leads_contacts
      (id, email, company_name, contact_name, phone,
       industry, source, status, created_at, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
    ON CONFLICT (id) DO UPDATE SET
      email        = EXCLUDED.email,
      company_name = EXCLUDED.company_name,
      contact_name = EXCLUDED.contact_name,
      phone        = EXCLUDED.phone,
      industry     = EXCLUDED.industry,
      source       = EXCLUDED.source,
      status       = EXCLUDED.status,
      synced_at    = now()
  `,
};

// ── Row → Brevo contact shape ─────────────────────────────────────────────
function toBrevoContact(source, row) {
  const email = (row.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;

  const base = { email };

  if (source === "orders") {
    const parts = (row.customer_name || "").trim().split(" ", 2);
    base.attributes = {
      FIRSTNAME:      parts[0] || "",
      LASTNAME:       parts[1] || "",
      SMS:            row.phone || "",
      ORDER_STATUS:   row.status || "",
      PAYMENT_STATUS: row.payment_status || "",
      PRODUCT_TYPE:   row.product_type || "",
      MATERIAL:       row.material || "",
    };
  } else if (source === "quotes") {
    base.attributes = {
      FIRSTNAME:    (row.contact_person || "").trim(),
      SMS:          row.contact_number || "",
      COMPANY:      row.company_name || "",
      CITY:         row.city || "",
      STATE:        row.state || "",
    };
  } else if (source === "leads") {
    base.attributes = {
      FIRSTNAME:    (row.contact_name || "").trim(),
      SMS:          row.phone || "",
      COMPANY:      row.company_name || "",
      INDUSTRY:     row.industry || "",
      LEAD_SOURCE:  row.source || "",
      LEAD_STATUS:  row.status || "",
    };
  } else if (source === "word") {
    base.attributes = {
      WORD_LABEL: row.label || "word_import",
    };
  }

  // Strip empty attribute values — Brevo handles nulls poorly
  if (base.attributes) {
    base.attributes = Object.fromEntries(
      Object.entries(base.attributes).filter(([, v]) => v && String(v).trim())
    );
  }

  return base;
}

// ── Supabase REST fetch (paginated) ───────────────────────────────────────
async function fetchFromSupabase(env, tableName, columns, pageSize, log) {
  const baseUrl = (await resolveSecret(env.SUPABASE_URL)).replace(/\/$/, "");
  const svcKey  = await resolveSecret(env.SUPABASE_SERVICE_KEY);
  const colStr  = columns.join(",");
  const rows    = [];
  let offset    = 0;

  while (true) {
    const url = `${baseUrl}/rest/v1/${tableName}` +
      `?select=${encodeURIComponent(colStr)}` +
      `&email=not.is.null&email=neq.` +
      `&offset=${offset}&limit=${pageSize}`;

    // Simpler: fetch all with email filter
    const cleanUrl = `${baseUrl}/rest/v1/${tableName}` +
      `?select=${encodeURIComponent(colStr)}` +
      `&email=not.is.null` +
      `&offset=${offset}&limit=${pageSize}`;

    const res = await fetch(cleanUrl, {
      headers: {
        apikey:        svcKey,
        Authorization: `Bearer ${svcKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Supabase ${tableName} HTTP ${res.status}: ${await res.text()}`);
    }

    const batch = await res.json();
    rows.push(...batch);
    log.info(`  ${tableName}: fetched ${rows.length} rows so far...`);
    if (batch.length < pageSize) break;
    offset += batch.length;
  }

  return rows;
}

// ── NeonDB fetch for word_emails ──────────────────────────────────────────
async function fetchWordEmails(conn, log) {
  const res = await conn.query(
    `SELECT email, label FROM word_emails ORDER BY imported_at DESC`
  );
  log.info(`  word_emails: ${res.rows.length} rows fetched from NeonDB`);
  return res.rows;
}

// ── NeonDB upsert ─────────────────────────────────────────────────────────
async function upsertToNeon(conn, source, rows, log) {
  const sql  = NEON_UPSERTS[source];
  if (!sql)  return 0;   // word_emails are already in Neon

  const cols = SUPABASE_SOURCES[source].columns;
  let count  = 0;

  for (const row of rows) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;

    const params = cols.map(c => row[c] ?? null);
    // Normalise email in-place (index 1 in every source)
    params[1] = email;

    try {
      await conn.query(sql, params);
      count++;
    } catch (e) {
      log.warn(`  NeonDB upsert skip (${email}): ${e.message}`);
    }
  }

  log.info(`  ${source}: ${count} rows upserted into NeonDB`);
  return count;
}

// ── Brevo helpers ─────────────────────────────────────────────────────────
async function brevoRequest(apiKey, method, path, body) {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    method,
    headers: {
      "api-key":      apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok && res.status !== 204) {
    throw new Error(`Brevo ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function getOrCreateBrevoList(apiKey, name, log) {
  // Fetch existing lists (paginated, max 50 per call)
  let offset = 0;
  while (true) {
    const data = await brevoRequest(apiKey, "GET", `/contacts/lists?limit=50&offset=${offset}`);
    const lists = data.lists || [];
    const found = lists.find(l => l.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (found) {
      log.info(`  Brevo list "${name}" exists (id=${found.id})`);
      return found.id;
    }
    if (offset + 50 >= (data.count || 0)) break;
    offset += 50;
  }

  const created = await brevoRequest(apiKey, "POST", "/contacts/lists", {
    name,
    folderId: 1,
  });
  log.info(`  Brevo list "${name}" created (id=${created.id})`);
  return created.id;
}

async function pushToBrevo(apiKey, listId, contacts, source, log) {
  const BATCH = 150;   // Brevo import endpoint hard limit
  let pushed  = 0;

  for (let i = 0; i < contacts.length; i += BATCH) {
    const batch = contacts.slice(i, i + BATCH);
    try {
      await brevoRequest(apiKey, "POST", "/contacts/import", {
        jsonBody:               batch,
        listIds:                [listId],
        updateExistingContacts: true,
        emptyContactsAttributes: false,
      });
      pushed += batch.length;
      log.info(`  [${source}] Brevo batch ${Math.floor(i / BATCH) + 1}: ${batch.length} pushed`);
    } catch (e) {
      log.error(`  [${source}] Brevo batch ${Math.floor(i / BATCH) + 1} failed: ${e.message}`);
    }

    // Respect Brevo rate limits — 10 req/s on import endpoint
    if (i + BATCH < contacts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  log.info(`  [${source}] Brevo: ${pushed}/${contacts.length} contacts imported`);
  return pushed;
}

// ── Sync log ──────────────────────────────────────────────────────────────
async function writeSyncLog(conn, source, neonRows, brevoRows, status, errorMsg) {
  try {
    await conn.query(
      `INSERT INTO brevo_sync_log
         (source, neon_rows_synced, brevo_contacts_pushed, status, error_msg, ran_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [source, neonRows, brevoRows, status, errorMsg || null]
    );
  } catch (e) {
    // Don't crash if log table isn't set up yet
    console.warn(`[brevo-sync] sync log insert failed: ${e.message}`);
  }
}

// ── Secret resolver (same helper as ai-sync) ──────────────────────────────
async function resolveSecret(val) {
  if (!val) return undefined;
  if (typeof val === "object" && typeof val.get === "function") return await val.get();
  if (typeof val === "string") return val;
  return String(val);
}

// ── Logger ────────────────────────────────────────────────────────────────
function makeLogger(name) {
  const p = `[${name}]`;
  return {
    info:  msg => console.log( `${new Date().toISOString()}  INFO   ${p}  ${msg}`),
    warn:  msg => console.warn(`${new Date().toISOString()}  WARN   ${p}  ${msg}`),
    error: msg => console.error(`${new Date().toISOString()}  ERROR  ${p}  ${msg}`),
  };
}

// ── Main orchestrator ─────────────────────────────────────────────────────
async function runSync(env) {
  const log     = makeLogger("brevo-sync");
  const start   = Date.now();
  const errors  = [];

  log.info("=== Brevo Contact Sync Starting ===");

  const apiKey  = await resolveSecret(env.BREVO_API_KEY);
  const neonUrl = await resolveSecret(env.ADMIN_NEON_DB_URL);

  if (!apiKey)  throw new Error("BREVO_API_KEY secret is not set");
  if (!neonUrl) throw new Error("ADMIN_NEON_DB_URL secret is not set");

  const conn = new Client({
    connectionString:        neonUrl,
    connectionTimeoutMillis: 10_000,
    statement_timeout:       60_000,
  });
  await conn.connect();

  try {
    // ── 1. Supabase sources ─────────────────────────────────────────────
    for (const [source, cfg] of Object.entries(SUPABASE_SOURCES)) {
      log.info(`\n── Source: ${source} ──`);
      const listName = BREVO_LISTS[source];
      let neonCount  = 0;
      let brevoCount = 0;

      try {
        // Fetch from Supabase
        const rows = await fetchFromSupabase(env, cfg.table, cfg.columns, cfg.pageSize, log);
        log.info(`  ${source}: ${rows.length} total rows from Supabase`);

        if (!rows.length) {
          log.warn(`  ${source}: no rows — skipping`);
          continue;
        }

        // Upsert into NeonDB
        neonCount = await upsertToNeon(conn, source, rows, log);

        // Build Brevo contacts
        const contacts = rows
          .map(r => toBrevoContact(source, r))
          .filter(Boolean);

        log.info(`  ${source}: ${contacts.length} valid contacts for Brevo`);

        if (contacts.length) {
          const listId = await getOrCreateBrevoList(apiKey, listName, log);
          brevoCount   = await pushToBrevo(apiKey, listId, contacts, source, log);
        }

        await writeSyncLog(conn, source, neonCount, brevoCount, "ok", null);
      } catch (e) {
        log.error(`${source} failed: ${e.message}`);
        errors.push(`${source}: ${e.message}`);
        await writeSyncLog(conn, source, neonCount, brevoCount, "error", e.message);
      }
    }

    // ── 2. Word emails (already in NeonDB, just push to Brevo) ─────────
    log.info("\n── Source: word ──");
    let wordBrevoCount = 0;
    try {
      const wordRows = await fetchWordEmails(conn, log);

      if (wordRows.length) {
        const contacts = wordRows.map(r => toBrevoContact("word", r)).filter(Boolean);
        log.info(`  word: ${contacts.length} valid contacts for Brevo`);

        if (contacts.length) {
          const listId  = await getOrCreateBrevoList(apiKey, BREVO_LISTS.word, log);
          wordBrevoCount = await pushToBrevo(apiKey, listId, contacts, "word", log);
        }
        await writeSyncLog(conn, "word", wordRows.length, wordBrevoCount, "ok", null);
      } else {
        log.warn("  word: no emails in word_emails table — skipping");
      }
    } catch (e) {
      log.error(`word failed: ${e.message}`);
      errors.push(`word: ${e.message}`);
      await writeSyncLog(conn, "word", 0, wordBrevoCount, "error", e.message);
    }

  } finally {
    await conn.end();
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (errors.length) {
    log.error(`=== Sync finished with ${errors.length} error(s) in ${elapsed}s ===`);
    log.error(errors.join(" | "));
    return { ok: false, errors, duration_s: parseFloat(elapsed) };
  }

  log.info(`=== Brevo Contact Sync Done in ${elapsed}s ===`);
  return { ok: true, duration_s: parseFloat(elapsed) };
}

// ── Cloudflare Worker export ──────────────────────────────────────────────
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runSync(env));
  },

  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/run") {
      ctx.waitUntil(runSync(env));
      return new Response(
        JSON.stringify({ ok: true, message: "Brevo sync started" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      "brevo-sync worker\nGET /run to trigger manually",
      { status: 200 }
    );
  },
};