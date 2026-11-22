// Peer review T-4 (I3): throwaway test of undo/redo (step in apps/web/src/scenario.ts).
// Not part of the suite. How to run, from the checkout under review:
//   npx vitest run --root "C:/Programming Projects/GTFS Editor/docs/reviews/T-4/evidence"
// The imports below point at the reviewer's worktree at commit 61dde1f (relative to this folder);
// change the two paths to re-run against another checkout.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../../../.claude/worktrees/agent-a1cf53318e8d2732b/apps/web/src/vehicles.ts",
  () => ({
    applyRemovedTrips: vi.fn(),
    applyWaits: vi.fn(),
    loadScenarioVehicles: vi.fn(async () => undefined),
    loadWaits: vi.fn(async () => undefined),
    vehicleData: new Map(),
  }),
);

const scenario =
  await import("../../../../.claude/worktrees/agent-a1cf53318e8d2732b/apps/web/src/scenario.ts");
const { useStore } =
  await import("../../../../.claude/worktrees/agent-a1cf53318e8d2732b/apps/web/src/store.ts");

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
/** URL substring -> a promise that holds a matching request "in flight" until it settles. */
let hold: Map<string, Promise<void>> = new Map();
let failUrl: string | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  hold = new Map();
  failUrl = null;
  useStore.getState().set({
    baselineId: 1,
    scenarioId: 7,
    editBusy: false,
    editError: null,
    editConfirm: null,
    history: [],
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    for (const [part, p] of hold) if (url.includes(part)) await p;
    if (failUrl && url.includes(failUrl))
      return json({ message: "Nothing to undo" }, 400);
    if (url.includes("/edits")) {
      const body = JSON.parse(String(init?.body));
      if (!body.confirm)
        return json({
          needsConfirm: { added: 12, message: "adds 12", summary: "x" },
        });
      return json({ summary: "done", idMap: {} });
    }
    if (url.includes("/routes")) return json([]);
    if (url.includes("/removed")) return json([]);
    if (/\/api\/scenarios\/\d+$/.test(url))
      return json({ id: 7, conflicts: [], edits: [] });
    if (url.includes("/api/scenarios?")) return json([]);
    return json({});
  });
});

const posts = (part: string) =>
  calls.filter((c) => c.method === "POST" && c.url.includes(part));

describe("T-4 I3: undo and redo while an edit is in flight", () => {
  it("undo and redo send nothing while editBusy is set, and leave editBusy set", async () => {
    useStore.getState().set({ editBusy: true });
    await scenario.undo();
    await scenario.redo();
    expect(calls).toEqual([]);
    expect(useStore.getState().editBusy).toBe(true);
  });

  it("undo works when nothing is in flight, and clears editBusy afterwards", async () => {
    await scenario.undo();
    expect(posts("/api/scenarios/7/undo")).toHaveLength(1);
    expect(useStore.getState().editBusy).toBe(false);
  });

  it("redo works when nothing is in flight", async () => {
    await scenario.redo();
    expect(posts("/api/scenarios/7/redo")).toHaveLength(1);
    expect(useStore.getState().editBusy).toBe(false);
  });

  it("two quick presses of Ctrl+Z send one undo", async () => {
    let release!: () => void;
    hold.set("/undo", new Promise<void>((r) => (release = r)));
    const first = scenario.undo();
    const second = scenario.undo();
    release();
    await Promise.all([first, second]);
    expect(posts("/undo")).toHaveLength(1);
  });

  it('while the "adds N vehicles" question is open, undo is refused; after Cancel it works', async () => {
    const edit = scenario.applyEdit({ kind: "frequency", routeId: 3 });
    await vi.waitFor(() =>
      expect(useStore.getState().editConfirm).not.toBeNull(),
    );
    expect(useStore.getState().editBusy).toBe(true);
    await scenario.undo();
    expect(posts("/undo")).toHaveLength(0);
    scenario.cancelConfirm();
    expect(await edit).toBeNull();
    expect(useStore.getState().editBusy).toBe(false);
    expect(useStore.getState().editConfirm).toBeNull();
    await scenario.undo();
    expect(posts("/undo")).toHaveLength(1);
  });

  it('after "Go ahead", undo works once the edit has landed', async () => {
    const edit = scenario.applyEdit({ kind: "frequency", routeId: 3 });
    await vi.waitFor(() =>
      expect(useStore.getState().editConfirm).not.toBeNull(),
    );
    scenario.confirmEdit();
    expect(await edit).not.toBeNull();
    expect(useStore.getState().editBusy).toBe(false);
    await scenario.undo();
    expect(posts("/undo")).toHaveLength(1);
  });

  it("a failed undo clears editBusy and shows the error, so the next undo is not blocked", async () => {
    failUrl = "/undo";
    await scenario.undo();
    expect(useStore.getState().editBusy).toBe(false);
    expect(useStore.getState().editError).toBe("Nothing to undo");
    failUrl = null;
    await scenario.undo();
    expect(posts("/undo")).toHaveLength(2);
  });

  it("an edit is refused while an undo is in flight (the other direction)", async () => {
    let release!: () => void;
    hold.set("/undo", new Promise<void>((r) => (release = r)));
    const u = scenario.undo();
    const e = await scenario.applyEdit({ kind: "frequency", routeId: 3 });
    release();
    await u;
    expect(e).toBeNull();
    expect(posts("/edits")).toHaveLength(0);
  });

  it("a hung undo request leaves editBusy set (no timeout): documents current behaviour", async () => {
    hold.set("/undo", new Promise<void>(() => undefined));
    void scenario.undo();
    await new Promise((r) => setTimeout(r, 50));
    expect(useStore.getState().editBusy).toBe(true);
  });
});
