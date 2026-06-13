const TWO_PI = Math.PI * 2;
function alpha(cutoff: number, dt: number): number {
    const tau = 1 / (TWO_PI * cutoff);
    return 1 / (1 + tau / dt);
}
class LowPass {
    private has_prev = false;
    private prev = 0;
    filter(x: number, a: number): number {
        if (!this.has_prev) { this.has_prev = true; this.prev = x; return x; }
        const r = a * x + (1 - a) * this.prev;
        this.prev = r;
        return r;
    }
    reset(): void { this.has_prev = false; }
}

export class OneEuro {
    private x_lp = new LowPass();
    private dx_lp = new LowPass();
    private x_prev = 0;
    private has_prev = false;
    constructor(public minCutoff = 1.0, public beta = 0.007, public dCutoff = 1.0) {}
    filter(x: number, dt: number): number {
        const dx = this.has_prev ? (x - this.x_prev) / dt : 0;
        const edx = this.dx_lp.filter(dx, alpha(this.dCutoff, dt));
        const cutoff = this.minCutoff + this.beta * Math.abs(edx);
        const r = this.x_lp.filter(x, alpha(cutoff, dt));
        this.x_prev = x; this.has_prev = true;
        return r;
    }
    reset(): void { this.x_lp.reset(); this.dx_lp.reset(); this.has_prev = false; }
}

// 21 landmarks x 3 axes per hand; params read from calibration.
export class LandmarkFilter {
    private fx: OneEuro[] = []; private fy: OneEuro[] = []; private fz: OneEuro[] = [];
    constructor(minCutoff: number, beta: number) {
        for (let i = 0; i < 21; i++) {
            this.fx.push(new OneEuro(minCutoff, beta));
            this.fy.push(new OneEuro(minCutoff, beta));
            this.fz.push(new OneEuro(minCutoff, beta));
        }
    }
    setParams(minCutoff: number, beta: number): void {
        for (let i = 0; i < 21; i++) {
            this.fx[i].minCutoff = this.fy[i].minCutoff = this.fz[i].minCutoff = minCutoff;
            this.fx[i].beta = this.fy[i].beta = this.fz[i].beta = beta;
        }
    }
    apply(lm: { x: number; y: number; z: number }[], dt: number): { x: number; y: number; z: number }[] {
        const out = new Array(21);
        for (let i = 0; i < 21; i++) {
            out[i] = { x: this.fx[i].filter(lm[i].x, dt), y: this.fy[i].filter(lm[i].y, dt), z: this.fz[i].filter(lm[i].z, dt) };
        }
        return out;
    }
    reset(): void { for (let i = 0; i < 21; i++) { this.fx[i].reset(); this.fy[i].reset(); this.fz[i].reset(); } }
}
