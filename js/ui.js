// UI: the status panel, the dismissible instructions, and the error/hint banner.
export class UI {
    constructor() {
        this.elLeft = document.getElementById('g-left');
        this.elRight = document.getElementById('g-right');
        this.elClutch = document.getElementById('g-clutch');
        this.elStage = document.getElementById('g-stage');
        this.banner = document.getElementById('banner');
        this.instructions = document.getElementById('instructions');

        const dismiss = document.getElementById('dismiss');
        if (dismiss) dismiss.onclick = () => this.instructions.classList.add('hidden');
    }

    update(s) {
        this.elLeft.textContent = s.left;
        this.elRight.textContent = s.right;
        this.elClutch.textContent = s.clutch ? 'ENGAGED' : 'off';
        this.elClutch.className = s.clutch ? 'on' : '';
        this.elStage.textContent = s.stage;
    }

    toggleInstructions() {
        this.instructions.classList.toggle('hidden');
    }

    showBanner(msg) {
        this.banner.textContent = msg;
        this.banner.classList.remove('hidden');
    }

    hideBanner() {
        this.banner.classList.add('hidden');
    }
}
