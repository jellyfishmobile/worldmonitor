import { ConvexError, v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { CURRENT_PREFS_SCHEMA_VERSION, MAX_PREFS_BLOB_SIZE } from "./constants";

/**
 * The `by_user_variant` index is non-unique (Convex has no unique constraints),
 * so two racing first-writes for the same (userId, variant) can create
 * duplicate rows. `.unique()` then THROWS on every subsequent read/write for
 * that identity — surfacing as a Convex `InternalServerError` the edge
 * misclassifies as transient, so the client retries forever and never saves
 * (#4567). Read tolerantly instead: the highest-`syncVersion` row (tie:
 * highest `updatedAt`) is canonical; `setPreferences` also deletes the stale
 * duplicates in its (transactional) mutation to self-heal.
 */
function pickCanonicalPrefRow<T extends { syncVersion: number; updatedAt: number }>(
  rows: T[],
): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (
      !best ||
      r.syncVersion > best.syncVersion ||
      (r.syncVersion === best.syncVersion && r.updatedAt > best.updatedAt)
    ) {
      best = r;
    }
  }
  return best;
}

export const getPreferencesByUserId = internalQuery({
  args: { userId: v.string(), variant: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", args.userId).eq("variant", args.variant),
      )
      .collect();
    return pickCanonicalPrefRow(rows);
  },
});

export const getPreferences = query({
  args: { variant: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = identity.subject;
    const rows = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .collect();
    return pickCanonicalPrefRow(rows);
  },
});

/**
 * Discriminated return shape. `CONFLICT` is the CAS-guard "no-op" path —
 * intentional behavior for two-device concurrency. Switching from `throw`
 * to `return` here means Convex Insights stops labeling it
 * `Uncaught ConvexError` (no throw → no log surface), but the wire shape
 * exposed through `api/user-prefs.ts` (HTTP 409 with `actualSyncVersion`)
 * is unchanged — clients see the same response.
 *
 * `BLOB_TOO_LARGE` and `UNAUTHENTICATED` remain THROWS because they are
 * rare and we DO want them visible in Sentry as errors. CONFLICT is
 * dozens-per-day expected behavior, not an error.
 */
export type SetPreferencesResult =
  | { ok: true; syncVersion: number }
  | { ok: false; reason: "CONFLICT"; actualSyncVersion: number };

export const setPreferences = mutation({
  args: {
    variant: v.string(),
    data: v.any(),
    expectedSyncVersion: v.number(),
    schemaVersion: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SetPreferencesResult> => {
    const identity = await ctx.auth.getUserIdentity();
    // BLOB_TOO_LARGE and UNAUTHENTICATED throw as structured ConvexErrors —
    // they are rare error conditions we want surfaced in Sentry. Convex's
    // wire format propagates `errorData` for object payloads so the edge
    // handler routes via `err.data.kind`. (PR #3466 fixed the original
    // string-data wire-strip bug.)
    if (!identity) throw new ConvexError({ kind: "UNAUTHENTICATED" });
    const userId = identity.subject;

    const blobSize = JSON.stringify(args.data).length;
    if (blobSize > MAX_PREFS_BLOB_SIZE) {
      throw new ConvexError({
        kind: "BLOB_TOO_LARGE",
        size: blobSize,
        max: MAX_PREFS_BLOB_SIZE,
      });
    }

    // Tolerate duplicate (userId, variant) rows: read all and treat the
    // highest-syncVersion row as canonical instead of `.unique()` (which throws
    // → InternalServerError → retry loop, #4567).
    const rows = await ctx.db
      .query("userPreferences")
      .withIndex("by_user_variant", (q) =>
        q.eq("userId", userId).eq("variant", args.variant),
      )
      .collect();
    const existing = pickCanonicalPrefRow(rows);

    if (existing && existing.syncVersion !== args.expectedSyncVersion) {
      // CAS-guard "no-op". Returns rather than throws — see SetPreferencesResult
      // doc comment. Wire shape (HTTP 409 with actualSyncVersion in body) is
      // unchanged at the edge handler.
      return {
        ok: false,
        reason: "CONFLICT",
        actualSyncVersion: existing.syncVersion,
      };
    }

    const nextSyncVersion = (existing?.syncVersion ?? 0) + 1;
    const schemaVersion = args.schemaVersion ?? CURRENT_PREFS_SCHEMA_VERSION;

    if (existing) {
      await ctx.db.patch(existing._id, {
        data: args.data,
        schemaVersion,
        updatedAt: Date.now(),
        syncVersion: nextSyncVersion,
      });
      // Self-heal: delete any stale duplicate rows so this identity stops
      // hitting the `.unique()`/canonical path with >1 row (#4567).
      for (const r of rows) {
        if (r._id !== existing._id) await ctx.db.delete(r._id);
      }
    } else {
      await ctx.db.insert("userPreferences", {
        userId,
        variant: args.variant,
        data: args.data,
        schemaVersion,
        updatedAt: Date.now(),
        syncVersion: nextSyncVersion,
      });
    }

    return { ok: true, syncVersion: nextSyncVersion };
  },
});
