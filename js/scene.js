// Rendering: Three.js scene, lighting, ground shadow, the active mesh, and the
// display rig (a fixed tilt + an optional spin) used to show the donut off.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class SceneManager {
    constructor() {
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.setSize(innerWidth, innerHeight);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        renderer.domElement.id = 'webgl';
        document.body.appendChild(renderer.domElement);
        this.renderer = renderer;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
        camera.position.set(0, 0.4, 6.0);
        camera.lookAt(0, 0, 0);
        this.scene = scene;
        this.camera = camera;

        // soft studio lighting
        scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20242c, 0.55));
        const key = new THREE.DirectionalLight(0xffffff, 2.2);
        key.position.set(3, 5, 4);
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.near = 1;
        key.shadow.camera.far = 20;
        const d = 4;
        key.shadow.camera.left = -d;
        key.shadow.camera.right = d;
        key.shadow.camera.top = d;
        key.shadow.camera.bottom = -d;
        key.shadow.bias = -0.0005;
        key.shadow.camera.updateProjectionMatrix();
        scene.add(key);
        const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
        fill.position.set(-4, 1, 2);
        scene.add(fill);

        // subtle contact shadow on an otherwise invisible ground
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(40, 40),
            new THREE.ShadowMaterial({ opacity: 0.28 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -1.5;
        ground.receiveShadow = true;
        scene.add(ground);

        // the model: a smooth, donut-coloured sphere with enough segments that
        // booleans and smoothing stay clean
        const mat = new THREE.MeshStandardMaterial({ color: 0xcf9b63, roughness: 0.55, metalness: 0.0 });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        // outer group = fixed tilt (3/4 view); inner group = optional spin about
        // the donut's hole axis. Both are display-only; CSG works in mesh space.
        const tilt = new THREE.Group();
        tilt.rotation.x = -0.5;
        const spin = new THREE.Group();
        tilt.add(spin);
        spin.add(mesh);
        scene.add(tilt);
        this.mesh = mesh;
        this.spin = spin;

        // included for debugging only (toggle with "o"); off by default
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enabled = false;
        this.controls = controls;

        addEventListener('resize', () => {
            camera.aspect = innerWidth / innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(innerWidth, innerHeight);
        });
    }

    render(dt, spinning) {
        if (spinning) this.spin.rotation.y += dt * 0.6;
        if (this.controls.enabled) this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
