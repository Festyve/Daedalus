// §3.1 / §3.2 — the menu router: the single component that knows which menu module is
// active. It holds a Record<MenuId, MenuModule> registry (modules are registered by
// main.ts in P3; the router never imports them, preserving the module-boundary rule
// that feature modules talk only through SceneContext). On select() it exits the
// previously active module and enters the newly chosen one, updating ctx.activeMenu;
// each frame update() delegates to the active module's update().
import type { MenuModule, MenuId, SceneContext, HandPose } from "../types";

export class MenuRouter {
    private readonly registry = {} as Record<MenuId, MenuModule>;
    private active: MenuModule | null = null;

    register(module: MenuModule): void {
        this.registry[module.id] = module;
    }

    get activeId(): MenuId | null {
        return this.active ? this.active.id : null;
    }

    // Switch the active menu. Passing the already-active id is a no-op (avoids a
    // spurious exit/enter cycle that would rebuild affordances). Passing null exits the
    // current menu and leaves none active. Unknown ids (not registered) exit current
    // and leave none active rather than throwing, so a stray selection cannot crash the
    // frame loop.
    select(ctx: SceneContext, id: MenuId | null): void {
        const next = id === null ? null : this.registry[id] ?? null;
        if (next === this.active) {
            ctx.activeMenu = this.active ? this.active.id : null;
            return;
        }
        if (this.active) this.active.exit(ctx);
        this.active = next;
        if (this.active) this.active.enter(ctx);
        ctx.activeMenu = this.active ? this.active.id : null;
    }

    // Drive the active module for this frame. No-op when no menu is active.
    update(ctx: SceneContext, right: HandPose | null, left: HandPose | null, dt: number): void {
        if (this.active) this.active.update(ctx, right, left, dt);
    }
}
