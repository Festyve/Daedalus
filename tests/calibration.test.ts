import { describe, it, expect } from "vitest";
import {
    deriveProfileFromSamples,
    jitterToMinCutoff,
    velocityToBeta,
    sampleStdDev,
    profileToOneEuroParams,
    Calibration,
    type RitualSamples,
    type RitualFrame,
} from "../src/tracking/calibration";
import { DEFAULT_CALIBRATION } from "../src/types";

function samples(over: Partial<RitualSamples> = {}): RitualSamples {
    return {
        restPositions: [0, 0, 0, 0],
        restPinchFraction: 0.9,
        recordedPinchFraction: 0.2,
        depthSweep: [-0.1, 0.0, 0.2],
        peakVelocity: 2.0,
        handScaleMeters: 0.09,
        ...over,
    };
}

describe("deriveProfileFromSamples", () => {
    it("sets pinchClosed to 60% of the recorded pinch fraction", () => {
        const p = deriveProfileFromSamples(samples({ recordedPinchFraction: 0.2 }));
        expect(p.pinchClosed).toBeCloseTo(0.12, 6); // 0.6 * 0.2
    });
    it("carries the resting open fraction through to pinchOpen", () => {
        const p = deriveProfileFromSamples(samples({ restPinchFraction: 0.85 }));
        expect(p.pinchOpen).toBeCloseTo(0.85, 6);
    });
    it("derives depthNear/depthFar from the sweep extremes", () => {
        const p = deriveProfileFromSamples(samples({ depthSweep: [0.05, -0.2, 0.3, -0.05] }));
        expect(p.depthNear).toBeCloseTo(-0.2, 6);
        expect(p.depthFar).toBeCloseTo(0.3, 6);
    });
    it("stores resting jitter as the std-dev of the rest samples", () => {
        const p = deriveProfileFromSamples(samples({ restPositions: [1, 1, 1, 1, 3, 3, 3, 3] }));
        expect(p.restingJitter).toBeCloseTo(1.0, 6); // std-dev of [1..,3..]
    });
    it("passes peakVelocity and handScaleMeters straight through", () => {
        const p = deriveProfileFromSamples(samples({ peakVelocity: 3.5, handScaleMeters: 0.11 }));
        expect(p.peakVelocity).toBeCloseTo(3.5, 6);
        expect(p.handScaleMeters).toBeCloseTo(0.11, 6);
    });
    it("defaults responsiveness and handedness when omitted", () => {
        const p = deriveProfileFromSamples(samples());
        expect(p.responsiveness).toBe(DEFAULT_CALIBRATION.responsiveness);
        expect(p.handedness).toBe(DEFAULT_CALIBRATION.handedness);
    });
});

describe("one euro parameter mappings", () => {
    it("maps the baseline jitter to min_cutoff 1.0 (§0.6.4)", () => {
        expect(jitterToMinCutoff(0.0025)).toBeCloseTo(1.0, 6);
    });
    it("lowers min_cutoff (more smoothing) as jitter rises", () => {
        expect(jitterToMinCutoff(0.005)).toBeLessThan(jitterToMinCutoff(0.0025));
    });
    it("maps the baseline velocity to beta 0.007 (§0.6.4)", () => {
        expect(velocityToBeta(2.0)).toBeCloseTo(0.007, 6);
    });
    it("raises beta as peak velocity rises", () => {
        expect(velocityToBeta(4.0)).toBeGreaterThan(velocityToBeta(2.0));
    });
    it("computes std-dev of a constant stream as 0", () => {
        expect(sampleStdDev([7, 7, 7])).toBe(0);
    });
});

describe("Calibration ritual state machine", () => {
    function held(over: Partial<RitualFrame> = {}): RitualFrame {
        return {
            poseHeld: true,
            restValue: 0,
            pinchFraction: 0.9,
            depthZ: 0,
            velocity: 1,
            handScaleMeters: 0.09,
            ...over,
        };
    }

    it("starts at rest and is not done", () => {
        const c = new Calibration();
        expect(c.step).toBe("rest");
        expect(c.done).toBe(false);
    });

    it("walks rest -> pinch -> depth -> swipe -> done on held poses", () => {
        const c = new Calibration();
        const drive = (n: number, f: RitualFrame) => { for (let i = 0; i < n; i++) c.update(f); };
        drive(45, held({ restValue: 0 }));
        expect(c.step).toBe("pinch");
        drive(45, held({ pinchFraction: 0.2 }));
        expect(c.step).toBe("depth");
        drive(45, held({ depthZ: 0.25 }));
        expect(c.step).toBe("swipe");
        drive(45, held({ velocity: 3 }));
        expect(c.step).toBe("done");
        expect(c.done).toBe(true);
    });

    it("resets the hold counter when the pose is released", () => {
        const c = new Calibration();
        for (let i = 0; i < 30; i++) c.update(held());
        c.update(held({ poseHeld: false }));
        for (let i = 0; i < 30; i++) c.update(held());
        expect(c.step).toBe("rest"); // 30 < 45, never reached the threshold
    });

    it("produces a usable profile when the ritual finishes", () => {
        const c = new Calibration();
        const drive = (n: number, f: RitualFrame) => { for (let i = 0; i < n; i++) c.update(f); };
        drive(45, held({ restValue: 0 }));
        drive(45, held({ pinchFraction: 0.2 }));
        drive(45, held({ depthZ: 0.25 }));
        drive(45, held({ velocity: 3 }));
        expect(c.profile.pinchClosed).toBeCloseTo(0.12, 6); // 0.6 * 0.2 pinch
        expect(c.profile.peakVelocity).toBeCloseTo(3, 6);
    });

    it("skip() keeps the defaults and jumps to done", () => {
        const c = new Calibration();
        const p = c.skip();
        expect(c.done).toBe(true);
        expect(p).toEqual(DEFAULT_CALIBRATION);
    });
});

describe("setResponsiveness", () => {
    it("clamps the value into 0..1", () => {
        const c = new Calibration();
        c.setResponsiveness(5);
        expect(c.profile.responsiveness).toBe(1);
        c.setResponsiveness(-2);
        expect(c.profile.responsiveness).toBe(0);
    });
    it("retunes the supplied LandmarkFilter when responsiveness changes", () => {
        const calls: Array<{ minCutoff: number; beta: number }> = [];
        const fake = { setParams: (minCutoff: number, beta: number) => calls.push({ minCutoff, beta }) };
        const c = new Calibration(fake as unknown as import("../src/tracking/oneEuro").LandmarkFilter);
        c.setResponsiveness(1);
        expect(calls.length).toBe(1);
        expect(Number.isFinite(calls[0].minCutoff)).toBe(true);
        expect(Number.isFinite(calls[0].beta)).toBe(true);
    });
    it("higher responsiveness yields a higher min_cutoff (sharper) than lower", () => {
        const base = { ...DEFAULT_CALIBRATION, responsiveness: 0.5 };
        const sharp = profileToOneEuroParams({ ...base, responsiveness: 1 });
        const smooth = profileToOneEuroParams({ ...base, responsiveness: 0 });
        expect(sharp.minCutoff).toBeGreaterThan(smooth.minCutoff);
    });
});
