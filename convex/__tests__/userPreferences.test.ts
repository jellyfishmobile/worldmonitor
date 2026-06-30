import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";

const modules = import.meta.glob("../**/*.ts");

const USER = {
  subject: "user-prefs-dup",
  tokenIdentifier: "clerk|user-prefs-dup",
  email: "u@example.com",
};

type Seed = { syncVersion: number; updatedAt: number };

function seedRow(t: ReturnType<typeof convexTest>, s: Seed) {
  return t.run((ctx) =>
    ctx.db.insert("userPreferences", {
      userId: USER.subject,
      variant: "finance",
      data: { seededAt: s.syncVersion },
      schemaVersion: 2,
      updatedAt: s.updatedAt,
      syncVersion: s.syncVersion,
    }),
  );
}

function countRows(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => (await ctx.db.query("userPreferences").collect()).length);
}

describe("userPreferences: duplicate-row tolerance (#4567)", () => {
  test("setPreferences heals duplicate rows instead of throwing on .unique()", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, { syncVersion: 3, updatedAt: 100 });
    await seedRow(t, { syncVersion: 5, updatedAt: 200 }); // canonical
    expect(await countRows(t)).toBe(2);

    const asUser = t.withIdentity(USER);
    const result = await asUser.mutation(api.userPreferences.setPreferences, {
      variant: "finance",
      data: { theme: "dark" },
      expectedSyncVersion: 5,
      schemaVersion: 2,
    });

    expect(result).toEqual({ ok: true, syncVersion: 6 });
    expect(await countRows(t)).toBe(1); // stale duplicate deleted (self-heal)

    const got = await asUser.query(api.userPreferences.getPreferences, { variant: "finance" });
    expect(got?.syncVersion).toBe(6);
    expect(got?.data).toEqual({ theme: "dark" });
  });

  test("getPreferences returns the canonical (max syncVersion) row when duplicates exist", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, { syncVersion: 2, updatedAt: 100 });
    await seedRow(t, { syncVersion: 7, updatedAt: 200 }); // canonical
    const got = await t
      .withIdentity(USER)
      .query(api.userPreferences.getPreferences, { variant: "finance" });
    expect(got?.syncVersion).toBe(7);
  });

  test("CAS conflict still returns CONFLICT against the canonical row", async () => {
    const t = convexTest(schema, modules);
    await seedRow(t, { syncVersion: 4, updatedAt: 100 });
    const result = await t.withIdentity(USER).mutation(api.userPreferences.setPreferences, {
      variant: "finance",
      data: { x: 1 },
      expectedSyncVersion: 2, // stale
      schemaVersion: 2,
    });
    expect(result).toEqual({ ok: false, reason: "CONFLICT", actualSyncVersion: 4 });
  });

  test("happy path: no existing row inserts at syncVersion 1", async () => {
    const t = convexTest(schema, modules);
    const result = await t.withIdentity(USER).mutation(api.userPreferences.setPreferences, {
      variant: "finance",
      data: { a: 1 },
      expectedSyncVersion: 0,
      schemaVersion: 2,
    });
    expect(result).toEqual({ ok: true, syncVersion: 1 });
    expect(await countRows(t)).toBe(1);
  });
});
