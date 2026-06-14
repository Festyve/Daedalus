// §4.1 / §4.2 — the menu router: the single component that knows which tool module is
// active. It holds a Record<MenuId, MenuModule> registry (modules are registered by
// main.ts in Phase 5; the router never imports them, preserving the module-boundary rule
// that feature modules talk only through SceneContext). On select() it exits the
// previously active module BEFORE entering the newly chosen one, keeping ctx.activeMenu in
// lockstep; each frame update() delegates to the active module's update().
//
// HARD GUARANTEE (§4.2): only one tool is ever active, so only one plain-DOM panel is ever
// visible. Each module shows its panel in enter() and hides it in exit(); because select()
// always runs the outgoing exit() before the incoming enter(), two panels can never be on
// screen at once. main.ts calls select(ctx, null) the instant the carousel reopens, which
// tears the active panel down first.
import type { MenuModule, MenuId, SceneContext, HandPose } from "../types";

const COMMAND_COOLDOWN_MS = 250;

export class MenuRouter {
    private readonly registry = {} as Record<MenuId, MenuModule>;
    private active: MenuModule | null = null;
    private lastId: MenuId | null = null;
    private lastIdMs = 0;

    // Register a tool module. Last registration for a given id wins. Registering the module
    // that is currently active does not re-enter it; the live instance keeps running until
    // the next select().
    register(module: MenuModule): void {
        this.registry[module.id] = module;
    }

    get activeId(): MenuId | null {
        return this.active ? this.active.id : null;
    }

    // Switch the active tool. Exit-before-enter is the load-bearing invariant: the outgoing
    // module's exit() (which hides its panel) always runs before the incoming module's
    // enter() (which shows its panel), so a single panel is visible at any instant.
    //
    // - Passing the already-active id is a no-op (avoids a spurious exit/enter cycle that
    //   would rebuild affordances and re-trigger the panel slide animation).
    // - Passing null exits the current module and leaves none active.
    // - An unknown id (not registered) is treated like null: exit current, leave none
    //   active, rather than throwing — a stray selection must never crash the frame loop.
    select(ctx: SceneContext, id: MenuId | null): void {
        if (id !== null) {
            const now = performance.now();
            if (id === this.lastId && now - this.lastIdMs < COMMAND_COOLDOWN_MS) return;
            this.lastId = id;
            this.lastIdMs = now;
        }
        const next = id === null ? null : this.registry[id] ?? null;
        if (next === this.active) {
            // Already on the requested tool (or already idle for an unknown/null id):
            // resync ctx.activeMenu in case it drifted and return without churn.
            ctx.activeMenu = this.active ? this.active.id : null;
            return;
        }
        // Detach the outgoing module first, then clear `active` so that if enter() below
        // throws, the router is left in a clean idle state rather than pointing at a module
        // that never entered.
        const prev = this.active;
        this.active = null;
        ctx.activeMenu = null;
        if (prev) prev.exit(ctx);
        // Attach the incoming module.
        if (next) {
            this.active = next;
            ctx.activeMenu = next.id;
            next.enter(ctx);
        }
    }

    // Drive the active module for this frame. No-op when no tool is active (the world may be
    // empty and no panel open). `exec` is the execution hand (right by default, §3.2), `nav`
    // is the navigation hand (left); either may be null when a hand is missing or low
    // confidence. Only the active module updates — inactive modules hold no per-frame cost.
    update(ctx: SceneContext, exec: HandPose | null, nav: HandPose | null, dt: number): void {
        if (this.active) this.active.update(ctx, exec, nav, dt);
    }
}
